/**
 * One statement consumes a rate-limit token and returns the resulting count.
 *
 * The counter lives in D1 (or SQLite locally), so every Worker isolate sees the
 * same window. `RETURNING count` means each caller observes its own atomic
 * increment: with 20 concurrent requests against a limit of 5, exactly five see
 * counts 1-5 and the rest see 6-20. A read-after-write would race and could
 * reject a request that was actually within the limit.
 *
 * A row whose window has expired is reset in place to count 1 and starts a new
 * window, so an abandoned bucket cannot block a later user forever.
 *
 * Bind order: key, now, now, reset_before, reset_before.
 */
export const CONSUME_RATE_LIMIT_SQL = `
INSERT INTO rate_limits (key, count, window_started_at, updated_at)
VALUES (?, 1, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  count = CASE
    WHEN rate_limits.window_started_at <= ? THEN 1
    ELSE rate_limits.count + 1
  END,
  window_started_at = CASE
    WHEN rate_limits.window_started_at <= ? THEN excluded.window_started_at
    ELSE rate_limits.window_started_at
  END,
  updated_at = excluded.updated_at
RETURNING count, window_started_at
`;
