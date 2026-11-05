/**
 * Small in-process limiter for credential endpoints.
 *
 * This is a best-effort guard against online password guessing, not a shared
 * distributed store: a multi-instance deployment should put a real limiter in
 * front of these routes. Keys are pruned once the table grows too large.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

export function takeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    for (const [name, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(name);
    }
  }
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfter: 0 };
}

export function clearRateLimit(key: string): void {
  buckets.delete(key);
}
