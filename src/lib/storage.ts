import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './env';
import { s3DeleteObject, s3GetObject, s3HeadObject } from './s3-client';
import {
  isProviderObjectPath,
  parseProviderObjectPath,
  providerById,
  storagePoolConfigured,
} from './storage-providers';
import { deletePoolProjectObjects, getPoolStorageUsage } from './storage-pool';
import type {
  FailedFileDeletion,
  ProjectFileDeletion,
  StorageProjectUsage,
  StorageUsage,
} from './storage-types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOB_PREFIX = 'r2://';

/** The Freebuff-managed production R2 allowance. Override for another plan. */
export const DEFAULT_R2_STORAGE_LIMIT_BYTES = 1_000_000_000;

export function storageLimitBytes(): number {
  const configured = Number(process.env.AC_R2_STORAGE_LIMIT_BYTES);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return DEFAULT_R2_STORAGE_LIMIT_BYTES;
}

interface R2ObjectBody {
  size: number;
  body: ReadableStream<Uint8Array>;
}

interface R2ListedObject {
  key: string;
  size: number;
}

interface R2ObjectList {
  objects: R2ListedObject[];
  truncated?: boolean;
  cursor?: string;
}

interface R2MultipartUpload {
  uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
  abort(): Promise<void>;
}

/** Minimal R2 surface used by this app. Exported so deletion can be unit-tested. */
export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<R2ObjectList>;
  createMultipartUpload(
    key: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): Promise<R2MultipartUpload>;
}

async function filesBinding(): Promise<R2Bucket | null> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const env = getCloudflareContext().env as { FILES?: R2Bucket };
    return env.FILES ?? null;
  } catch (error) {
    // Local development has no R2 context and intentionally uses AC_DATA_DIR.
    // A production Worker with no binding is a deployment error: never fall
    // back to a local path there, because deleting D1 while leaving R2 behind
    // would be worse than refusing the request.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`R2 FILES binding unavailable: ${errorMessage(error)}`);
    }
    return null;
  }
}

export function isBlobKey(target: string): boolean {
  return target.startsWith(BLOB_PREFIX);
}

/** Reads may come from the legacy R2 binding, local disk, or an S3 provider. */
export function isRemoteObjectPath(target: string): boolean {
  return isBlobKey(target) || isProviderObjectPath(target);
}

function s3ForPath(target: string) {
  const parsed = parseProviderObjectPath(target);
  if (!parsed) throw new Error('Invalid S3 object path.');
  const provider = providerById(parsed.providerId);
  if (!provider) throw new Error(`${parsed.providerId} storage is not configured.`);
  return {
    provider,
    key: parsed.key,
    config: {
      endpoint: provider.endpoint,
      region: provider.region,
      bucket: provider.bucket,
      accessKeyId: provider.accessKeyId,
      secretAccessKey: provider.secretAccessKey,
      sessionToken: provider.sessionToken,
      forcePathStyle: provider.forcePathStyle,
    },
  };
}

export function blobKey(target: string): string {
  return target.slice(BLOB_PREFIX.length);
}

export async function getFilesBucket(): Promise<R2Bucket | null> {
  return filesBinding();
}

function projectBlobBase(id: string): string {
  return `${BLOB_PREFIX}projects/${id}`;
}

/** Guards every filesystem path derived from a user-supplied id. */
export function assertSafeId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('Invalid project id');
  return id;
}

export function projectDirs(id: string) {
  assertSafeId(id);
  const base = path.join(config().dataDir, 'projects', id);
  return {
    base,
    source: path.join(base, 'source'),
    work: path.join(base, 'work'),
    clips: path.join(base, 'clips'),
  };
}

export async function ensureProjectDirs(id: string): Promise<ReturnType<typeof projectDirs>> {
  assertSafeId(id);
  if (await filesBinding()) {
    const base = projectBlobBase(id);
    return {
      base,
      source: `${base}/source`,
      work: `${base}/work`,
      clips: `${base}/clips`,
    };
  }
  const dirs = projectDirs(id);
  await Promise.all([
    fsp.mkdir(dirs.source, { recursive: true }),
    fsp.mkdir(dirs.work, { recursive: true }),
    fsp.mkdir(dirs.clips, { recursive: true }),
  ]);
  return dirs;
}

/** Joins a local directory or an R2 prefix without normalising the r2:// scheme. */
export function joinStoragePath(base: string, name: string): string {
  if (isBlobKey(base)) return `${base.replace(/\/+$/, '')}/${name}`;
  return path.join(base, name);
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<R2ListedObject[]> {
  const objects: R2ListedObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const result = await bucket.list(cursor ? { prefix, cursor } : { prefix });
    objects.push(...result.objects);
    if (!result.truncated) return objects;
    if (!result.cursor) throw new Error('R2 returned a truncated listing without a cursor.');
    cursor = result.cursor;
  }
  throw new Error('R2 listing exceeded the safe page limit.');
}

interface ProjectFile {
  relativePath: string;
  bytes: number;
}

function toDisplayPath(value: string): string {
  return value.split(path.sep).join('/');
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function walkFiles(root: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full);
        files.push({
          relativePath: toDisplayPath(path.relative(root, full)),
          bytes: stat.size,
        });
      }
    }
  }
  await visit(root);
  return files;
}

async function cleanupLocalUploadStaging(projectId: string): Promise<FailedFileDeletion[]> {
  const root = path.join(config().dataDir, 'uploads');
  const failed: FailedFileDeletion[] = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failed;
    return [{ path: 'uploads/', error: errorMessage(error) }];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')) as {
        projectId?: unknown;
      };
      if (meta.projectId !== projectId) continue;
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.access(dir);
      failed.push({ path: `uploads/${entry.name}`, error: 'Still present after deletion.' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failed.push({ path: `uploads/${entry.name}`, error: errorMessage(error) });
    }
  }
  return failed;
}

function summarizeUsage(
  backend: StorageUsage['backend'],
  projectIds: string[],
  files: { projectId: string; relativePath: string; bytes: number }[],
  limitBytes: number,
): StorageUsage {
  const byProject = new Map<string, StorageProjectUsage>();
  for (const projectId of projectIds) {
    byProject.set(projectId, {
      projectId,
      usedBytes: 0,
      sourceBytes: 0,
      clipBytes: 0,
      fileCount: 0,
    });
  }

  let usedBytes = 0;
  let sourceBytes = 0;
  let clipBytes = 0;
  for (const file of files) {
    const usage = byProject.get(file.projectId);
    if (!usage) continue;
    usedBytes += file.bytes;
    usage.usedBytes += file.bytes;
    usage.fileCount += 1;
    if (file.relativePath.startsWith('source/')) {
      sourceBytes += file.bytes;
      usage.sourceBytes += file.bytes;
    } else if (file.relativePath.startsWith('clips/')) {
      clipBytes += file.bytes;
      usage.clipBytes += file.bytes;
    }
  }

  return {
    available: true,
    backend,
    usedBytes,
    availableBytes: Math.max(0, limitBytes - usedBytes),
    limitBytes,
    sourceBytes,
    clipBytes,
    fileCount: files.length,
    projects: projectIds.map((id) => byProject.get(id) as StorageProjectUsage),
    error: null,
    measuredAt: new Date().toISOString(),
    providers: [],
    configuredCapacityBytes: limitBytes,
    verifiedCapacityBytes: limitBytes,
    unverifiedCapacityBytes: 0,
    totalUsedBytes: usedBytes,
    totalAvailableBytes: Math.max(0, limitBytes - usedBytes),
    reservedBytes: 0,
    pendingUploads: 0,
    failedUploads: 0,
    failedDeletions: 0,
    lastSuccessfulMeasurement: new Date().toISOString(),
    targetVerified: true,
  };
}

function unavailableUsage(
  backend: StorageUsage['backend'],
  projectIds: string[],
  limitBytes: number,
  error: string,
): StorageUsage {
  return {
    available: false,
    backend,
    usedBytes: 0,
    availableBytes: 0,
    limitBytes,
    sourceBytes: 0,
    clipBytes: 0,
    fileCount: 0,
    projects: projectIds.map((projectId) => ({
      projectId,
      usedBytes: 0,
      sourceBytes: 0,
      clipBytes: 0,
      fileCount: 0,
    })),
    error,
    measuredAt: new Date().toISOString(),
    providers: [],
    configuredCapacityBytes: limitBytes,
    verifiedCapacityBytes: 0,
    unverifiedCapacityBytes: limitBytes,
    totalUsedBytes: 0,
    totalAvailableBytes: 0,
    reservedBytes: 0,
    pendingUploads: 0,
    failedUploads: 0,
    failedDeletions: 0,
    lastSuccessfulMeasurement: null,
    targetVerified: false,
  };
}

/**
 * Reads actual stored object metadata for the supplied projects. R2 is listed
 * once and filtered to the caller's project ids; local development walks only
 * those same project directories. It never reports a fabricated zero when the
 * backend cannot be read.
 */
export async function getStorageUsage(
  projectIds: string[],
  options: { force?: boolean } = {},
): Promise<StorageUsage> {
  const ids = [...new Set(projectIds.filter((id) => UUID_RE.test(id)))];
  if (storagePoolConfigured()) return getPoolStorageUsage(ids, options);
  const limitBytes = storageLimitBytes();
  let bucket: R2Bucket | null;
  try {
    bucket = await filesBinding();
  } catch (error) {
    return unavailableUsage('r2', ids, limitBytes, `R2 is unavailable: ${errorMessage(error)}`);
  }

  if (bucket) {
    try {
      const prefix = 'projects/';
      const objects = await listAllObjects(bucket, prefix);
      const allowed = new Set(ids);
      const files: { projectId: string; relativePath: string; bytes: number }[] = [];
      for (const object of objects) {
        if (!object.key.startsWith(prefix)) continue;
        const parts = object.key.slice(prefix.length).split('/');
        const projectId = parts[0];
        if (!allowed.has(projectId) || parts.length < 2) continue;
        files.push({
          projectId,
          relativePath: parts.slice(1).join('/'),
          bytes: Number(object.size) || 0,
        });
      }
      return summarizeUsage('r2', ids, files, limitBytes);
    } catch (error) {
      return unavailableUsage('r2', ids, limitBytes, `R2 listing failed: ${errorMessage(error)}`);
    }
  }

  try {
    const files: { projectId: string; relativePath: string; bytes: number }[] = [];
    for (const projectId of ids) {
      const localFiles = await walkFiles(projectDirs(projectId).base);
      for (const file of localFiles) {
        files.push({ projectId, relativePath: file.relativePath, bytes: file.bytes });
      }
    }
    return summarizeUsage('local', ids, files, limitBytes);
  } catch (error) {
    return unavailableUsage('local', ids, limitBytes, `Local storage scan failed: ${errorMessage(error)}`);
  }
}

/**
 * Deletes one project's complete key prefix. It deliberately deletes object by
 * object so a failure can name the file, then lists the prefix again. D1 rows
 * must only be removed when `verified` is true.
 */
export async function deleteProjectFiles(
  id: string,
  bucketOverride?: R2Bucket | null,
): Promise<ProjectFileDeletion> {
  assertSafeId(id);
  const bucket = bucketOverride === undefined ? await filesBinding() : bucketOverride;
  const legacy = bucket ? await deleteR2ProjectFiles(bucket, id) : await deleteLocalProjectFiles(id);
  // The injected-bucket test path is legacy-only and intentionally does not
  // need a database/provider pool.
  if (bucketOverride !== undefined) return legacy;

  const pooled = await deletePoolProjectObjects(id);
  const verified = legacy.verified && pooled.verified;
  return {
    verified,
    deletedFiles: legacy.deletedFiles + pooled.deletedFiles,
    failedFiles: [...legacy.failedFiles, ...pooled.failedFiles],
    bytesFreed: verified ? legacy.bytesFreed + pooled.bytesFreed : 0,
    bytesRemaining: legacy.bytesRemaining + pooled.bytesRemaining,
  };
}

async function deleteR2ProjectFiles(bucket: R2Bucket, id: string): Promise<ProjectFileDeletion> {
  const prefix = `projects/${id}/`;
  let initial: R2ListedObject[];
  try {
    initial = await listAllObjects(bucket, prefix);
  } catch (error) {
    return {
      verified: false,
      deletedFiles: 0,
      failedFiles: [{ path: prefix, error: `Could not list project files: ${errorMessage(error)}` }],
      bytesFreed: 0,
      bytesRemaining: 0,
    };
  }

  if (initial.length === 0) {
    return { verified: true, deletedFiles: 0, failedFiles: [], bytesFreed: 0, bytesRemaining: 0 };
  }

  const deleteErrors = new Map<string, string>();
  for (const object of initial) {
    try {
      await bucket.delete(object.key);
    } catch (error) {
      deleteErrors.set(object.key, errorMessage(error));
    }
  }

  let remaining: R2ListedObject[];
  try {
    remaining = await listAllObjects(bucket, prefix);
  } catch (error) {
    return {
      verified: false,
      deletedFiles: 0,
      failedFiles: [
        { path: prefix, error: `Deleted files, but R2 confirmation failed: ${errorMessage(error)}` },
      ],
      bytesFreed: 0,
      bytesRemaining: 0,
    };
  }

  const remainingByKey = new Map(remaining.map((object) => [object.key, object]));
  const failed: FailedFileDeletion[] = [];
  for (const object of initial) {
    const stillThere = remainingByKey.get(object.key);
    if (stillThere) {
      failed.push({
        path: object.key.slice(prefix.length),
        error: deleteErrors.get(object.key) ?? 'Still present after R2 deletion.',
      });
    }
  }
  for (const object of remaining) {
    if (!initial.some((entry) => entry.key === object.key)) {
      failed.push({
        path: object.key.slice(prefix.length),
        error: deleteErrors.get(object.key) ?? 'Still present after R2 deletion.',
      });
    }
  }

  const verified = remaining.length === 0;
  return {
    verified,
    deletedFiles: Math.max(0, initial.length - remaining.length),
    failedFiles: failed,
    bytesFreed: verified ? initial.reduce((total, object) => total + (Number(object.size) || 0), 0) : 0,
    bytesRemaining: remaining.reduce((total, object) => total + (Number(object.size) || 0), 0),
  };
}

async function deleteLocalProjectFiles(id: string): Promise<ProjectFileDeletion> {
  const dirs = projectDirs(id);
  let initial: ProjectFile[];
  try {
    initial = await walkFiles(dirs.base);
  } catch (error) {
    return {
      verified: false,
      deletedFiles: 0,
      failedFiles: [{ path: 'projects/' + id + '/', error: errorMessage(error) }],
      bytesFreed: 0,
      bytesRemaining: 0,
    };
  }

  let removeError: string | null = null;
  try {
    await fsp.rm(dirs.base, { recursive: true, force: true });
  } catch (error) {
    removeError = errorMessage(error);
  }

  let remaining: ProjectFile[];
  try {
    remaining = await walkFiles(dirs.base);
  } catch (error) {
    return {
      verified: false,
      deletedFiles: 0,
      failedFiles: [{ path: 'projects/' + id + '/', error: `Could not verify local deletion: ${errorMessage(error)}` }],
      bytesFreed: 0,
      bytesRemaining: 0,
    };
  }

  const stagingFailures = await cleanupLocalUploadStaging(id);
  const failed: FailedFileDeletion[] = stagingFailures.slice();
  for (const file of remaining) {
    failed.push({ path: file.relativePath, error: removeError ?? 'Still present after deletion.' });
  }
  if (removeError && remaining.length === 0) {
    failed.push({ path: 'projects/' + id + '/', error: removeError });
  }

  const verified = remaining.length === 0 && stagingFailures.length === 0;
  return {
    verified,
    deletedFiles: Math.max(0, initial.length - remaining.length),
    failedFiles: failed,
    bytesFreed: verified ? initial.reduce((total, file) => total + file.bytes, 0) : 0,
    bytesRemaining: remaining.reduce((total, file) => total + file.bytes, 0),
  };
}

/**
 * Streams a request body into R2 or to disk while enforcing a hard byte limit.
 * The partial object/file is removed when the limit is hit or the transfer
 * aborts, so a truncated upload can never be mistaken for a complete source.
 */
export async function writeUploadStream(
  body: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number,
  expectedBytes: number | null = null,
): Promise<number> {
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        callback(new Error('UPLOAD_TOO_LARGE'));
        return;
      }
      callback(null, chunk);
    },
  });

  const files = await filesBinding();
  if (files && isBlobKey(destPath)) {
    const key = blobKey(destPath);
    if (expectedBytes !== null && expectedBytes > maxBytes) {
      throw new Error('UPLOAD_TOO_LARGE');
    }
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          controller.error(new Error('UPLOAD_TOO_LARGE'));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const counted = body.pipeThrough(counter);

    try {
      if (expectedBytes !== null && expectedBytes >= 0) {
        const FixedLengthStream = (
          globalThis as unknown as {
            FixedLengthStream?: new (length: number) => {
              readable: ReadableStream<Uint8Array>;
              writable: WritableStream<Uint8Array>;
            };
          }
        ).FixedLengthStream;
        if (FixedLengthStream) {
          const fixed = new FixedLengthStream(expectedBytes);
          const pump = counted.pipeTo(fixed.writable);
          await Promise.all([
            files.put(key, fixed.readable, { httpMetadata: { contentType: contentTypeFor(destPath) } }),
            pump,
          ]);
          return expectedBytes;
        }
      }
      // The browser normally sends a length. If it does not, buffer only up to
      // the configured limit so R2 still gets a fixed-size object.
      const buffered = await new Response(counted).arrayBuffer();
      if (buffered.byteLength > maxBytes) throw new Error('UPLOAD_TOO_LARGE');
      await files.put(key, buffered, { httpMetadata: { contentType: contentTypeFor(destPath) } });
      return buffered.byteLength;
    } catch (error) {
      await files.delete(key).catch(() => undefined);
      throw error;
    }
  }

  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      fs.createWriteStream(destPath, { flags: 'wx' }),
    );
  } catch (error) {
    await fsp.rm(destPath, { force: true });
    throw error;
  }
  return received;
}

export async function pathExists(target: string): Promise<boolean> {
  if (isProviderObjectPath(target)) {
    try {
      const { config: s3Config, key } = s3ForPath(target);
      return Boolean(await s3HeadObject(s3Config, key));
    } catch {
      return false;
    }
  }
  const files = await filesBinding();
  if (files && isBlobKey(target)) {
    return Boolean(await files.head(blobKey(target)));
  }
  try {
    await fsp.access(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(target: string): Promise<number | null> {
  if (isProviderObjectPath(target)) {
    // A provider HEAD can fail because of quota, auth or a transient outage.
    // Those are not proof that the object is missing; let the route report a
    // storage failure instead of manufacturing a 404.
    const { config: s3Config, key } = s3ForPath(target);
    const head = await s3HeadObject(s3Config, key);
    return head ? head.size : null;
  }
  const files = await filesBinding();
  if (files && isBlobKey(target)) {
    const object = await files.head(blobKey(target));
    return object ? object.size : null;
  }
  try {
    const stat = await fsp.stat(target);
    return stat.size;
  } catch {
    return null;
  }
}

export async function deleteStoragePath(target: string): Promise<void> {
  if (isProviderObjectPath(target)) {
    const { config: s3Config, key } = s3ForPath(target);
    await s3DeleteObject(s3Config, key);
    return;
  }
  const files = await filesBinding();
  if (files && isBlobKey(target)) {
    await files.delete(blobKey(target));
    return;
  }
  await fsp.rm(target, { force: true });
}

export async function getBlob(
  target: string,
  range?: { offset: number; length: number },
): Promise<R2ObjectBody | null> {
  if (isProviderObjectPath(target)) {
    const { config: s3Config, key } = s3ForPath(target);
    const object = await s3GetObject(s3Config, key, range);
    return object ? { size: object.size, body: object.body } : null;
  }
  const files = await filesBinding();
  if (!files || !isBlobKey(target)) return null;
  return files.get(blobKey(target), range ? { range } : undefined);
}

export function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

export function safeDownloadName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'download';
}
