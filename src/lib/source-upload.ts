import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './env';
import {
  blobKey,
  ensureProjectDirs,
  getFilesBucket,
  joinStoragePath,
} from './storage';
import { storagePoolConfigured } from './storage-providers';
import {
  abortMultipartStorageObject,
  cleanupSupersededSource,
  completeMultipartStorageObject,
  startMultipartStorageObject,
  storageObjectPath,
  uploadMultipartPart,
} from './storage-pool';
import { mimeForExtension, validateUploadCandidate } from './upload';
import { MAX_SOURCE_BYTES } from './upload-limits';

const PART_SIZE = 8 * 1024 * 1024;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
/**
 * The optional server-side source copy shares the 1 GB policy ceiling. The
 * normal path never calls this upload API: it keeps the File in the browser and
 * mounts it into FFmpeg.wasm, so this is only for an explicitly requested copy.
 */
export const MAX_BROWSER_SOURCE_BYTES = MAX_SOURCE_BYTES;

interface MultipartUpload {
  uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
  abort(): Promise<void>;
}

interface BucketWithMultipart {
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): Promise<MultipartUpload>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string | string[]): Promise<void>;
}

export interface StartedSourceUpload {
  mode: 's3' | 'r2' | 'local';
  uploadId: string;
  partSize: number;
  totalParts: number;
  providerId?: string;
}

function uploadTempDir(uploadId: string): string {
  return path.join(config().dataDir, 'uploads', uploadId);
}

async function localMeta(uploadId: string): Promise<{ projectId: string; destination: string } | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(uploadTempDir(uploadId), 'meta.json'), 'utf8')) as {
      projectId: string;
      destination: string;
    };
  } catch {
    return null;
  }
}

/** Remove abandoned local multipart staging without touching active sessions. */
async function cleanupStaleLocalUploads(): Promise<void> {
  const root = path.join(config().dataDir, 'uploads');
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_UPLOAD_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(root, entry.name);
        try {
          const stat = await fsp.stat(dir);
          if (stat.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true });
        } catch {
          // Another request may have completed or removed it first.
        }
      }),
  );
}

export async function startSourceUpload(
  projectId: string,
  ownerId: string,
  fileName: string,
  size: number,
): Promise<StartedSourceUpload> {
  const validation = validateUploadCandidate(fileName, size);
  if (!validation.ok || !validation.extension) {
    throw new Error(validation.error?.message ?? 'Invalid upload.');
  }
  if (size > MAX_BROWSER_SOURCE_BYTES) {
    throw new Error(
      `The source limit is 1 GB. This file is ${(size / 1024 / 1024).toFixed(0)} MB; compress or trim it first.`,
    );
  }
  await cleanupStaleLocalUploads();
  const totalParts = Math.ceil(size / PART_SIZE);

  if (storagePoolConfigured()) {
    // A replacement is uploaded at a new key and only becomes the project
    // source after its multipart assembly and HEAD size check pass. The old
    // source object is deleted later by cleanupSupersededSource.
    const version = randomUUID().slice(0, 8);
    const key = `projects/${projectId}/source/input-${version}${validation.extension}`;
    const started = await startMultipartStorageObject({
      ownerId,
      projectId,
      kind: 'source',
      assetKey: `source:${projectId}:${validation.extension}:${version}`,
      key,
      contentType: mimeForExtension(validation.extension),
      expectedBytes: size,
      partSize: PART_SIZE,
      totalParts,
    });
    return {
      mode: 's3',
      uploadId: started.uploadId,
      partSize: PART_SIZE,
      totalParts,
      providerId: started.providerId,
    };
  }

  const dirs = await ensureProjectDirs(projectId);
  const destination = joinStoragePath(dirs.source, `input${validation.extension}`);
  const bucket = (await getFilesBucket()) as BucketWithMultipart | null;

  if (bucket && destination.startsWith('r2://')) {
    const upload = await bucket.createMultipartUpload(blobKey(destination), {
      httpMetadata: { contentType: mimeForExtension(validation.extension) },
    });
    return { mode: 'r2', uploadId: upload.uploadId, partSize: PART_SIZE, totalParts };
  }

  const uploadId = randomUUID();
  const dir = uploadTempDir(uploadId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ projectId, destination }), 'utf8');
  return { mode: 'local', uploadId, partSize: PART_SIZE, totalParts };
}

export async function uploadSourcePart(
  projectId: string,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer,
): Promise<{ partNumber: number; etag: string }> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new Error('Invalid upload part number.');
  }
  if (body.byteLength === 0 || body.byteLength > PART_SIZE + 1024) {
    throw new Error('Invalid upload part size.');
  }
  const db = await import('./db');
  const pooled = await db.getStorageObjectByUploadId(projectId, uploadId);
  if (pooled) return uploadMultipartPart(projectId, uploadId, partNumber, body);

  const dirs = await ensureProjectDirs(projectId);
  const bucket = (await getFilesBucket()) as BucketWithMultipart | null;
  if (bucket) {
    const project = await db.getProject(projectId);
    const extension = project?.sourceFileName?.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? '.mp4';
    const upload = await bucket.resumeMultipartUpload(`projects/${projectId}/source/input${extension}`, uploadId);
    const part = await upload.uploadPart(partNumber, body);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  const meta = await localMeta(uploadId);
  if (!meta || meta.projectId !== projectId) throw new Error('Upload session not found.');
  await fsp.mkdir(uploadTempDir(uploadId), { recursive: true });
  await fsp.writeFile(path.join(uploadTempDir(uploadId), `part-${partNumber}`), Buffer.from(body));
  return { partNumber, etag: `local-${partNumber}` };
}

export async function completeSourceUpload(
  projectId: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<{ bytes: number; destination: string }> {
  const sorted = parts
    .map((part) => ({ partNumber: Number(part.partNumber), etag: String(part.etag) }))
    .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0)
    .sort((a, b) => a.partNumber - b.partNumber);
  if (sorted.length === 0) throw new Error('No uploaded parts were supplied.');

  const db = await import('./db');
  const project = await db.getProject(projectId);
  if (!project) throw new Error('Project not found.');
  const persisted = await db.getStorageObjectByUploadId(projectId, uploadId);
  if (persisted) {
    const completed = await completeMultipartStorageObject(projectId, uploadId, sorted);
    const destination = storageObjectPath(completed.record);
    await db.updateProject(projectId, {
      sourcePath: destination,
      sourceBytes: completed.record.bytes,
      sourceMime: completed.record.contentType ?? mimeForExtension(`.${destination.split('.').pop() ?? 'mp4'}`),
      status: 'ready',
      stage: 'queued',
      progress: 0,
      error: null,
      statusDetail: null,
    });
    await cleanupSupersededSource(projectId, completed.record.id);
    return { bytes: completed.record.bytes, destination };
  }

  const bucket = (await getFilesBucket()) as BucketWithMultipart | null;
  const extension = project.sourceFileName?.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? '.mp4';
  const dirs = await ensureProjectDirs(projectId);
  const destination = joinStoragePath(dirs.source, `input${extension}`);

  if (bucket) {
    const key = blobKey(destination);
    const upload = await bucket.resumeMultipartUpload(key, uploadId);
    await upload.complete(sorted);
    const head = await bucket.head(key);
    if (!head || head.size === 0) throw new Error('R2 did not receive a complete source file.');
    await db.updateProject(projectId, {
      sourcePath: destination,
      sourceBytes: head.size,
      sourceMime: mimeForExtension(extension),
      status: 'ready',
      stage: 'queued',
      progress: 0,
      error: null,
      statusDetail: null,
    });
    return { bytes: head.size, destination };
  }

  const meta = await localMeta(uploadId);
  if (!meta || meta.projectId !== projectId) throw new Error('Upload session not found.');
  const target = meta.destination;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const handle = await fsp.open(target, 'w');
  let written = 0;
  try {
    for (const part of sorted) {
      const chunk = await fsp.readFile(path.join(uploadTempDir(uploadId), `part-${part.partNumber}`));
      await handle.write(chunk);
      written += chunk.byteLength;
    }
  } finally {
    await handle.close();
  }
  await fsp.rm(uploadTempDir(uploadId), { recursive: true, force: true });
  if (written === 0) throw new Error('The completed upload is empty.');
  await db.updateProject(projectId, {
    sourcePath: target,
    sourceBytes: written,
    sourceMime: mimeForExtension(extension),
    status: 'ready',
    stage: 'queued',
    progress: 0,
    error: null,
    statusDetail: null,
  });
  return { bytes: written, destination: target };
}

/** Release an explicitly abandoned multipart session and its temporary bytes. */
export async function abortSourceUpload(projectId: string, uploadId: string): Promise<void> {
  const db = await import('./db');
  if (await db.getStorageObjectByUploadId(projectId, uploadId)) {
    await abortMultipartStorageObject(projectId, uploadId);
    return;
  }

  const bucket = (await getFilesBucket()) as BucketWithMultipart | null;
  if (bucket) {
    const project = await db.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    const extension = project.sourceFileName?.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? '.mp4';
    const upload = await bucket.resumeMultipartUpload(`projects/${projectId}/source/input${extension}`, uploadId);
    await upload.abort();
    return;
  }

  const meta = await localMeta(uploadId);
  if (!meta || meta.projectId !== projectId) throw new Error('Upload session not found.');
  await fsp.rm(uploadTempDir(uploadId), { recursive: true, force: true });
}

