import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as db from '../src/lib/db';
import { closeDb, getDb } from '../src/lib/db-sqlite';
import {
  cleanupExpiredStorageUploads,
  completeMultipartStorageObject,
  resetStorageMeasurementCache,
  StoragePoolCapacityError,
  startMultipartStorageObject,
  storageObjectPath,
  uploadMultipartPart,
  uploadStorageObject,
  verifyStorageObject,
} from '../src/lib/storage-pool';
import { deleteProjectFiles, getBlob, getStorageUsage, pathExists } from '../src/lib/storage';
import { fileResponse } from '../src/lib/http';
import { appendStorageFile } from '../src/lib/zip-storage';
import { createMockS3, type MockS3 } from './support/mock-s3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-pool-'));
let mock!: MockS3;
const OWNER = 'pool-owner';

test.before(async () => {
  mock = await createMockS3();
  process.env.AC_DATA_DIR = dataDir;
  process.env.AC_STORAGE_TARGET_BYTES = '2700';
  process.env.AC_B2_ENDPOINT = mock.endpoint;
  process.env.AC_B2_REGION = 'test-region';
  process.env.AC_B2_BUCKET = 'test-b2';
  process.env.AC_B2_ACCESS_KEY_ID = 'test-access';
  process.env.AC_B2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.AC_B2_LIMIT_BYTES = '1000';
  process.env.AC_B2_RESERVE_BYTES = '100';
  process.env.AC_TIGRIS_ENDPOINT = mock.endpoint;
  process.env.AC_TIGRIS_REGION = 'test-region';
  process.env.AC_TIGRIS_BUCKET = 'test-tigris';
  process.env.AC_TIGRIS_ACCESS_KEY_ID = 'test-access';
  process.env.AC_TIGRIS_SECRET_ACCESS_KEY = 'test-secret';
  process.env.AC_TIGRIS_LIMIT_BYTES = '1000';
  process.env.AC_TIGRIS_RESERVE_BYTES = '100';
  process.env.AC_FILEBASE_ENDPOINT = mock.endpoint;
  process.env.AC_FILEBASE_REGION = 'test-region';
  process.env.AC_FILEBASE_BUCKET = 'test-filebase';
  process.env.AC_FILEBASE_ACCESS_KEY_ID = 'test-access';
  process.env.AC_FILEBASE_SECRET_ACCESS_KEY = 'test-secret';
  process.env.AC_FILEBASE_LIMIT_BYTES = '1000';
  process.env.AC_FILEBASE_RESERVE_BYTES = '100';
  closeDb();
  db.upsertUser({ id: OWNER, email: 'pool@example.test', name: 'Pool', picture: null });
});

function projectObjectKey(projectId: string): string {
  return `projects/${projectId}/clips/${randomUUID()}.mp4`;
}

function newProject(title: string): { id: string; key: string } {
  const id = randomUUID();
  db.createProject({ id, ownerId: OWNER, title, sourceKind: 'upload' });
  return { id, key: projectObjectKey(id) };
}

function bodyOf(size: number): ReadableStream<Uint8Array> {
  return new Response(new Uint8Array(size).fill(7)).body as ReadableStream<Uint8Array>;
}

async function putAsset(
  projectId: string,
  key: string,
  size: number,
  assetSuffix: string = randomUUID(),
): Promise<Awaited<ReturnType<typeof uploadStorageObject>>> {
  return uploadStorageObject({
    ownerId: OWNER,
    projectId,
    kind: 'video',
    assetKey: `video:${projectId}:${assetSuffix}`,
    key,
    contentType: 'video/mp4',
    body: bodyOf(size),
    maxBytes: 2_000,
    expectedBytes: size,
  });
}

function resetAll(): void {
  mock.reset();
  // The mock buckets and the real ledger must be cleared together. A completed
  // D1 row is intentionally conservative during a provider listing reset, so a
  // stale row would otherwise consume the test's tiny 2,700-byte target.
  const sqlite = getDb();
  sqlite.exec('DELETE FROM storage_reservations; DELETE FROM storage_objects; DELETE FROM storage_provider_state;');
  resetStorageMeasurementCache();
}

test.after(async () => {
  await mock.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('uploads use B2 first, spill into Tigris and Filebase, and stop at the safety target', async () => {
  resetAll();
  const project = newProject('allocation');
  const first = await putAsset(project.id, project.key, 850, 'first');
  assert.equal(first.providerId, 'b2');
  assert.equal(first.status, 'complete');
  assert.equal(first.bytes, 850);
  assert.match(mock.lastAuthorization ?? '', /^AWS4-HMAC-SHA256 /);
  assert.equal(mock.objectCount('test-b2'), 1);

  const second = await putAsset(project.id, projectObjectKey(project.id), 850, 'second');
  assert.equal(second.providerId, 'tigris');
  const third = await putAsset(project.id, projectObjectKey(project.id), 850, 'third');
  assert.equal(third.providerId, 'filebase');

  await assert.rejects(
    () => putAsset(project.id, projectObjectKey(project.id), 200, 'too-big'),
    /18 GB safety target has no room|bytes available/,
  );

  const usage = await getStorageUsage([project.id]);
  assert.equal(usage.available, true);
  assert.equal(usage.backend, 'pool');
  assert.equal(usage.configuredCapacityBytes, 2_700);
  assert.equal(usage.verifiedCapacityBytes, 2_700);
  assert.equal(usage.totalUsedBytes, 2_550);
  assert.equal(usage.totalAvailableBytes, 150);
  assert.equal(usage.providers.find((provider) => provider.id === 'b2')?.usedBytes, 850);
  assert.equal(usage.providers.find((provider) => provider.id === 'tigris')?.usedBytes, 850);
  assert.equal(usage.providers.find((provider) => provider.id === 'filebase')?.usedBytes, 850);
  assert.ok(usage.lastSuccessfulMeasurement);
});

test('concurrent uploads cannot reserve beyond provider or aggregate caps', async () => {
  resetAll();
  const project = newProject('concurrent');
  const results = await Promise.allSettled(
    Array.from({ length: 7 }, (_, index) =>
      putAsset(project.id, projectObjectKey(project.id), 400, `concurrent-${index}`),
    ),
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  // In-flight uploads can temporarily appear in both a provider listing and
  // an active reservation, which conservatively delays some parallel uploads.
  // That is safe; a later retry must be able to use the remaining measured
  // capacity, while a seventh 400-byte object must still be refused.
  assert.ok(fulfilled.length <= 6);
  assert.equal(fulfilled.length + rejected.length, 7);
  assert.ok(rejected.every((result) => result.status === 'rejected' && result.reason instanceof StoragePoolCapacityError));

  for (let index = 0; index < 7; index += 1) {
    if (results[index]?.status === 'fulfilled') continue;
    try {
      await putAsset(project.id, projectObjectKey(project.id), 400, `concurrent-retry-${index}`);
    } catch (error) {
      assert.ok(error instanceof StoragePoolCapacityError);
    }
  }
  await assert.rejects(
    () => putAsset(project.id, projectObjectKey(project.id), 400, 'concurrent-overflow'),
    (error: unknown) => error instanceof StoragePoolCapacityError,
  );

  const records = await db.getStorageObjectsForProject(project.id);
  assert.equal(records.filter((record) => record.status === 'complete').length, 6);
  assert.equal(records.filter((record) => record.providerId === 'b2' && record.status === 'complete').length, 2);
  assert.equal(records.filter((record) => record.providerId === 'tigris' && record.status === 'complete').length, 2);
  assert.equal(records.filter((record) => record.providerId === 'filebase' && record.status === 'complete').length, 2);
  assert.equal((await db.sumActiveStorageReservations()).count, 0);

  const usage = await getStorageUsage([project.id], { force: true });
  assert.equal(usage.totalUsedBytes, 2_400);
  assert.equal(usage.reservedBytes, 0);
  assert.equal(usage.totalAvailableBytes, 300);
  assert.equal(usage.targetVerified, true);
});

test('a failed upload is retried safely without duplicating the object', async () => {
  resetAll();
  const project = newProject('retry');
  mock.failPuts = true;
  await assert.rejects(() => putAsset(project.id, project.key, 100, 'retry'), /Simulated upload failure/);
  const failed = (await db.getStorageObjectsForProject(project.id))[0];
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.attempts, 1);

  mock.failPuts = false;
  resetStorageMeasurementCache();
  const retried = await putAsset(project.id, project.key, 100, 'retry');
  assert.equal(retried.status, 'complete');
  assert.equal(retried.attempts, 2);
  assert.equal(retried.providerId, 'b2');
  assert.equal(mock.objectCount('test-b2'), 1);
  assert.equal(
    (await db.getStorageObjectsForProject(project.id)).filter((record) => record.status === 'complete').length,
    1,
  );

  const verified = await verifyStorageObject(retried);
  assert.deepEqual(verified, { exists: true, size: 100 });
});

test('a failed multipart part retries independently and resumes without duplication', async () => {
  resetAll();
  const project = newProject('multipart-retry');
  const key = project.key;
  const started = await startMultipartStorageObject({
    ownerId: OWNER,
    projectId: project.id,
    kind: 'video',
    assetKey: `video:${project.id}:multipart-retry`,
    key,
    contentType: 'video/mp4',
    expectedBytes: 10,
    partSize: 5,
    totalParts: 2,
  });
  const encoder = new TextEncoder();
  mock.failNextPart = true;
  const part1 = await uploadMultipartPart(
    project.id,
    started.uploadId,
    1,
    encoder.encode('hello').buffer as ArrayBuffer,
  );
  const part2 = await uploadMultipartPart(
    project.id,
    started.uploadId,
    2,
    encoder.encode('world').buffer as ArrayBuffer,
  );
  const completed = await completeMultipartStorageObject(project.id, started.uploadId, [part1, part2]);
  assert.equal(completed.record.bytes, 10);
  assert.equal(mock.objectCount('test-b2'), 1);
  assert.equal(mock.multipartUploadCount(), 0);
  assert.equal((await db.sumActiveStorageReservations()).count, 0);
});

test('a multipart completion with the wrong final size is removed before release', async () => {
  resetAll();
  const project = newProject('multipart-size-mismatch');
  const started = await startMultipartStorageObject({
    ownerId: OWNER,
    projectId: project.id,
    kind: 'video',
    assetKey: `video:${project.id}:multipart-size-mismatch`,
    key: project.key,
    contentType: 'video/mp4',
    expectedBytes: 11,
    partSize: 5,
    totalParts: 2,
  });
  const encoder = new TextEncoder();
  const part1 = await uploadMultipartPart(
    project.id,
    started.uploadId,
    1,
    encoder.encode('hello').buffer as ArrayBuffer,
  );
  const part2 = await uploadMultipartPart(
    project.id,
    started.uploadId,
    2,
    encoder.encode('world').buffer as ArrayBuffer,
  );
  await assert.rejects(
    () => completeMultipartStorageObject(project.id, started.uploadId, [part1, part2]),
    /expected 11/,
  );
  assert.equal(mock.objectCount('test-b2'), 0);
  assert.equal((await db.sumActiveStorageReservations()).count, 0);
  const record = await db.getStorageObject(started.record.id);
  assert.equal(record?.status, 'failed');
  assert.equal(record?.uploadId, null);
});

test('an abandoned multipart reservation is aborted, failed and released', async () => {
  resetAll();
  const project = newProject('abandoned');
  const started = await startMultipartStorageObject({
    ownerId: OWNER,
    projectId: project.id,
    kind: 'video',
    assetKey: `video:${project.id}:abandoned`,
    key: project.key,
    contentType: 'video/mp4',
    expectedBytes: 900,
    partSize: 5,
    totalParts: 2,
  });
  assert.equal(mock.multipartUploadCount(), 1);
  assert.equal((await db.sumActiveStorageReservations()).count, 1);
  getDb().prepare("UPDATE storage_reservations SET expires_at = ? WHERE status = 'active'").run(
    new Date(0).toISOString(),
  );
  const cleanup = await cleanupExpiredStorageUploads();
  assert.equal(cleanup.released, 1);
  assert.equal(cleanup.aborted, 1);
  assert.equal(cleanup.errors.length, 0);
  assert.equal(mock.multipartUploadCount(), 0);
  assert.equal((await db.sumActiveStorageReservations()).count, 0);
  const record = await db.getStorageObject(started.record.id);
  assert.equal(record?.status, 'failed');
  assert.equal(record?.uploadId, null);
});

test('multipart uploads can resume, complete and verify their assembled bytes', async () => {
  resetAll();
  const project = newProject('multipart');
  const key = project.key;
  const started = await startMultipartStorageObject({
    ownerId: OWNER,
    projectId: project.id,
    kind: 'video',
    assetKey: `video:${project.id}:multipart`,
    key,
    contentType: 'video/mp4',
    expectedBytes: 10,
    partSize: 5,
    totalParts: 2,
  });
  assert.equal(started.providerId, 'b2');
  const pendingUsage = await getStorageUsage([project.id], { force: true });
  assert.equal(pendingUsage.reservedBytes, 10);
  assert.equal(pendingUsage.pendingUploads, 1);
  assert.equal(pendingUsage.providers.find((provider) => provider.id === 'b2')?.reservedBytes, 10);
  const encoder = new TextEncoder();
  const part1 = await uploadMultipartPart(
    project.id,
    started.uploadId,
    1,
    encoder.encode('hello').buffer as ArrayBuffer,
  );
  const part2 = await uploadMultipartPart(
    project.id,
    started.uploadId,
    2,
    encoder.encode('world').buffer as ArrayBuffer,
  );
  const completed = await completeMultipartStorageObject(project.id, started.uploadId, [part1, part2]);
  assert.equal(completed.record.status, 'complete');
  assert.equal(completed.record.bytes, 10);
  assert.equal(mock.objectData('test-b2', key)?.toString(), 'helloworld');
  const path = storageObjectPath(completed.record);
  assert.equal(path.startsWith('s3://b2/'), true);
  assert.equal(await pathExists(path), true);
});

test('remote ranges, downloads and ZIP exports stream provider objects', async () => {
  resetAll();
  const project = newProject('download');
  const record = await putAsset(project.id, project.key, 64, 'download');
  const tigris = await putAsset(project.id, projectObjectKey(project.id), 850, 'download-tigris');
  const filebase = await putAsset(project.id, projectObjectKey(project.id), 850, 'download-filebase');
  assert.deepEqual([record.providerId, tigris.providerId, filebase.providerId], ['b2', 'tigris', 'filebase']);
  const remotePath = storageObjectPath(record);
  const tigrisPath = storageObjectPath(tigris);
  const filebasePath = storageObjectPath(filebase);
  const data = new Uint8Array(64).fill(7);
  const tigrisData = new Uint8Array(850).fill(7);
  const filebaseData = new Uint8Array(850).fill(7);

  const blob = await getBlob(remotePath);
  assert.ok(blob);
  assert.deepEqual(Buffer.from(await new Response(blob.body).arrayBuffer()), Buffer.from(data));

  const ranged = await fileResponse(
    new Request('http://localhost/clip', { headers: { range: 'bytes=10-19' } }),
    remotePath,
    { contentType: 'video/mp4' },
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 10-19/64');
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), Buffer.from(data.subarray(10, 20)));

  const full = await fileResponse(new Request('http://localhost/clip'), remotePath, {
    contentType: 'video/mp4',
  });
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 64);

  for (const [path, expectedSize] of [
    [tigrisPath, 850],
    [filebasePath, 850],
  ] as const) {
    const partial = await getBlob(path, { offset: 20, length: 30 });
    assert.ok(partial);
    assert.equal(partial.size, expectedSize);
    assert.equal((await new Response(partial.body).arrayBuffer()).byteLength, 30);
    const downloaded = await getBlob(path);
    assert.ok(downloaded);
    assert.equal((await new Response(downloaded.body).arrayBuffer()).byteLength, expectedSize);
  }

  const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
  interface ZipArchive {
    pipe(destination: NodeJS.WritableStream): void;
    file(filePath: string, data: { name: string }): void;
    append(content: string | NodeJS.ReadableStream, data: { name: string }): void;
    finalize(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }
  const archiverModule = nodeRequire('archiver') as {
    ZipArchive?: new (options?: { zlib?: { level?: number } }) => ZipArchive;
    default?: (format: 'zip', options?: { zlib?: { level?: number } }) => ZipArchive;
  };
  const archive: ZipArchive =
    typeof archiverModule.ZipArchive === 'function'
      ? new archiverModule.ZipArchive({ zlib: { level: 0 } })
      : (archiverModule.default as NonNullable<typeof archiverModule.default>)('zip', {
          zlib: { level: 0 },
        });
  const zipPath = path.join(dataDir, 'clips.zip');
  const output = fs.createWriteStream(zipPath);
  archive.pipe(output);
  assert.equal(await appendStorageFile(archive, remotePath, 'clip.mp4'), true);
  assert.equal(await appendStorageFile(archive, tigrisPath, 'tigris.mp4'), true);
  assert.equal(await appendStorageFile(archive, filebasePath, 'filebase.mp4'), true);
  archive.append('{"project":"download"}', { name: 'clips.json' });
  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });

  const unzip = spawnSync('unzip', ['-p', zipPath, 'clip.mp4']);
  assert.equal(unzip.status, 0, unzip.stderr?.toString());
  assert.deepEqual(unzip.stdout, Buffer.from(data));
  const unzipTigris = spawnSync('unzip', ['-p', zipPath, 'tigris.mp4']);
  assert.equal(unzipTigris.status, 0, unzipTigris.stderr?.toString());
  assert.deepEqual(unzipTigris.stdout, Buffer.from(tigrisData));
  const unzipFilebase = spawnSync('unzip', ['-p', zipPath, 'filebase.mp4']);
  assert.equal(unzipFilebase.status, 0, unzipFilebase.stderr?.toString());
  assert.deepEqual(unzipFilebase.stdout, Buffer.from(filebaseData));
});

test('project deletion crosses every provider and preserves the record after a failed delete', async () => {
  resetAll();
  const project = newProject('deletion');
  const first = await putAsset(project.id, project.key, 850, 'delete-b2');
  const second = await putAsset(project.id, projectObjectKey(project.id), 850, 'delete-tigris');
  const third = await putAsset(project.id, projectObjectKey(project.id), 850, 'delete-filebase');
  assert.equal(first.providerId, 'b2');
  assert.equal(second.providerId, 'tigris');
  assert.equal(third.providerId, 'filebase');

  mock.failDeletes.add('test-b2');
  const failed = await deleteProjectFiles(project.id);
  assert.equal(failed.verified, false);
  assert.equal(failed.failedFiles.length, 1);
  assert.match(failed.failedFiles[0]?.path ?? '', /^b2\//);
  assert.ok(db.getProject(project.id), 'the project row must remain for a retry');
  assert.ok(
    (await db.getStorageObjectsForProject(project.id)).some((record) => record.status === 'delete_failed'),
    'the failed provider record must remain for a retry',
  );

  mock.failDeletes.clear();
  resetStorageMeasurementCache();
  const retried = await deleteProjectFiles(project.id);
  assert.equal(retried.verified, true);
  assert.equal(retried.failedFiles.length, 0);
  assert.equal(retried.bytesRemaining, 0);
  assert.equal((await db.getStorageObjectsForProject(project.id)).length, 0);
  assert.equal(mock.objectCount('test-b2'), 0);
  assert.equal(mock.objectCount('test-tigris'), 0);
  assert.equal(mock.objectCount('test-filebase'), 0);
});

test('unreachable providers report unavailable instead of fabricated zero usage', async () => {
  resetAll();
  for (const bucket of mock.buckets) mock.failBucketChecks.add(bucket);
  const usage = await getStorageUsage([], { force: true });
  assert.equal(usage.available, false);
  assert.equal(usage.verifiedCapacityBytes, 0);
  assert.equal(usage.lastSuccessfulMeasurement, null);
  assert.equal(usage.providers.length, 3);
  for (const provider of usage.providers) {
    assert.equal(provider.configured, true);
    assert.equal(provider.verified, false);
    assert.equal(provider.usedBytes, null);
    assert.ok(provider.error);
  }
  mock.failBucketChecks.clear();
  resetStorageMeasurementCache();
});
