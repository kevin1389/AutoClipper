import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from '../src/lib/db';
import { closeDb, getDb } from '../src/lib/db-sqlite';
import {
  abortMultipartStorageObject,
  resetStorageMeasurementCache,
  startMultipartStorageObject,
  uploadStorageObject,
} from '../src/lib/storage-pool';
import {
  RECONCILE_INTERVAL_MS,
  RECONCILE_RETRY_MS,
  reconcileStorageProviders,
} from '../src/lib/storage-reconcile';
import { getStorageUsage } from '../src/lib/storage';
import { createMockS3, type MockS3 } from './support/mock-s3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-reconcile-'));
let mock!: MockS3;
const OWNER = 'reconcile-owner';
const PROVIDERS = ['b2', 'tigris', 'filebase'] as const;
const BUCKETS: Record<(typeof PROVIDERS)[number], string> = {
  b2: 'test-b2',
  tigris: 'test-tigris',
  filebase: 'test-filebase',
};

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
  db.upsertUser({ id: OWNER, email: 'reconcile@example.test', name: 'Reconcile', picture: null });
});

test.after(async () => {
  await mock.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function resetAll(): void {
  mock.reset();
  getDb().exec(
    'DELETE FROM storage_reservations; DELETE FROM storage_objects; DELETE FROM storage_provider_state; DELETE FROM storage_reconciliation;',
  );
  resetStorageMeasurementCache();
}

function newProject(): string {
  const id = randomUUID();
  db.createProject({ id, ownerId: OWNER, title: 'reconcile', sourceKind: 'upload' });
  return id;
}

function bodyOf(size: number): ReadableStream<Uint8Array> {
  return new Response(new Uint8Array(size).fill(9)).body as ReadableStream<Uint8Array>;
}

async function put(projectId: string, size: number) {
  return uploadStorageObject({
    ownerId: OWNER,
    projectId,
    kind: 'video',
    assetKey: `video:${projectId}:${randomUUID()}`,
    key: `projects/${projectId}/clips/${randomUUID()}.mp4`,
    contentType: 'video/mp4',
    body: bodyOf(size),
    maxBytes: 2_000,
    expectedBytes: size,
  });
}

test('reconciles each provider exactly once per day', async () => {
  resetAll();
  const projectId = newProject();
  await put(projectId, 150);
  // The upload measures every provider once to establish its baseline.
  const listsAfterUpload = PROVIDERS.map((id) => mock.listRequests(BUCKETS[id]));

  const now = Date.now();
  const first = await reconcileStorageProviders({ now });
  assert.equal(first.reconciled, 3);
  assert.deepEqual(
    first.results.map((result) => `${result.providerId}:${result.status}`),
    ['b2:reconciled', 'tigris:reconciled', 'filebase:reconciled'],
  );
  const listsAfterFirst = PROVIDERS.map((id) => mock.listRequests(BUCKETS[id]));
  assert.deepEqual(listsAfterFirst, listsAfterUpload.map((count) => count + 1));

  const second = await reconcileStorageProviders({ now: now + 60_000 });
  assert.equal(second.reconciled, 0);
  assert.equal(second.skipped, 3);
  assert.deepEqual(
    PROVIDERS.map((id) => mock.listRequests(BUCKETS[id])),
    listsAfterFirst,
    'a run inside the daily window must not list anything',
  );

  const third = await reconcileStorageProviders({ now: now + RECONCILE_INTERVAL_MS + 1_000 });
  assert.equal(third.reconciled, 3);
  assert.deepEqual(
    PROVIDERS.map((id) => mock.listRequests(BUCKETS[id])),
    listsAfterFirst.map((count) => count + 1),
  );

  const state = await db.getStorageProviderState('b2');
  assert.equal(state?.verified, true);
  assert.equal(state?.listedBytes, 150);
  assert.ok(state?.measuredAt);
  const record = await db.getStorageReconciliation('b2');
  assert.ok(record?.lastSuccessAt);
  assert.equal(record?.consecutiveFailures, 0);
});

test('a failed listing keeps the last known bytes instead of reporting zero', async () => {
  resetAll();
  const projectId = newProject();
  await put(projectId, 150);

  const now = Date.now();
  await reconcileStorageProviders({ now });
  const successfulRecord = await db.getStorageReconciliation('b2');
  assert.ok(successfulRecord?.lastSuccessAt);
  const before = await db.getStorageProviderState('b2');
  assert.equal(before?.listedBytes, 150);
  assert.equal(before?.verified, true);

  mock.failLists.add('test-b2');
  const failed = await reconcileStorageProviders({ now: now + RECONCILE_INTERVAL_MS + 1_000 });
  const b2Result = failed.results.find((result) => result.providerId === 'b2');
  assert.equal(b2Result?.status, 'failed');
  assert.equal(b2Result?.usedBytes, null, 'a failed measurement is never reported as zero');
  assert.equal(failed.failed, 1);

  const after = await db.getStorageProviderState('b2');
  assert.equal(after?.verified, false);
  assert.equal(after?.listedBytes, 150, 'the last successful listing must be preserved');
  assert.equal(after?.externalBytes, before?.externalBytes);
  assert.match(after?.lastError ?? '', /Simulated list failure/);

  const record = await db.getStorageReconciliation('b2');
  assert.equal(record?.consecutiveFailures, 1);
  assert.equal(
    record?.lastSuccessAt,
    successfulRecord?.lastSuccessAt,
    'a failure must not clear or advance the last successful reconciliation',
  );
  assert.ok(record?.nextAttemptAt);

  // The dashboard must not fabricate usage for the failed provider.
  const usage = await getStorageUsage([]);
  const b2Usage = usage.providers.find((provider) => provider.id === 'b2');
  assert.equal(b2Usage?.verified, false);
  assert.equal(b2Usage?.usedBytes, null);
  assert.equal(usage.verifiedCapacityBytes, 1_800);
  assert.equal(usage.unverifiedCapacityBytes, 900);

  // The failure left the ledger untouched.
  assert.equal((await db.sumStorageObjectsByProvider('b2')).bytes, 150);
  assert.equal((await db.sumActiveStorageReservations()).count, 0);

  mock.failLists.clear();
});

test('concurrent reconciliation runs cannot double-list a provider', async () => {
  resetAll();
  await put(newProject(), 100);

  const now = Date.now();
  const reports = await Promise.all(
    Array.from({ length: 5 }, () => reconcileStorageProviders({ now })),
  );
  const statuses = reports.flatMap((report) =>
    report.results.map((result) => `${result.providerId}:${result.status}`),
  );
  for (const id of PROVIDERS) {
    assert.equal(
      statuses.filter((status) => status === `${id}:reconciled`).length,
      1,
      `${id} must be reconciled by exactly one run`,
    );
  }
  assert.equal(reports.reduce((total, report) => total + report.reconciled, 0), 3);
  // One listing to establish state during the upload, one for the winning run.
  for (const id of PROVIDERS) assert.equal(mock.listRequests(BUCKETS[id]), 2);
});

test('an active upload defers reconciliation and keeps its reservation', async () => {
  resetAll();
  const projectId = newProject();
  const session = await startMultipartStorageObject({
    ownerId: OWNER,
    projectId,
    kind: 'video',
    assetKey: `video:${projectId}:multipart`,
    key: `projects/${projectId}/clips/multipart.mp4`,
    contentType: 'video/mp4',
    expectedBytes: 400,
    partSize: 200,
    totalParts: 2,
  });
  assert.equal(session.providerId, 'b2');
  const listsBefore = mock.listRequests('test-b2');

  const report = await reconcileStorageProviders({ now: Date.now() });
  const b2Result = report.results.find((result) => result.providerId === 'b2');
  assert.equal(b2Result?.status, 'deferred');
  assert.equal(b2Result?.usedBytes, 400, 'the known reserved bytes are reported, not a listing');
  assert.equal(report.reconciled, 2, 'the two idle providers are still reconciled');
  assert.equal(
    mock.listRequests('test-b2'),
    listsBefore,
    'a deferred provider must not be listed',
  );

  const reservations = await db.sumActiveStorageReservationsByProvider('b2');
  assert.equal(reservations.count, 1);
  assert.equal(reservations.bytes, 400);
  const records = await db.getStorageObjectsForProject(projectId);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, 'uploading');

  const tooSoon = await reconcileStorageProviders({ now: Date.now() + 60_000 });
  assert.equal(
    tooSoon.results.find((result) => result.providerId === 'b2')?.status,
    'skipped',
    'a deferral is retried later, not in a tight loop',
  );

  await abortMultipartStorageObject(projectId, session.uploadId);
  assert.equal((await db.sumActiveStorageReservationsByProvider('b2')).count, 0);
});

test('a stale listing cannot overwrite newer provider state', async () => {
  resetAll();
  await db.setStorageProviderState({
    providerId: 'b2',
    listedBytes: 100,
    externalBytes: 0,
    verified: true,
    measuredAt: '2026-01-01T00:00:00.000Z',
    lastError: null,
  });
  const original = await db.getStorageProviderState('b2');
  assert.ok(original);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await db.setStorageProviderState({
    providerId: 'b2',
    listedBytes: 500,
    externalBytes: 0,
    verified: true,
    measuredAt: '2026-01-02T00:00:00.000Z',
    lastError: null,
  });

  const applied = await db.compareAndSetStorageProviderState({
    providerId: 'b2',
    listedBytes: 100,
    externalBytes: 0,
    verified: true,
    measuredAt: '2026-01-01T00:00:00.000Z',
    lastError: null,
    expectedUpdatedAt: original.updatedAt,
  });

  assert.equal(applied, false, 'the compare-and-set must lose to the newer write');
  const current = await db.getStorageProviderState('b2');
  assert.equal(current?.listedBytes, 500);
  assert.equal(current?.measuredAt, '2026-01-02T00:00:00.000Z');
});

test('a failure retries after the retry delay and recovers on success', async () => {
  resetAll();
  await put(newProject(), 150);
  const now = Date.now();

  await reconcileStorageProviders({ now });
  mock.failLists.add('test-b2');

  const failed = await reconcileStorageProviders({ now: now + RECONCILE_INTERVAL_MS + 1_000 });
  assert.equal(failed.failed, 1);

  const tooSoon = await reconcileStorageProviders({
    now: now + RECONCILE_INTERVAL_MS + 60_000,
  });
  assert.equal(
    tooSoon.results.find((result) => result.providerId === 'b2')?.status,
    'skipped',
  );

  const retried = await reconcileStorageProviders({
    now: now + RECONCILE_INTERVAL_MS + RECONCILE_RETRY_MS + 2_000,
  });
  assert.equal(
    retried.results.find((result) => result.providerId === 'b2')?.status,
    'failed',
  );

  mock.failLists.clear();
  const recovered = await reconcileStorageProviders({
    now: now + RECONCILE_INTERVAL_MS + 2 * RECONCILE_RETRY_MS + 3_000,
  });
  assert.equal(
    recovered.results.find((result) => result.providerId === 'b2')?.status,
    'reconciled',
  );
  const state = await db.getStorageProviderState('b2');
  assert.equal(state?.verified, true);
  const record = await db.getStorageReconciliation('b2');
  assert.equal(record?.consecutiveFailures, 0);
  assert.ok(record?.lastSuccessAt);
});
