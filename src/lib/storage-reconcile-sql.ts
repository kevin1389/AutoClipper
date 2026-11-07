/**
 * Reconciliation bookkeeping SQL, shared by the Node and D1 backends.
 *
 * One row per provider records when a daily check last succeeded, when the next
 * one is due, and a short lease that makes exactly one Worker responsible for a
 * run. The claim is a single statement so two isolates cannot both start a
 * listing for the same provider.
 */

/**
 * Claims the provider for one reconciliation run.
 *
 * Succeeds when the provider is due (`next_attempt_at` passed), no lease is
 * held, or the caller explicitly forces a check. A lease left behind by a
 * crashed Worker expires instead of blocking all future runs.
 *
 * Bind order: provider_id, now, lease_until, now (updated_at), force, now, now.
 */
export const CLAIM_STORAGE_RECONCILIATION_SQL = `
INSERT INTO storage_reconciliation (
  provider_id, last_started_at, last_finished_at, last_success_at,
  next_attempt_at, lease_until, last_error, consecutive_failures, updated_at
)
VALUES (?, ?, NULL, NULL, NULL, ?, NULL, 0, ?)
ON CONFLICT(provider_id) DO UPDATE SET
  last_started_at = excluded.last_started_at,
  lease_until = excluded.lease_until,
  updated_at = excluded.updated_at
WHERE
  (? = 1 OR storage_reconciliation.next_attempt_at IS NULL OR storage_reconciliation.next_attempt_at <= ?)
  AND (storage_reconciliation.lease_until IS NULL OR storage_reconciliation.lease_until <= ?)
`;

/**
 * Records the outcome and schedules the next attempt.
 *
 * Bind order: finished_at, success, finished_at, next_attempt_at, last_error,
 * success, failure, now, provider_id.
 *
 * A failure never clears `last_success_at`, so "last verified" stays truthful
 * even while the provider is unreachable.
 */
export const FINISH_STORAGE_RECONCILIATION_SQL = `
UPDATE storage_reconciliation
SET last_finished_at = ?,
    last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
    next_attempt_at = ?,
    lease_until = NULL,
    last_error = ?,
    consecutive_failures = CASE
      WHEN ? = 1 THEN 0
      WHEN ? = 1 THEN consecutive_failures + 1
      ELSE consecutive_failures
    END,
    updated_at = ?
WHERE provider_id = ?
`;
