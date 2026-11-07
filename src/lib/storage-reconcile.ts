import * as db from './db';
import { reconcileProviderMeasurement, type ProviderReconciliationMeasurement } from './storage-pool';
import { storageProviders } from './storage-providers';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function envMs(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name]);
  return Math.max(minimum, Number.isFinite(parsed) && parsed > 0 ? parsed : fallback);
}

/** How long a successful reconciliation is trusted before the next one. */
export const RECONCILE_INTERVAL_MS = envMs(
  'AC_STORAGE_RECONCILE_INTERVAL_MS',
  DAY_MS,
  HOUR_MS,
);
/** Delay after a failed listing. A failure is retried before the daily slot. */
export const RECONCILE_RETRY_MS = envMs(
  'AC_STORAGE_RECONCILE_RETRY_MS',
  6 * HOUR_MS,
  5 * MINUTE_MS,
);
/** Delay when an active upload made a listing unsafe to apply. */
export const RECONCILE_DEFER_MS = envMs(
  'AC_STORAGE_RECONCILE_DEFER_MS',
  15 * MINUTE_MS,
  MINUTE_MS,
);
/**
 * Lease held while one Worker lists a provider. Longer than the S3 request
 * timeout so a healthy slow run is not stolen, short enough that a crashed
 * Worker cannot block reconciliation.
 */
export const RECONCILE_LEASE_MS = envMs(
  'AC_STORAGE_RECONCILE_LEASE_MS',
  2 * MINUTE_MS,
  MINUTE_MS,
);

export type ReconciliationStatus =
  | 'reconciled'
  | 'deferred'
  | 'skipped'
  | 'failed'
  | 'superseded';

export interface ProviderReconciliationResult {
  providerId: string;
  status: ReconciliationStatus;
  /** Null when no listing happened (skipped, deferred or failed). */
  usedBytes: number | null;
  error: string | null;
  nextAttemptAt: string | null;
}

export interface ReconciliationReport {
  startedAt: string;
  finishedAt: string;
  results: ProviderReconciliationResult[];
  reconciled: number;
  deferred: number;
  skipped: number;
  failed: number;
  superseded: number;
}

/**
 * Reconciles every configured provider at most once per interval.
 *
 * The claim is a single SQL statement, so concurrent requests (an external
 * cron plus dashboard safety nets) cannot both list a provider. A failed or
 * deferred run releases its lease and schedules a bounded retry; a successful
 * run is not repeated until the interval passes.
 */
export async function reconcileStorageProviders(
  options: { providerIds?: string[]; force?: boolean; now?: number } = {},
): Promise<ReconciliationReport> {
  const startedMs = options.now ?? Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const configured = storageProviders();
  const requested = options.providerIds ? new Set(options.providerIds) : null;
  const selected = requested
    ? configured.filter((provider) => requested.has(provider.id))
    : configured;
  const results: ProviderReconciliationResult[] = [];

  for (const provider of selected) {
    const claimed = await db
      .claimStorageReconciliation({
        providerId: provider.id,
        now: startedAt,
        leaseUntil: new Date(startedMs + RECONCILE_LEASE_MS).toISOString(),
        force: options.force === true,
      })
      .catch(() => false);

    if (!claimed) {
      const record = await db.getStorageReconciliation(provider.id).catch(() => null);
      results.push({
        providerId: provider.id,
        status: 'skipped',
        usedBytes: null,
        error: null,
        nextAttemptAt: record?.nextAttemptAt ?? null,
      });
      continue;
    }

    let measurement: ProviderReconciliationMeasurement | null = null;
    let status: ReconciliationStatus = 'failed';
    let error: string | null = null;
    try {
      measurement = await reconcileProviderMeasurement(provider.id);
      if (!measurement) {
        error = 'The provider is no longer configured.';
      } else {
        switch (measurement.outcome) {
          case 'applied':
            status = 'reconciled';
            break;
          case 'deferred':
            status = 'deferred';
            error =
              'Deferred: an upload reservation is active, so a listing could count in-flight bytes twice.';
            break;
          case 'superseded':
            status = 'superseded';
            error = 'A newer measurement completed first; its numbers were kept.';
            break;
          default:
            status = 'failed';
            error = measurement.error ?? 'The provider could not be measured.';
            break;
        }
      }
    } catch (caught) {
      status = 'failed';
      error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 500);
    }

    const success = status === 'reconciled';
    const nextAttemptMs =
      startedMs +
      (success
        ? RECONCILE_INTERVAL_MS
        : status === 'deferred'
          ? RECONCILE_DEFER_MS
          : RECONCILE_RETRY_MS);
    const nextAttemptAt = new Date(nextAttemptMs).toISOString();
    await db
      .finishStorageReconciliation({
        providerId: provider.id,
        finishedAt: new Date().toISOString(),
        success,
        nextAttemptAt,
        error,
      })
      .catch(() => undefined);

    results.push({
      providerId: provider.id,
      status,
      usedBytes: measurement?.usedBytes ?? null,
      error,
      nextAttemptAt,
    });
  }

  const count = (status: ReconciliationStatus): number =>
    results.filter((result) => result.status === status).length;

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    reconciled: count('reconciled'),
    deferred: count('deferred'),
    skipped: count('skipped'),
    failed: count('failed'),
    superseded: count('superseded'),
  };
}
