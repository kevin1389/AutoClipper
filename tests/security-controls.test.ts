import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearRateLimit,
  purgeRateLimits,
  takeRateLimit,
} from '../src/lib/rate-limit';
import {
  checkReconcileSecret,
  MIN_RECONCILE_SECRET_LENGTH,
} from '../src/lib/reconcile-secret';
import { healthFailure } from '../src/lib/health';
import { closeDb, getDb } from '../src/lib/db-sqlite';

process.env.AC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-controls-'));
closeDb();

test('a durable limit admits exactly the allowed number of concurrent requests', async () => {
  const key = `concurrent:${Date.now()}`;
  const results = await Promise.all(
    Array.from({ length: 25 }, () => takeRateLimit(key, 5, 60_000)),
  );

  assert.equal(results.filter((result) => result.ok).length, 5);
  assert.equal(results.filter((result) => !result.ok).length, 20);
  for (const blocked of results.filter((result) => !result.ok)) {
    assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);
  }
});

test('the counter survives a fresh database connection', async () => {
  const key = `durable:${Date.now()}`;
  await takeRateLimit(key, 2, 60_000);
  await takeRateLimit(key, 2, 60_000);
  closeDb();
  // A new connection stands in for a different Worker isolate.
  assert.equal((await takeRateLimit(key, 2, 60_000)).ok, false);
});

test('the window resets once it elapses', async () => {
  const start = Date.now();
  const key = `window:${start}`;
  assert.equal((await takeRateLimit(key, 2, 10_000, start)).ok, true);
  assert.equal((await takeRateLimit(key, 2, 10_000, start + 1_000)).ok, true);
  assert.equal((await takeRateLimit(key, 2, 10_000, start + 2_000)).ok, false);
  // One millisecond past the window: a fresh window starts at count 1.
  const after = await takeRateLimit(key, 2, 10_000, start + 10_001);
  assert.equal(after.ok, true);
  assert.equal(after.remaining, 1);
});

test('clearing a bucket resets the count', async () => {
  const key = `reset:${Date.now()}`;
  await takeRateLimit(key, 1, 60_000);
  assert.equal((await takeRateLimit(key, 1, 60_000)).ok, false);
  await clearRateLimit(key);
  assert.equal((await takeRateLimit(key, 1, 60_000)).ok, true);
});

test('separate buckets do not share a count', async () => {
  const stamp = Date.now();
  await takeRateLimit(`separate:a:${stamp}`, 1, 60_000);
  assert.equal((await takeRateLimit(`separate:a:${stamp}`, 1, 60_000)).ok, false);
  assert.equal((await takeRateLimit(`separate:b:${stamp}`, 1, 60_000)).ok, true);
});

test('email addresses are hashed before they are stored', async () => {
  const key = `sign-in:account:person-${Date.now()}@example.test`;
  await takeRateLimit(key, 5, 60_000);
  const rows = getDb().prepare('SELECT key FROM rate_limits').all() as { key: string }[];
  assert.equal(rows.some((row) => row.key.includes('@example.test')), false);
  assert.ok(rows.some((row) => /^[0-9a-f]{64}$/.test(row.key)));
});

test('stale buckets are purged without touching live ones', async () => {
  const now = Date.now();
  const stale = `purge:stale:${now}`;
  const live = `purge:live:${now}`;
  await takeRateLimit(stale, 5, 60_000, now - 48 * 60 * 60_000);
  await takeRateLimit(live, 5, 60_000, now);

  assert.ok((await purgeRateLimits(now)) >= 1);
  // The stale bucket is gone, so it starts over rather than resuming at 2.
  assert.equal((await takeRateLimit(stale, 5, 60_000, now)).remaining, 4);
});

test('reconciliation secrets must be configured and long enough', () => {
  assert.equal(checkReconcileSecret(undefined, 'anything'), 'not_configured');
  assert.equal(checkReconcileSecret('', 'anything'), 'not_configured');
  assert.equal(checkReconcileSecret('   ', 'anything'), 'not_configured');

  const short = 'a'.repeat(MIN_RECONCILE_SECRET_LENGTH - 1);
  assert.equal(checkReconcileSecret(short, short), 'too_short');

  const strong = 's'.repeat(MIN_RECONCILE_SECRET_LENGTH);
  assert.equal(checkReconcileSecret(strong, null), 'unauthorized');
  assert.equal(checkReconcileSecret(strong, ''), 'unauthorized');
  assert.equal(checkReconcileSecret(strong, 'wrong'), 'unauthorized');
  assert.equal(checkReconcileSecret(strong, strong), 'ok');
  // A short guess must not throw or leak the configured length.
  assert.equal(checkReconcileSecret(strong, strong.slice(0, 4)), 'unauthorized');
  assert.equal(checkReconcileSecret(`${strong}extra`, strong), 'unauthorized');
});

test('health failures never echo paths, credentials or driver errors', () => {
  const failure = healthFailure();
  const serialized = JSON.stringify(failure);

  assert.equal(failure.ok, false);
  assert.equal(failure.status, 'unavailable');
  assert.equal(failure.code, 'storage_unavailable');
  assert.match(failure.error, /storage is unavailable/i);

  for (const leak of [
    '/var/lib',
    'autoclipper.db',
    'EACCES',
    'AKIA',
    'SECRET',
    'postgres://',
    'D1_ERROR',
    'SQLITE',
  ]) {
    assert.equal(serialized.includes(leak), false, `health payload leaked ${leak}`);
  }
});
