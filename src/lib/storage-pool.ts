import { randomUUID } from 'node:crypto';
import * as db from './db';
import {
  providerById,
  providerObjectPath,
  STORAGE_PROVIDER_DEFINITIONS,
  storagePoolConfigured,
  storageProviders,
  storageTargetBytes,
  type StorageProviderConfig,
} from './storage-providers';
import {
  s3AbortMultipart,
  s3CompleteMultipart,
  s3CreateMultipart,
  s3DeleteObject,
  s3HeadBucket,
  s3HeadObject,
  s3ListObjects,
  s3PutObject,
  s3UploadPart,
  type S3Config,
  type S3Part,
} from './s3-client';
import type { StorageObjectKind, StorageObjectRecord } from './db-sqlite';
import type { ProjectFileDeletion, StorageProviderUsage, StorageUsage } from './storage-types';

export class StoragePoolCapacityError extends Error {
  readonly code = 'insufficient_storage';

  constructor(message: string) {
    super(message);
    this.name = 'StoragePoolCapacityError';
  }
}

export class StoragePoolUnavailableError extends Error {
  readonly code = 'storage_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'StoragePoolUnavailableError';
  }
}

interface ProviderMeasurement {
  provider: StorageProviderConfig;
  verified: boolean;
  usedBytes: number | null;
  objectCount: number | null;
  /** Complete AutoClipper objects in the D1 ledger. */
  appBytes: number;
  /** Other objects in this bucket that are not AutoClipper's complete objects. */
  externalBytes: number | null;
  /** Active reservation/multipart bytes for this provider. */
  reservedBytes: number;
  pendingUploads: number;
  error: string | null;
  /** Last successful measurement, retained across an outage. */
  measuredAt: string | null;
  /** True only when this call listed the provider and applied the result. */
  listedNow: boolean;
  /** How this measurement was produced, for the reconciliation report. */
  outcome: 'applied' | 'cached' | 'deferred' | 'failed' | 'superseded';
}

interface MeasurementCacheEntry {
  value: ProviderMeasurement;
  at: number;
}

const g = globalThis as unknown as {
  __acStorageMeasurements?: Map<string, MeasurementCacheEntry>;
};

const measurementCache = (g.__acStorageMeasurements ??= new Map());

/** Test helper: force the next provider measurement to hit the provider. */
export function resetStorageMeasurementCache(): void {
  measurementCache.clear();
}
/**
 * Listing objects is a Class A operation, and Tigris includes only 10,000 of
 * those per month. Automatic refreshes are deliberately rare, and an upload
 * reservation never lists at all once provider state exists.
 */
const MEASUREMENT_TTL_MS = Math.max(
  60_000,
  Number(process.env.AC_STORAGE_MEASURE_TTL_MS) || 30 * 60 * 1000,
);
const FAILED_MEASUREMENT_TTL_MS = Math.max(
  5_000,
  Number(process.env.AC_STORAGE_FAILED_MEASURE_TTL_MS) || 5 * 60 * 1000,
);
/**
 * Minimum gap between explicit refresh listings. This is a deployment-wide
 * budget guard, not just double-click protection: any signed-in user can press
 * "Refresh storage", and a 15-second cooldown would let them exhaust Tigris's
 * 10,000 monthly Class A allowance within days. Ten minutes still keeps the
 * button useful and caps forced listings at roughly 4,300 per provider/month.
 */
const LIST_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.AC_STORAGE_LIST_COOLDOWN_MS) || 10 * 60 * 1000,
);

/**
 * 'reconcile' is the once-per-day refresh. It ignores the dashboard TTL (that
 * is the point of a daily check) but still never lists while an upload holds a
 * reservation, and it writes through a compare-and-set.
 */
type MeasurementReason = 'reservation' | 'dashboard' | 'force' | 'reconcile';

function s3Config(provider: StorageProviderConfig): S3Config {
  return {
    endpoint: provider.endpoint,
    region: provider.region,
    bucket: provider.bucket,
    accessKeyId: provider.accessKeyId,
    secretAccessKey: provider.secretAccessKey,
    sessionToken: provider.sessionToken,
    forcePathStyle: provider.forcePathStyle,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function measurementKey(provider: StorageProviderConfig): string {
  return `${provider.id}|${provider.endpoint}|${provider.bucket}`;
}

async function measureProvider(
  provider: StorageProviderConfig,
  options: { reason?: MeasurementReason } = {},
): Promise<ProviderMeasurement> {
  const reason = options.reason ?? 'dashboard';
  const key = measurementKey(provider);
  const cached = measurementCache.get(key);
  const ttl = cached?.value.verified ? MEASUREMENT_TTL_MS : FAILED_MEASUREMENT_TTL_MS;
  if (reason !== 'force' && reason !== 'reconcile' && cached && Date.now() - cached.at < ttl) {
    return cached.value;
  }

  const [complete, reservations, previousState] = await Promise.all([
    db.sumStorageObjectsByProvider(provider.id),
    db.sumActiveStorageReservationsByProvider(provider.id),
    db.getStorageProviderState(provider.id),
  ]);

  // Persist the measurement TTL in D1 as well as in this isolate. Without the
  // distributed copy, every Worker instance would list every bucket and burn
  // through free-tier request allowances. Uploads still make a real signed S3
  // request and a failed PUT releases its reservation.
  const persisted = (
    verified: boolean,
    usedBytes: number | null,
    measuredAt: string | null,
    error: string | null,
    outcome: ProviderMeasurement['outcome'] = 'cached',
  ): ProviderMeasurement => ({
    provider,
    verified,
    usedBytes,
    objectCount: null,
    appBytes: complete.bytes,
    externalBytes: previousState?.externalBytes ?? null,
    reservedBytes: reservations.bytes,
    pendingUploads: reservations.count,
    error,
    measuredAt,
    listedNow: false,
    outcome,
  });

  const persistState = async (state: {
    listedBytes: number;
    externalBytes: number;
    verified: boolean;
    measuredAt: string | null;
    lastError: string | null;
  }): Promise<boolean> => {
    if (reason === 'reconcile') {
      // Compare-and-set against the row this run read: a dashboard refresh that
      // finished while the listing was in flight is newer than this result.
      return db.compareAndSetStorageProviderState({
        providerId: provider.id,
        ...state,
        expectedUpdatedAt: previousState?.updatedAt ?? null,
      });
    }
    await db.setStorageProviderState({ providerId: provider.id, ...state });
    return true;
  };

  // A daily listing must not run while bytes are reserved. An in-flight object
  // can appear in the listing while its full size is also reserved, so the two
  // numbers would describe the same bytes twice. Defer instead of guessing.
  if (reason === 'reconcile' && reservations.count > 0) {
    return persisted(
      previousState?.verified ?? false,
      previousState?.verified ? Math.max(complete.bytes, previousState.listedBytes) : null,
      previousState?.measuredAt ?? null,
      previousState?.verified ? null : (previousState?.lastError ?? null),
      'deferred',
    );
  }

  // A reservation must never trigger a listing. The D1 ledger plus the last
  // listed total already bound the cap, and listing per upload would exhaust
  // Tigris's monthly Class A allowance within days.
  if (reason === 'reservation' && previousState) {
    return persisted(
      previousState.verified,
      previousState.verified ? Math.max(complete.bytes, previousState.listedBytes) : null,
      previousState.measuredAt,
      previousState.verified ? null : previousState.lastError,
    );
  }

  const lastMeasuredAt = previousState?.measuredAt
    ? new Date(previousState.measuredAt).getTime()
    : 0;
  const age = lastMeasuredAt > 0 ? Date.now() - lastMeasuredAt : Number.POSITIVE_INFINITY;
  // Dashboard reads refresh on the long TTL; an explicit refresh still has a
  // short cooldown so repeated clicks cannot fan out into repeated listings.
  const minimumInterval =
    reason === 'reconcile' ? 0 : reason === 'force' ? LIST_COOLDOWN_MS : MEASUREMENT_TTL_MS;
  if (previousState?.verified && age < minimumInterval) {
    return persisted(
      true,
      Math.max(complete.bytes, previousState.listedBytes),
      previousState.measuredAt,
      null,
    );
  }

  let measurement: ProviderMeasurement;
  try {
    await s3HeadBucket(s3Config(provider));
    // Count the entire dedicated bucket, not only app-prefixed keys. An
    // unrelated object still consumes the provider's free allowance, so
    // excluding it could let the allocator overshoot the safety ceiling.
    const listing = await s3ListObjects(s3Config(provider), '');
    const usedBytes = listing.objects.reduce((total, object) => total + object.size, 0);
    const externalBytes = Math.max(0, usedBytes - complete.bytes);
    const measuredAt = new Date().toISOString();
    // Re-check reservations after the listing: one may have started while the
    // listing ran, which would make its numbers ambiguous against the caps.
    const activeAfterListing =
      reason === 'reconcile'
        ? await db.sumActiveStorageReservationsByProvider(provider.id)
        : null;
    if (activeAfterListing && activeAfterListing.count > 0) {
      const fresh = await db.getStorageProviderState(provider.id);
      return persisted(
        fresh?.verified ?? false,
        fresh?.verified ? Math.max(complete.bytes, fresh.listedBytes) : null,
        fresh?.measuredAt ?? null,
        fresh?.verified ? null : (fresh?.lastError ?? null),
        'deferred',
      );
    }
    const applied = await persistState({
      listedBytes: usedBytes,
      externalBytes,
      verified: true,
      measuredAt,
      lastError: null,
    });
    if (!applied) {
      // Another measurement won the write. Report its numbers rather than
      // overwriting a fresher result with this one.
      const fresh = await db.getStorageProviderState(provider.id);
      measurement = persisted(
        fresh?.verified ?? false,
        fresh?.verified ? Math.max(complete.bytes, fresh.listedBytes) : null,
        fresh?.measuredAt ?? null,
        fresh?.verified ? null : (fresh?.lastError ?? null),
        'superseded',
      );
    } else {
      measurement = {
        provider,
        verified: true,
        usedBytes,
        objectCount: listing.objects.length,
        appBytes: complete.bytes,
        externalBytes,
        reservedBytes: reservations.bytes,
        pendingUploads: reservations.count,
        error: null,
        measuredAt,
        listedNow: true,
        outcome: 'applied',
      };
    }
  } catch (error) {
    const message = errorMessage(error);
    // Preserve the last successful external-bytes baseline. Replacing it with
    // zero after an outage would undercount capacity if a reservation were
    // somehow attempted before the next successful listing.
    await persistState({
      listedBytes: previousState?.listedBytes ?? 0,
      externalBytes: previousState?.externalBytes ?? 0,
      verified: false,
      measuredAt: previousState?.measuredAt ?? null,
      lastError: message,
    }).catch(() => false);
    measurement = {
      provider,
      verified: false,
      usedBytes: null,
      objectCount: null,
      appBytes: complete.bytes,
      externalBytes: previousState?.externalBytes ?? null,
      reservedBytes: reservations.bytes,
      pendingUploads: reservations.count,
      error: message,
      measuredAt: previousState?.measuredAt ?? null,
      listedNow: false,
      outcome: 'failed',
    };
  }
  measurementCache.set(key, { value: measurement, at: Date.now() });
  return measurement;
}

async function measurePool(
  options: { reason?: MeasurementReason } = {},
): Promise<ProviderMeasurement[]> {
  return Promise.all(storageProviders().map((provider) => measureProvider(provider, options)));
}


export function storageObjectPath(object: StorageObjectRecord): string {
  return providerObjectPath(object.providerId as StorageProviderConfig['id'], object.key);
}


interface ReservationInput {
  ownerId: string;
  projectId: string;
  clipId?: string | null;
  kind: StorageObjectKind;
  assetKey: string;
  key: string;
  contentType: string;
  expectedBytes: number;
  uploadId?: string | null;
  partSize?: number | null;
  totalParts?: number | null;
}

interface Reservation {
  provider: StorageProviderConfig;
  record: StorageObjectRecord;
  /** A completed idempotent retry does not upload again. */
  completed: boolean;
}

const RESERVATION_TTL_MS = Math.max(
  60_000,
  Number(process.env.AC_STORAGE_RESERVATION_TTL_MS) || 24 * 60 * 60 * 1000,
);

/**
 * Provider attempts per logical upload. One attempt per provider by default,
 * bounded so a future provider list cannot turn one failure into a long storm.
 */
const MAX_UPLOAD_ATTEMPTS = Math.max(
  1,
  Math.min(5, Number(process.env.AC_UPLOAD_PROVIDER_ATTEMPTS) || 3),
);

async function releaseObjectReservation(objectId: string): Promise<void> {
  await db.releaseActiveReservationsForObject(objectId).catch(() => undefined);
}

/** Returns true only after deletion is confirmed absent. */
async function discardObject(provider: StorageProviderConfig, key: string): Promise<boolean> {
  try {
    await s3DeleteObject(s3Config(provider), key);
    return !(await s3HeadObject(s3Config(provider), key));
  } catch {
    return false;
  }
}

/**
 * Select a provider and reserve the bytes in one atomic SQL write. The old
 * process-local mutex could not coordinate requests handled by different
 * Worker isolates, so it has been removed entirely.
 */
async function reserveUpload(
  input: ReservationInput,
  excluded: ReadonlySet<string> = new Set(),
): Promise<Reservation> {
  // Expired multipart sessions are cleaned before adding a new reservation.
  // The limit keeps a normal upload from listing every abandoned session.
  await cleanupExpiredStorageUploads(5).catch(() => undefined);
  // Reservations read persisted state only: no provider listing is performed
  // here, so retries and failover cannot inflate the LIST request count.
  const measurements = await measurePool({ reason: 'reservation' });
  if (measurements.length === 0) {
    throw new StoragePoolUnavailableError('No S3 storage providers are configured.');
  }
  const target = storageTargetBytes();
  const reasons: string[] = [];

  for (const measurement of measurements) {
    const { provider } = measurement;
    if (excluded.has(provider.id)) continue;
    if (!measurement.verified) {
      reasons.push(`${provider.label} is unavailable`);
      continue;
    }

    const baseIdempotencyKey = `${input.assetKey}:${provider.id}`;
    const previous = await db.getStorageObjectByIdempotencyKey(baseIdempotencyKey);
    if (
      previous?.status === 'complete' &&
      previous.key === input.key &&
      previous.bytes === input.expectedBytes
    ) {
      return { provider, record: previous, completed: true };
    }

    if (previous && previous.status !== 'complete') {
      if (previous.uploadId) {
        try {
          await s3AbortMultipart(s3Config(provider), previous.key, previous.uploadId);
        } catch (error) {
          reasons.push(`${provider.label} could not discard an old multipart session: ${errorMessage(error)}`);
          continue;
        }
      } else if (previous.status === 'uploading') {
        // A direct PUT failed after the provider may have accepted part of the
        // body. Do not reserve again until that ambiguous object is gone.
        if (!(await discardObject(provider, previous.key))) {
          reasons.push(`${provider.label} could not remove an incomplete prior upload`);
          continue;
        }
      }
      await releaseObjectReservation(previous.id);
    }

    const objectId = previous && previous.status !== 'complete' ? previous.id : randomUUID();
    const reservation = await db.tryReserveStorageCapacity({
      id: randomUUID(),
      reservationKey: `${objectId}:${randomUUID()}`,
      storageObjectId: objectId,
      projectId: input.projectId,
      providerId: provider.id,
      bytes: input.expectedBytes,
      expiresAt: new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
      providerSafeLimitBytes: provider.safeLimitBytes,
      targetBytes: target,
    });
    if (!reservation) {
      const used = (measurement.usedBytes ?? 0) + measurement.reservedBytes;
      const providerAvailable = Math.max(0, provider.safeLimitBytes - used);
      reasons.push(
        `${provider.label} has ${providerAvailable} bytes available but this upload needs ${input.expectedBytes}`,
      );
      continue;
    }

    try {
      // Keep one ledger row per asset/provider across failed retries. Route
      // callers version the object key itself, so this does not prevent a
      // genuinely new render from being stored.
      const idempotencyKey =
        previous && previous.status !== 'complete'
          ? previous.idempotencyKey
          : previous?.status === 'complete'
            ? `${baseIdempotencyKey}:${objectId}`
            : baseIdempotencyKey;
      const record = await db.upsertStorageObject({
        id: objectId,
        idempotencyKey,
        ownerId: input.ownerId,
        projectId: input.projectId,
        clipId: input.clipId ?? null,
        kind: input.kind,
        providerId: provider.id,
        bucket: provider.bucket,
        key: input.key,
        bytes: input.expectedBytes,
        contentType: input.contentType,
        status: 'uploading',
        attempts: (previous?.attempts ?? 0) + 1,
        lastError: null,
        uploadId: input.uploadId ?? null,
        partSize: input.partSize ?? null,
        expectedBytes: input.expectedBytes,
        totalParts: input.totalParts ?? null,
      });
      measurementCache.delete(measurementKey(provider));
      return { provider, record, completed: false };
    } catch (error) {
      await db.releaseStorageReservation(reservation.id).catch(() => undefined);
      throw error;
    }
  }

  if (measurements.some((measurement) => measurement.verified)) {
    throw new StoragePoolCapacityError(
      `The configured storage safety target has no room for this upload. ${reasons.join('; ')}.`,
    );
  }
  throw new StoragePoolUnavailableError(
    `No storage provider is currently reachable. ${reasons.join('; ')}.`,
  );
}

export async function uploadStorageObject(input: {
  ownerId: string;
  projectId: string;
  clipId?: string | null;
  kind: StorageObjectKind;
  assetKey: string;
  key: string;
  contentType: string;
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
  expectedBytes: number | null;
}): Promise<StorageObjectRecord> {
  if (input.expectedBytes !== null && input.expectedBytes <= 0) {
    throw new Error('The upload is empty.');
  }

  const tried = new Set<string>();
  let lastError: unknown = null;
  // A ReadableStream can only be read once. While another provider might still
  // be tried, tee the body so a failed attempt leaves a replayable branch
  // instead of uploading a half-consumed stream.
  let pendingBody: ReadableStream<Uint8Array> = input.body;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    const candidates = storageProviders().filter((provider) => !tried.has(provider.id));
    if (candidates.length === 0) break;

    const reservation = await reserveUpload(
      {
        ownerId: input.ownerId,
        projectId: input.projectId,
        clipId: input.clipId ?? null,
        kind: input.kind,
        assetKey: input.assetKey,
        key: input.key,
        contentType: input.contentType,
        expectedBytes: input.expectedBytes ?? input.maxBytes,
      },
      tried,
    );
    if (reservation.completed) return reservation.record;

    let attemptBody = pendingBody;
    if (candidates.length > 1) {
      const [current, replay] = pendingBody.tee();
      attemptBody = current;
      pendingBody = replay;
    }

    try {
      await s3PutObject(
        s3Config(reservation.provider),
        input.key,
        attemptBody,
        input.maxBytes,
        input.contentType,
        input.expectedBytes,
      );
      const head = await s3HeadObject(s3Config(reservation.provider), input.key);
      if (!head || head.size <= 0) throw new Error('The provider did not receive a complete object.');
      if (input.expectedBytes !== null && head.size !== input.expectedBytes) {
        throw new Error(`Provider verification found ${head.size} bytes; expected ${input.expectedBytes}.`);
      }
      const completedAt = new Date().toISOString();
      await db.updateStorageObject(reservation.record.id, {
        bytes: head.size,
        status: 'complete',
        lastError: null,
        completedAt,
      });
      await releaseObjectReservation(reservation.record.id);
      measurementCache.delete(measurementKey(reservation.provider));
      return (await db.getStorageObject(reservation.record.id)) as StorageObjectRecord;
    } catch (error) {
      lastError = error;
      // A rejected PUT can still have stored bytes. Always confirm absence
      // before releasing, and never fail over while an object may remain: an
      // orphan on the old provider would be untracked and uncounted.
      if (!(await discardObject(reservation.provider, input.key))) {
        await db
          .updateStorageObject(reservation.record.id, {
            status: 'uploading',
            lastError: `${errorMessage(error)} The provider would not confirm removal, so the bytes remain reserved and no failover was attempted.`,
          })
          .catch(() => undefined);
        measurementCache.delete(measurementKey(reservation.provider));
        throw error;
      }
      try {
        await db.updateStorageObject(reservation.record.id, {
          status: 'failed',
          lastError: errorMessage(error),
        });
      } finally {
        // Always release once removal is confirmed, even if the ledger write
        // fails; an active reservation must never outlive its object.
        await releaseObjectReservation(reservation.record.id);
      }
      measurementCache.delete(measurementKey(reservation.provider));
      tried.add(reservation.provider.id);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('No storage provider accepted this upload.');
}

export async function startMultipartStorageObject(input: {
  ownerId: string;
  projectId: string;
  kind: StorageObjectKind;
  assetKey: string;
  key: string;
  contentType: string;
  expectedBytes: number;
  partSize: number;
  totalParts: number;
}): Promise<{ providerId: string; uploadId: string; record: StorageObjectRecord }> {
  const tried = new Set<string>();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    if (storageProviders().every((provider) => tried.has(provider.id))) break;

    const reservation = await reserveUpload(
      {
        ownerId: input.ownerId,
        projectId: input.projectId,
        kind: input.kind,
        assetKey: input.assetKey,
        key: input.key,
        contentType: input.contentType,
        expectedBytes: input.expectedBytes,
        partSize: input.partSize,
        totalParts: input.totalParts,
      },
      tried,
    );
    if (reservation.completed) throw new Error('This upload was already completed.');

    let uploadId: string | null = null;
    try {
      uploadId = await s3CreateMultipart(
        s3Config(reservation.provider),
        input.key,
        input.contentType,
      );
      await db.updateStorageObject(reservation.record.id, {
        uploadId,
        status: 'uploading',
        lastError: null,
      });
      measurementCache.delete(measurementKey(reservation.provider));
      return {
        providerId: reservation.provider.id,
        uploadId,
        record: (await db.getStorageObject(reservation.record.id)) as StorageObjectRecord,
      };
    } catch (error) {
      lastError = error;
      if (uploadId) {
        await s3AbortMultipart(s3Config(reservation.provider), input.key, uploadId).catch(
          () => undefined,
        );
      }
      if (!(await discardObject(reservation.provider, input.key))) {
        await db
          .updateStorageObject(reservation.record.id, {
            status: 'uploading',
            lastError: `${errorMessage(error)} The provider would not confirm removal, so the bytes remain reserved and no failover was attempted.`,
          })
          .catch(() => undefined);
        measurementCache.delete(measurementKey(reservation.provider));
        throw error;
      }
      try {
        await db.updateStorageObject(reservation.record.id, {
          status: 'failed',
          uploadId: null,
          lastError: errorMessage(error),
        });
      } finally {
        await releaseObjectReservation(reservation.record.id);
      }
      measurementCache.delete(measurementKey(reservation.provider));
      tried.add(reservation.provider.id);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('No storage provider accepted this upload.');
}

async function multipartRecord(projectId: string, uploadId: string): Promise<{
  record: StorageObjectRecord;
  provider: StorageProviderConfig;
}> {
  const record = await db.getStorageObjectByUploadId(projectId, uploadId);
  if (!record) throw new Error('Upload session not found.');
  const provider = providerById(record.providerId);
  if (!provider) throw new Error('The upload provider is no longer configured.');
  return { record, provider };
}

export async function uploadMultipartPart(
  projectId: string,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer,
): Promise<S3Part> {
  const { record, provider } = await multipartRecord(projectId, uploadId);
  // A session may only accept the parts its declared size implies. Without
  // this, a caller could keep uploading parts far past the reserved bytes,
  // consuming provider quota the capacity ledger never accounted for.
  if (record.status !== 'uploading') throw new Error('This upload is not accepting parts.');
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    throw new Error('Invalid upload part number.');
  }
  if (record.totalParts !== null && partNumber > record.totalParts) {
    throw new Error(
      `Part ${partNumber} is beyond the ${record.totalParts} parts this upload declared.`,
    );
  }
  if (record.partSize !== null && body.byteLength > record.partSize + 1024) {
    throw new Error(`Part ${partNumber} exceeds the ${record.partSize}-byte part size.`);
  }
  let lastError: unknown = null;
  // A failed part is independent of the rest of the multipart session. Retry
  // the same part number; S3 replaces that part, so this cannot duplicate data.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const part = await s3UploadPart(s3Config(provider), record.key, uploadId, partNumber, body);
      measurementCache.delete(measurementKey(provider));
      return part;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Upload part ${partNumber} failed.`);
}

export async function completeMultipartStorageObject(
  projectId: string,
  uploadId: string,
  parts: S3Part[],
): Promise<{ record: StorageObjectRecord; provider: StorageProviderConfig }> {
  const { record, provider } = await multipartRecord(projectId, uploadId);
  let completeError: unknown = null;
  try {
    await s3CompleteMultipart(s3Config(provider), record.key, uploadId, parts);
  } catch (error) {
    completeError = error;
  }

  // A lost completion response is recoverable: if the assembled object is
  // present at the expected size, finish the D1 transition instead of retrying
  // completion and creating a duplicate object.
  const head = await s3HeadObject(s3Config(provider), record.key).catch(() => null);
  const sizeMatches = Boolean(
    head &&
      head.size > 0 &&
      (record.expectedBytes === null || head.size === record.expectedBytes),
  );
  if (sizeMatches && head) {
    await db.updateStorageObject(record.id, {
      bytes: head.size,
      status: 'complete',
      lastError: null,
      completedAt: new Date().toISOString(),
    });
    await releaseObjectReservation(record.id);
    measurementCache.delete(measurementKey(provider));
    return {
      record: (await db.getStorageObject(record.id)) as StorageObjectRecord,
      provider,
    };
  }

  // Keep the multipart session and its reservation alive. The caller can
  // retry a failed part and completion without orphaning or double-counting.
  const message = completeError
    ? errorMessage(completeError)
    : head
      ? `Provider verification found ${head.size} bytes; expected ${record.expectedBytes ?? 'the declared size'}.`
      : 'The provider did not return the completed object.';

  // If completion produced an object with the wrong size, it is unusable.
  // Remove it (and any multipart remnants) before releasing the reservation.
  // A transient completion failure with no object keeps the session alive so
  // the caller can retry parts/completion instead of losing uploaded bytes.
  if (head) {
    const removed = await discardObject(provider, record.key);
    if (removed) {
      await s3AbortMultipart(s3Config(provider), record.key, uploadId).catch(() => undefined);
      await db.updateStorageObject(record.id, {
        status: 'failed',
        uploadId: null,
        lastError: message,
      }).catch(() => undefined);
      await releaseObjectReservation(record.id);
      measurementCache.delete(measurementKey(provider));
      throw new Error(message);
    }
  }
  await db.updateStorageObject(record.id, {
    status: 'uploading',
    uploadId,
    lastError: message,
  }).catch(() => undefined);
  measurementCache.delete(measurementKey(provider));
  throw completeError instanceof Error ? completeError : new Error(message);
}

export async function abortMultipartStorageObject(
  projectId: string,
  uploadId: string,
): Promise<void> {
  const { record, provider } = await multipartRecord(projectId, uploadId);
  if (record.status === 'complete') return;
  try {
    await s3AbortMultipart(s3Config(provider), record.key, uploadId);
    // Abort removes parts, but a previously completed object at this key is
    // separate. Confirm it is absent before releasing capacity; versioned keys
    // mean this cannot touch a prior project source/clip.
    if (!(await discardObject(provider, record.key))) {
      throw new Error('The multipart session was aborted but its object could not be removed.');
    }
    await db.updateStorageObject(record.id, {
      status: 'failed',
      lastError: 'Upload aborted.',
      uploadId: null,
    });
    await releaseObjectReservation(record.id);
    measurementCache.delete(measurementKey(provider));
  } catch (error) {
    // The provider did not confirm the abort, so the bytes are still reserved.
    await db
      .updateStorageObject(record.id, {
        status: 'uploading',
        lastError: errorMessage(error),
      })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Releases expired reservations and aborts abandoned multipart sessions. It is
 * safe to call from any Worker; only expired rows are considered and every
 * provider abort is confirmed before capacity is released.
 */
export async function cleanupExpiredStorageUploads(limit = 25): Promise<{
  released: number;
  aborted: number;
  errors: string[];
}> {
  const expired = await db.getExpiredStorageReservations(new Date().toISOString(), limit);
  let released = 0;
  let aborted = 0;
  const errors: string[] = [];
  for (const reservation of expired) {
    const record = await db.getStorageObject(reservation.storageObjectId);
    if (!record || record.status === 'complete') {
      await db.releaseStorageReservation(reservation.id);
      released += 1;
      continue;
    }
    const provider = providerById(record.providerId);
    if (!provider) {
      errors.push(`${record.id}: ${record.providerId} is no longer configured; reservation retained.`);
      continue;
    }
    if (record.uploadId) {
      try {
        await s3AbortMultipart(s3Config(provider), record.key, record.uploadId);
        aborted += 1;
        if (!(await discardObject(provider, record.key))) {
          throw new Error('Multipart session was aborted but its object could not be removed.');
        }
      } catch (error) {
        await db
          .updateStorageObject(record.id, {
            status: 'uploading',
            lastError: `Abandoned upload could not be aborted: ${errorMessage(error)}`,
          })
          .catch(() => undefined);
        errors.push(`${record.id}: ${errorMessage(error)}`);
        continue;
      }
    } else if (!(await discardObject(provider, record.key))) {
      await db
        .updateStorageObject(record.id, {
          status: 'uploading',
          lastError: 'Abandoned upload could not be removed; capacity remains reserved.',
        })
        .catch(() => undefined);
      errors.push(`${record.id}: abandoned object could not be removed.`);
      continue;
    }
    await db.updateStorageObject(record.id, {
      status: 'failed',
      uploadId: null,
      lastError: 'Upload reservation expired and the upload was cleaned up.',
    });
    await db.releaseStorageReservation(reservation.id);
    released += 1;
    measurementCache.delete(measurementKey(provider));
  }
  return { released, aborted, errors };
}

export async function verifyStorageObject(
  object: StorageObjectRecord,
): Promise<{ exists: boolean; size: number }> {
  const provider = providerById(object.providerId);
  if (!provider) {
    throw new StoragePoolUnavailableError(`${object.providerId} storage is no longer configured.`);
  }
  const head = await s3HeadObject(s3Config(provider), object.key);
  return { exists: Boolean(head && head.size > 0), size: head?.size ?? 0 };
}

export async function verifyStoragePath(
  path: string,
): Promise<{ exists: boolean; size: number } | null> {
  const match = /^s3:\/\/([a-z0-9-]+)\/(.+)$/.exec(path);
  if (!match) return null;
  const provider = providerById(match[1]);
  if (!provider) throw new StoragePoolUnavailableError(`${match[1]} storage is no longer configured.`);
  const head = await s3HeadObject(s3Config(provider), match[2]);
  return { exists: Boolean(head && head.size > 0), size: head?.size ?? 0 };
}

async function removeObject(record: StorageObjectRecord): Promise<{
  ok: boolean;
  bytes: number;
  error: string | null;
}> {
  const provider = providerById(record.providerId);
  if (!provider) {
    const message = `${record.providerId} is not configured, so this object cannot be deleted.`;
    await db.updateStorageObject(record.id, { status: 'delete_failed', lastError: message }).catch(() => undefined);
    return { ok: false, bytes: 0, error: message };
  }
  if (record.uploadId) {
    try {
      await s3AbortMultipart(s3Config(provider), record.key, record.uploadId);
    } catch (error) {
      const message = `Could not abort the multipart upload: ${errorMessage(error)}`;
      await db
        .updateStorageObject(record.id, { status: 'delete_failed', lastError: message })
        .catch(() => undefined);
      return { ok: false, bytes: 0, error: message };
    }
  }
  await db.updateStorageObject(record.id, { status: 'deleting', lastError: null }).catch(() => undefined);
  try {
    await s3DeleteObject(s3Config(provider), record.key);
    const head = await s3HeadObject(s3Config(provider), record.key);
    if (head) throw new Error('The object is still present after deletion.');
    await db.deleteStorageObject(record.id);
    measurementCache.delete(measurementKey(provider));
    return { ok: true, bytes: record.bytes, error: null };
  } catch (error) {
    const message = errorMessage(error);
    await db
      .updateStorageObject(record.id, { status: 'delete_failed', lastError: message })
      .catch(() => undefined);
    return { ok: false, bytes: 0, error: message };
  }
}

/** Deletes every tracked object for a project across all configured providers. */
export async function deletePoolProjectObjects(projectId: string): Promise<ProjectFileDeletion> {
  if (!storagePoolConfigured()) {
    const records = await db.getStorageObjectsForProject(projectId);
    if (records.length === 0) {
      return { verified: true, deletedFiles: 0, failedFiles: [], bytesFreed: 0, bytesRemaining: 0 };
    }
    return {
      verified: false,
      deletedFiles: 0,
      failedFiles: records.map((record) => ({
        path: `${record.providerId}/${record.key}`,
        error: `${record.providerId} is not configured.`,
      })),
      bytesFreed: 0,
      bytesRemaining: records.reduce((total, record) => total + record.bytes, 0),
    };
  }

  const records = await db.getStorageObjectsForProject(projectId);
  if (records.length === 0) {
    return { verified: true, deletedFiles: 0, failedFiles: [], bytesFreed: 0, bytesRemaining: 0 };
  }
  let deletedFiles = 0;
  let bytesFreed = 0;
  let bytesRemaining = 0;
  const failedFiles: { path: string; error: string }[] = [];
  for (const record of records) {
    const result = await removeObject(record);
    if (result.ok) {
      deletedFiles += 1;
      bytesFreed += result.bytes;
    } else {
      bytesRemaining += record.bytes;
      failedFiles.push({ path: `${record.providerId}/${record.key}`, error: result.error ?? 'Deletion failed.' });
    }
  }
  const verified = failedFiles.length === 0;
  return {
    verified,
    deletedFiles,
    failedFiles,
    bytesFreed: verified ? bytesFreed : 0,
    bytesRemaining,
  };
}

/** Removes older complete/failed objects after a newer version is finalized. */
export async function cleanupSupersededObjects(
  clipId: string,
  kind: StorageObjectKind,
  keepId: string,
): Promise<void> {
  const records = await db.getStorageObjectsForClip(clipId);
  for (const record of records) {
    if (record.id === keepId || record.kind !== kind) continue;
    if (record.status !== 'complete' && record.status !== 'failed') continue;
    await removeObject(record).catch(() => undefined);
  }
}

/** Removes older source objects after a replacement source is verified. */
export async function cleanupSupersededSource(
  projectId: string,
  keepId: string,
): Promise<void> {
  const records = await db.getStorageObjectsForProject(projectId);
  for (const record of records) {
    if (record.id === keepId || record.kind !== 'source') continue;
    if (record.status !== 'complete' && record.status !== 'failed') continue;
    await removeObject(record).catch(() => undefined);
  }
}

export async function getLatestClipObject(
  clipId: string,
  kind: StorageObjectKind,
): Promise<StorageObjectRecord | null> {
  return db.getLatestStorageObjectForClip(clipId, kind, 'complete');
}

export async function getLatestSourceObject(projectId: string): Promise<StorageObjectRecord | null> {
  return db.getLatestStorageObjectByProject(projectId, 'source');
}

export async function getStorageObjectById(id: string): Promise<StorageObjectRecord | null> {
  return db.getStorageObject(id);
}

function providerUsage(
  definition: ReturnType<typeof storageProviders>[number] | undefined,
  measurement: ProviderMeasurement | undefined,
  providerId: string,
  label: string,
  limitBytes: number,
  reserveBytes: number,
  role: StorageProviderUsage['role'],
  reconciledAt: string | null,
): StorageProviderUsage {
  if (!definition || !measurement) {
    return {
      id: providerId,
      label,
      role,
      configured: false,
      verified: false,
      usedBytes: null,
      objectCount: null,
      appBytes: 0,
      externalBytes: null,
      reservedBytes: 0,
      pendingUploads: 0,
      limitBytes,
      reserveBytes,
      safeLimitBytes: Math.max(0, limitBytes - reserveBytes),
      availableBytes: null,
      error: 'Not configured. Add this provider’s server-side secrets to enable it.',
      measuredAt: null,
      reconciledAt,
    };
  }
  const used = measurement.verified ? measurement.usedBytes : null;
  return {
    id: definition.id,
    label: definition.label,
    role: definition.role,
    configured: true,
    verified: measurement.verified,
    usedBytes: used,
    objectCount: measurement.objectCount,
    appBytes: measurement.appBytes,
    externalBytes: measurement.externalBytes,
    reservedBytes: measurement.reservedBytes,
    pendingUploads: measurement.pendingUploads,
    limitBytes: definition.limitBytes,
    reserveBytes: definition.reserveBytes,
    safeLimitBytes: definition.safeLimitBytes,
    availableBytes:
      used === null
        ? null
        : Math.max(0, definition.safeLimitBytes - used - measurement.reservedBytes),
    error: measurement.error,
    measuredAt: measurement.measuredAt,
    reconciledAt,
  };
}

/** Actual usage for the dashboard, with no fabricated zeroes for failed providers. */
export async function getPoolStorageUsage(
  projectIds: string[],
  options: { force?: boolean } = {},
): Promise<StorageUsage> {
  if (options.force) {
    await cleanupExpiredStorageUploads(25).catch(() => undefined);
  }
  const configured = storageProviders();
  const definitions = STORAGE_PROVIDER_DEFINITIONS;
  // A forced refresh is still a dashboard read: only "force" may bypass the
  // long TTL, and even then the listing cooldown applies.
  const [measurements, reconciliations] = await Promise.all([
    measurePool({ reason: options.force ? 'force' : 'dashboard' }),
    Promise.all(
      definitions.map((definition) =>
        db.getStorageReconciliation(definition.id).catch(() => null),
      ),
    ),
  ]);
  const measurementById = new Map(measurements.map((entry) => [entry.provider.id, entry]));
  const reconciliationById = new Map(
    reconciliations
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .map((entry) => [entry.providerId, entry]),
  );
  const providers: StorageProviderUsage[] = definitions.map((definition) => {
    const config = configured.find((entry) => entry.id === definition.id);
    return providerUsage(
      config,
      measurementById.get(definition.id),
      definition.id,
      definition.label,
      config?.limitBytes ?? definition.defaultLimitBytes,
      config?.reserveBytes ?? definition.defaultReserveBytes,
      config?.role ?? definition.role,
      reconciliationById.get(definition.id)?.lastSuccessAt ?? null,
    );
  });

  const configuredCapacityBytes = configured.reduce((total, provider) => total + provider.safeLimitBytes, 0);
  const verified = measurements.filter((entry) => entry.verified);
  const verifiedCapacityBytes = verified.reduce((total, entry) => total + entry.provider.safeLimitBytes, 0);
  const totalUsedBytes = verified.reduce((total, entry) => total + (entry.usedBytes ?? 0), 0);
  const totalReservedBytes = measurements.reduce((total, entry) => total + entry.reservedBytes, 0);
  const pendingUploads = measurements.reduce((total, entry) => total + entry.pendingUploads, 0);
  const target = storageTargetBytes();
  const targetVerified = definitions.every((definition) => measurementById.get(definition.id)?.verified === true);
  const unavailable = measurements.filter((entry) => !entry.verified);
  // Never present the whole 18 GB target as available while a required
  // provider is missing or unreachable. Available follows the measured safety
  // caps of the verified providers (and the aggregate target).
  const providerAvailable = verified.reduce(
    (total, entry) =>
      total +
      Math.max(0, entry.provider.safeLimitBytes - (entry.usedBytes ?? 0) - entry.reservedBytes),
    0,
  );
  const targetRemaining = Math.max(0, target - totalUsedBytes - totalReservedBytes);
  const allocationAvailableBytes = verified.length > 0 ? Math.min(targetRemaining, providerAvailable) : 0;
  const projectBytes = await db.sumStorageObjectsByProject(projectIds);
  const failures = await db.storageFailureCounts(projectIds);
  const usageByProject = new Map<string, { used: number; source: number; clips: number; count: number }>();
  for (const projectId of projectIds) {
    usageByProject.set(projectId, { used: 0, source: 0, clips: 0, count: 0 });
  }
  for (const entry of projectBytes) {
    const usage = usageByProject.get(entry.projectId);
    if (!usage) continue;
    usage.used += entry.bytes;
    usage.count += entry.objectCount;
    if (entry.kind === 'source') usage.source += entry.bytes;
    else usage.clips += entry.bytes;
  }
  const sourceBytes = [...usageByProject.values()].reduce((total, entry) => total + entry.source, 0);
  const clipBytes = [...usageByProject.values()].reduce((total, entry) => total + entry.clips, 0);
  const fileCount = [...usageByProject.values()].reduce((total, entry) => total + entry.count, 0);
  const measuredAt = new Date().toISOString();
  const lastSuccessfulMeasurement =
    measurements
      .map((entry) => entry.measuredAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

  const missing = definitions.filter((definition) => !measurementById.has(definition.id));
  const errorParts: string[] = [];
  if (unavailable.length > 0) {
    errorParts.push(
      `Some providers could not be measured; totals exclude them. ${unavailable
        .map((entry) => `${entry.provider.label}: ${entry.error ?? 'unavailable'}`)
        .join('; ')}`,
    );
  }
  if (missing.length > 0) {
    errorParts.push(
      `Only ${configured.length} of ${definitions.length} required providers are configured. The full ${Math.round(
        target / 1_000_000_000,
      )} GB application target is not verified.`,
    );
  }
  const error = errorParts.length > 0 ? errorParts.join(' ') : null;

  return {
    available: verified.length > 0,
    backend: 'pool',
    usedBytes: totalUsedBytes,
    availableBytes: allocationAvailableBytes,
    limitBytes: target,
    sourceBytes,
    clipBytes,
    fileCount,
    projects: projectIds.map((projectId) => {
      const usage = usageByProject.get(projectId) ?? { used: 0, source: 0, clips: 0, count: 0 };
      return {
        projectId,
        usedBytes: usage.used,
        sourceBytes: usage.source,
        clipBytes: usage.clips,
        fileCount: usage.count,
      };
    }),
    error,
    measuredAt,
    providers,
    configuredCapacityBytes,
    verifiedCapacityBytes,
    unverifiedCapacityBytes: Math.max(0, configuredCapacityBytes - verifiedCapacityBytes),
    totalUsedBytes,
    totalAvailableBytes: allocationAvailableBytes,
    reservedBytes: totalReservedBytes,
    pendingUploads,
    failedUploads: failures.failedUploads,
    failedDeletions: failures.failedDeletions,
    lastSuccessfulMeasurement,
    targetVerified,
  };
}

export interface ProviderReconciliationMeasurement {
  providerId: string;
  verified: boolean;
  usedBytes: number | null;
  outcome: ProviderMeasurement['outcome'];
  deferred: boolean;
  error: string | null;
  measuredAt: string | null;
}

/**
 * One provider's daily listing. Unlike a dashboard read this ignores the TTL,
 * but it never lists while bytes are reserved and it only writes through a
 * compare-and-set, so a slow run cannot resurrect stale usage.
 */
export async function reconcileProviderMeasurement(
  providerId: string,
): Promise<ProviderReconciliationMeasurement | null> {
  const provider = storageProviders().find((entry) => entry.id === providerId);
  if (!provider) return null;
  const measurement = await measureProvider(provider, { reason: 'reconcile' });
  return {
    providerId: provider.id,
    verified: measurement.verified,
    usedBytes: measurement.usedBytes,
    outcome: measurement.outcome,
    deferred: measurement.outcome === 'deferred',
    error: measurement.error,
    measuredAt: measurement.measuredAt,
  };
}

export async function poolHasConfiguration(): Promise<boolean> {
  return storageProviders().length > 0;
}
