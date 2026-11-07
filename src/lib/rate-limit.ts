import { createHash } from 'node:crypto';
import * as db from './db';

/**
 * Durable fixed-window rate limiter.
 *
 * Counters live in the shared database (D1 in production, SQLite locally), not
 * in a process-local Map. A credential attempt counted by one Worker therefore
 * counts against every Worker, which is what makes this meaningful behind a
 * multi-isolate deployment.
 *
 * Keys are SHA-256 hashed before storage: the inputs include email addresses
 * and client addresses, which do not need to be retained to count attempts.
 */

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the current window ends; 0 when allowed. */
  retryAfter: number;
  remaining: number;
}

/** Buckets are pruned after this long; every window here is far shorter. */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 1000;
let lastPurgeAt = 0;

function bucketKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Consumes one attempt from `key`'s window.
 *
 * `nowMs` is injectable so the window-reset behavior is testable without
 * sleeping. Production callers omit it.
 */
export async function takeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const bucket = bucketKey(key);
  const now = new Date(nowMs).toISOString();
  const resetBefore = new Date(nowMs - windowMs).toISOString();
  const row = await db.consumeRateLimitRow({ key: bucket, now, resetBefore });
  if (!row) return { ok: false, retryAfter: Math.max(1, Math.ceil(windowMs / 1000)), remaining: 0 };

  const windowEndsAt = Date.parse(row.windowStartedAt) + windowMs;
  const retryAfter = Math.max(1, Math.ceil((windowEndsAt - nowMs) / 1000));
  return {
    ok: row.count <= limit,
    retryAfter: row.count <= limit ? 0 : retryAfter,
    remaining: Math.max(0, limit - row.count),
  };
}

/** Clears a bucket, e.g. after a successful sign-in. */
export async function clearRateLimit(key: string): Promise<void> {
  await db.resetRateLimitRow(bucketKey(key));
}

/** Deletes buckets whose window ended longer ago than the retention period. */
export async function purgeRateLimits(
  nowMs: number = Date.now(),
  retentionMs: number = RETENTION_MS,
): Promise<number> {
  return db.purgeRateLimitRows(new Date(nowMs - retentionMs).toISOString());
}

/**
 * Opportunistic cleanup, throttled per isolate. Spoofed addresses or random
 * emails could otherwise grow the table without bound; correctness never
 * depends on this running.
 */
export async function maybePurgeRateLimits(nowMs: number = Date.now()): Promise<void> {
  if (nowMs - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = nowMs;
  await purgeRateLimits(nowMs).catch(() => 0);
}
