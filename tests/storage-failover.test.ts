import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from '../src/lib/db';
import { closeDb, getDb } from '../src/lib/db-sqlite';
import {
  resetStorageMeasurementCache,
  StoragePoolCapacityError,
  uploadStorageObject,
} from '../src/lib/storage-pool';
import { getStorageUsage } from '../src/lib/storage';
import { storageProviders, storageTargetBytes } from '../src/lib/storage-providers';
import { createMockS3, type MockS3 } from './support/mock-s3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-failover-'));
let mock!: MockS3;
const OWNER = 'failover-owner';

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
  db.upsertUser({ id: OWNER, email: 'failover@example.test', name: 'Failover', picture: null });
});

test.after(async () => {
  await mock.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function resetAll(): void {
  mock.reset();
  getDb().exec(
    'DELETE FROM storage_reservations; DELETE FROM storage_objects; DELETE FROM storage_provider_state;',
  );
  resetStorageMeasurementCache();
}

function newProject(): string {
  const id = randomUUID();
  db.createProject({ id, ownerId: OWNER, title: 'failover', sourceKind: 'upload' });
  return id;
}

function bodyOf(size: number): ReadableStream<Uint8Array> {
  return new Response(new Uint8Array(size).fill(5)).body as ReadableStream<Uint8Array>;
}

async function put(projectId: string, size: number, suffix: string = randomUUID()) {
  return uploadStorageObject({
    ownerId: OWNER,
    projectId,
    kind: 'video',
    assetKey: `video:${projectId}:${suffix}`,
    key: `projects/${projectId}/clips/${suffix}.mp4`,
    contentType: 'video/mp4',
    body: bodyOf(size),
    maxBytes: 2_000,
    expectedBytes: size,
  });
}

test('a failed provider upload fails over to the next provider without duplicates', async () => {
  resetAll();
  const projectId = newProject();
  mock.failPutsFor.add('test-b2');

  const record = await put(projectId, 100);

  assert.equal(record.providerId, 'tigris');
  assert.equal(record.status, 'complete');
  assert.equal(record.bytes, 100);
  assert.equal(mock.putAttempts('test-b2'), 1);
  assert.equal(mock.putAttempts('test-tigris'), 1);
  assert.equal(mock.objectCount('test-b2'), 0, 'the failed provider must hold no orphan');
  assert.equal(mock.objectCount('test-tigris'), 1);

  const records = await db.getStorageObjectsForProject(projectId);
  assert.equal(records.filter((entry) => entry.status === 'complete').length, 1);
  assert.equal(records.filter((entry) => entry.status === 'failed').length, 1);
  assert.equal((await db.sumActiveStorageReservations()).count, 0);
});

test('failover stops at the retry limit and leaves no reservations or objects', async () => {
  resetAll();
  const projectId = newProject();
  mock.failPuts = true;

  await assert.rejects(() => put(projectId, 100), /Simulated upload failure/);

  assert.equal(mock.putAttempts('test-b2'), 1);
  assert.equal(mock.putAttempts('test-tigris'), 1);
  assert.equal(mock.putAttempts('test-filebase'), 1, 'one attempt per provider, no fourth try');
  for (const bucket of mock.buckets) assert.equal(mock.objectCount(bucket), 0);

  const records = await db.getStorageObjectsForProject(projectId);
  assert.equal(records.length, 3);
  assert.ok(records.every((entry) => entry.status === 'failed'));
  assert.equal((await db.sumActiveStorageReservations()).count, 0);
});

test('an unremovable failed upload keeps its reservation and does not fail over', async () => {
  resetAll();
  const projectId = newProject();
  mock.failPutsFor.add('test-b2');
  mock.failDeletes.add('test-b2');

  await assert.rejects(() => put(projectId, 100), /would not confirm removal|Simulated upload failure/);

  assert.equal(mock.putAttempts('test-tigris'), 0, 'no failover while bytes may remain');
  assert.equal(mock.putAttempts('test-filebase'), 0);
  assert.equal((await db.sumActiveStorageReservations()).count, 1);
  const [record] = await db.getStorageObjectsForProject(projectId);
  assert.equal(record?.status, 'uploading');
  assert.match(record?.lastError ?? '', /remain reserved/);

  mock.failDeletes.clear();
  mock.failPutsFor.clear();
});

test('provider limits and the aggregate target cannot be raised above the free tier', () => {
  const savedTarget = process.env.AC_STORAGE_TARGET_BYTES;
  const savedLimit = process.env.AC_B2_LIMIT_BYTES;
  process.env.AC_STORAGE_TARGET_BYTES = '999999999999';
  process.env.AC_B2_LIMIT_BYTES = '999999999999';
  try {
    assert.equal(storageTargetBytes(), 18_000_000_000);
    const b2 = storageProviders().find((provider) => provider.id === 'b2');
    assert.ok(b2);
    assert.equal(b2.limitBytes, 10_000_000_000, 'the free-tier allowance is the hard ceiling');
    assert.equal(b2.safeLimitBytes, 10_000_000_000 - 100, 'the test reserve is 100 bytes');
  } finally {
    if (savedTarget === undefined) delete process.env.AC_STORAGE_TARGET_BYTES;
    else process.env.AC_STORAGE_TARGET_BYTES = savedTarget;
    if (savedLimit === undefined) delete process.env.AC_B2_LIMIT_BYTES;
    else process.env.AC_B2_LIMIT_BYTES = savedLimit;
  }
});

test('uploads and cached reads do not re-list providers', async () => {
  resetAll();
  const projectId = newProject();

  await put(projectId, 100);
  const afterFirst = mock.listRequests('test-b2');
  assert.equal(afterFirst, 1);
  assert.equal(mock.listRequests('test-tigris'), 1);

  for (let index = 0; index < 3; index += 1) {
    await put(projectId, 100, `no-list-${index}`);
  }
  assert.equal(mock.listRequests('test-b2'), afterFirst, 'reservations must not list');

  const cached = await getStorageUsage([projectId]);
  assert.equal(cached.available, true);
  assert.equal(mock.listRequests('test-b2'), afterFirst, 'dashboard reads use persisted state');

  // An explicit refresh still respects the cooldown, so repeated clicks cannot
  // fan out into repeated provider listings.
  await getStorageUsage([projectId], { force: true });
  assert.equal(mock.listRequests('test-b2'), afterFirst, 'forced refresh honours the cooldown');
});

test('concurrent uploads fail over without exceeding the remaining provider caps', async () => {
  resetAll();
  const projectId = newProject();
  mock.failPutsFor.add('test-b2');

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) => put(projectId, 400, `concurrent-${index}`)),
  );
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof put>>> =>
      result.status === 'fulfilled',
  );

  assert.ok(fulfilled.length >= 1);
  assert.ok(fulfilled.length <= 4, 'only Tigris and Filebase capacity is usable');
  assert.ok(fulfilled.every((result) => result.value.providerId !== 'b2'));
  const completedBytes = fulfilled.reduce((total, result) => total + result.value.bytes, 0);
  assert.ok(completedBytes <= 1_800, `completed ${completedBytes} bytes exceeds usable capacity`);
  assert.equal(mock.objectCount('test-b2'), 0);
  assert.equal((await db.sumActiveStorageReservations()).count, 0);
});

test('an exhausted aggregate target refuses the upload and leaks no reservation', async () => {
  resetAll();
  const projectId = newProject();
  const savedTarget = process.env.AC_STORAGE_TARGET_BYTES;
  process.env.AC_STORAGE_TARGET_BYTES = '300';
  try {
    const first = await put(projectId, 200);
    assert.equal(first.status, 'complete');

    await assert.rejects(
      () => put(projectId, 200, 'overflow'),
      (error: unknown) => error instanceof StoragePoolCapacityError,
    );
    assert.equal((await db.sumActiveStorageReservations()).count, 0);
    const records = await db.getStorageObjectsForProject(projectId);
    assert.equal(records.filter((entry) => entry.status === 'complete').length, 1);
    assert.equal((await db.sumStorageObjectsByProvider('b2')).bytes, 200);
  } finally {
    if (savedTarget === undefined) delete process.env.AC_STORAGE_TARGET_BYTES;
    else process.env.AC_STORAGE_TARGET_BYTES = savedTarget;
  }
});
