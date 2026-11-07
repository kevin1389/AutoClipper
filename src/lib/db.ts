import type {
  AppUser,
  AuthTokenPurpose,
  ClipPatch,
  EmailUser,
  GoogleIdentity,
  Job,
  NewProjectInput,
  ProjectPatch,
  StorageObjectRecord,
  StorageObjectStatus,
  StorageObjectKind,
  NewStorageObjectInput,
  StorageObjectPatch,
  NewStorageReservationInput,
  StorageProviderStateRecord,
  StorageReservationRecord,
  StorageReservationStatus,
  StorageReservationSummary,
  StorageReconciliationRecord,
} from './db-sqlite';
import type { ProjectJob } from './types';

/**
 * Runtime database facade.
 *
 * - On Cloudflare (a D1 `DB` binding is present) every operation is async D1.
 * - On Node (tests, local development, a VM) the original synchronous SQLite
 *   implementation is loaded dynamically, so `node:sqlite` is never imported
 *   into a Worker bundle.
 *
 * All exported operations are async, regardless of backend, to keep callers
 * identical in both environments.
 */

export type {
  AppUser,
  AuthTokenPurpose,
  ClipPatch,
  EmailUser,
  GoogleIdentity,
  Job,
  NewProjectInput,
  ProjectPatch,
  StorageObjectRecord,
  StorageObjectStatus,
  StorageObjectKind,
  NewStorageObjectInput,
  StorageObjectPatch,
  NewStorageReservationInput,
  StorageProviderStateRecord,
  StorageReservationRecord,
  StorageReservationStatus,
  StorageReservationSummary,
  StorageReconciliationRecord,
} from './db-sqlite';

interface D1Database {
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<unknown>;
}

type SqliteModule = typeof import('./db-sqlite');
type Backend = Record<string, (...args: never[]) => unknown>;

async function d1Binding(): Promise<D1Database | null> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const env = getCloudflareContext().env as { DB?: D1Database };
    return env.DB ?? null;
  } catch {
    // Local Node has no OpenNext context.
    return null;
  }
}

let d1Ready: Promise<Backend> | null = null;

async function getBackend(): Promise<Backend> {
  const binding = await d1Binding();
  if (binding) {
    if (!d1Ready) {
      d1Ready = import('./db-d1').then(async (module) => {
        module.init(binding as Parameters<typeof module.init>[0]);
        await module.ensureSchema();
        return module as unknown as Backend;
      });
    }
    return d1Ready;
  }
  return (await import('./db-sqlite')) as unknown as Backend;
}

async function call(name: string, args: unknown[]): Promise<any> {
  const backend = await getBackend();
  const fn = backend[name];
  if (typeof fn !== 'function') throw new Error(`Unknown database operation: ${name}`);
  return fn(...(args as never[]));
}

type SqliteFunction<K extends keyof SqliteModule> = SqliteModule[K] extends (
  ...args: infer A
) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

export const upsertUser: SqliteFunction<'upsertUser'> = (...args) => call('upsertUser', args);
export const getUser: SqliteFunction<'getUser'> = (...args) => call('getUser', args);
export const findUserByEmail: SqliteFunction<'findUserByEmail'> = (...args) =>
  call('findUserByEmail', args);
export const createEmailUser: SqliteFunction<'createEmailUser'> = (...args) =>
  call('createEmailUser', args);
export const findOrCreateGoogleUser: SqliteFunction<'findOrCreateGoogleUser'> = (...args) =>
  call('findOrCreateGoogleUser', args);
export const createSessionRow: SqliteFunction<'createSessionRow'> = (...args) =>
  call('createSessionRow', args);
export const getSessionUser: SqliteFunction<'getSessionUser'> = (...args) =>
  call('getSessionUser', args);
export const deleteSessionRow: SqliteFunction<'deleteSessionRow'> = (...args) =>
  call('deleteSessionRow', args);
export const revokeUserSessions: SqliteFunction<'revokeUserSessions'> = (...args) =>
  call('revokeUserSessions', args);
export const createAuthToken: SqliteFunction<'createAuthToken'> = (...args) =>
  call('createAuthToken', args);
export const consumeAuthToken: SqliteFunction<'consumeAuthToken'> = (...args) =>
  call('consumeAuthToken', args);
export const markEmailVerified: SqliteFunction<'markEmailVerified'> = (...args) =>
  call('markEmailVerified', args);
export const setUserPassword: SqliteFunction<'setUserPassword'> = (...args) =>
  call('setUserPassword', args);

export const createProject: SqliteFunction<'createProject'> = (...args) =>
  call('createProject', args);
export const getProject: SqliteFunction<'getProject'> = (...args) => call('getProject', args);
export const getProjectForOwner: SqliteFunction<'getProjectForOwner'> = (...args) =>
  call('getProjectForOwner', args);
export const assignUnownedProjects: SqliteFunction<'assignUnownedProjects'> = (...args) =>
  call('assignUnownedProjects', args);
export const countUnownedProjects: SqliteFunction<'countUnownedProjects'> = (...args) =>
  call('countUnownedProjects', args);
export const getProjectSourcePath: SqliteFunction<'getProjectSourcePath'> = (...args) =>
  call('getProjectSourcePath', args);
export const listProjects: SqliteFunction<'listProjects'> = (...args) => call('listProjects', args);
export const updateProject: SqliteFunction<'updateProject'> = (...args) =>
  call('updateProject', args);
export const deleteProject: SqliteFunction<'deleteProject'> = (...args) =>
  call('deleteProject', args);

export const saveTranscript: SqliteFunction<'saveTranscript'> = (...args) =>
  call('saveTranscript', args);
export const getTranscript: SqliteFunction<'getTranscript'> = (...args) =>
  call('getTranscript', args);
export const replaceClips: SqliteFunction<'replaceClips'> = (...args) =>
  call('replaceClips', args);
export const getClips: SqliteFunction<'getClips'> = (...args) => call('getClips', args);
export const getClipForOwner: SqliteFunction<'getClipForOwner'> = (...args) =>
  call('getClipForOwner', args);
export const getClip: SqliteFunction<'getClip'> = (...args) => call('getClip', args);
export const updateClip: SqliteFunction<'updateClip'> = (...args) => call('updateClip', args);

export const getStorageObject: SqliteFunction<'getStorageObject'> = (...args) =>
  call('getStorageObject', args);
export const getStorageObjectByIdempotencyKey: SqliteFunction<'getStorageObjectByIdempotencyKey'> = (
  ...args
) => call('getStorageObjectByIdempotencyKey', args);
export const getStorageObjectByUploadId: SqliteFunction<'getStorageObjectByUploadId'> = (...args) =>
  call('getStorageObjectByUploadId', args);
export const getStorageObjectsForProject: SqliteFunction<'getStorageObjectsForProject'> = (...args) =>
  call('getStorageObjectsForProject', args);
export const getStorageObjectsForClip: SqliteFunction<'getStorageObjectsForClip'> = (...args) =>
  call('getStorageObjectsForClip', args);
export const getLatestStorageObjectForClip: SqliteFunction<'getLatestStorageObjectForClip'> = (
  ...args
) => call('getLatestStorageObjectForClip', args);
export const upsertStorageObject: SqliteFunction<'upsertStorageObject'> = (...args) =>
  call('upsertStorageObject', args);
export const updateStorageObject: SqliteFunction<'updateStorageObject'> = (...args) =>
  call('updateStorageObject', args);
export const deleteStorageObject: SqliteFunction<'deleteStorageObject'> = (...args) =>
  call('deleteStorageObject', args);
export const deleteStorageObjectsForProject: SqliteFunction<'deleteStorageObjectsForProject'> = (
  ...args
) => call('deleteStorageObjectsForProject', args);
export const sumStorageObjectsByProvider: SqliteFunction<'sumStorageObjectsByProvider'> = (...args) =>
  call('sumStorageObjectsByProvider', args);
export const sumPendingStorageObjectsByProvider: SqliteFunction<'sumPendingStorageObjectsByProvider'> = (
  ...args
) => call('sumPendingStorageObjectsByProvider', args);
export const sumStorageObjectsByProject: SqliteFunction<'sumStorageObjectsByProject'> = (...args) =>
  call('sumStorageObjectsByProject', args);
export const getLatestStorageObjectByProject: SqliteFunction<'getLatestStorageObjectByProject'> = (
  ...args
) => call('getLatestStorageObjectByProject', args);
export const storageFailureCounts: SqliteFunction<'storageFailureCounts'> = (...args) =>
  call('storageFailureCounts', args);
export const tryReserveStorageCapacity: SqliteFunction<'tryReserveStorageCapacity'> = (...args) =>
  call('tryReserveStorageCapacity', args);
export const getStorageReservation: SqliteFunction<'getStorageReservation'> = (...args) =>
  call('getStorageReservation', args);
export const getActiveStorageReservationForObject: SqliteFunction<'getActiveStorageReservationForObject'> = (
  ...args
) => call('getActiveStorageReservationForObject', args);
export const releaseStorageReservation: SqliteFunction<'releaseStorageReservation'> = (...args) =>
  call('releaseStorageReservation', args);
export const releaseActiveReservationsForObject: SqliteFunction<'releaseActiveReservationsForObject'> = (
  ...args
) => call('releaseActiveReservationsForObject', args);
export const getExpiredStorageReservations: SqliteFunction<'getExpiredStorageReservations'> = (...args) =>
  call('getExpiredStorageReservations', args);
export const sumActiveStorageReservationsByProvider: SqliteFunction<'sumActiveStorageReservationsByProvider'> = (
  ...args
) => call('sumActiveStorageReservationsByProvider', args);
export const sumActiveStorageReservations: SqliteFunction<'sumActiveStorageReservations'> = (...args) =>
  call('sumActiveStorageReservations', args);
export const setStorageProviderState: SqliteFunction<'setStorageProviderState'> = (...args) =>
  call('setStorageProviderState', args);
export const getStorageProviderState: SqliteFunction<'getStorageProviderState'> = (...args) =>
  call('getStorageProviderState', args);
export const compareAndSetStorageProviderState: SqliteFunction<'compareAndSetStorageProviderState'> = (
  ...args
) => call('compareAndSetStorageProviderState', args);
export const claimStorageReconciliation: SqliteFunction<'claimStorageReconciliation'> = (...args) =>
  call('claimStorageReconciliation', args);
export const finishStorageReconciliation: SqliteFunction<'finishStorageReconciliation'> = (...args) =>
  call('finishStorageReconciliation', args);
export const getStorageReconciliation: SqliteFunction<'getStorageReconciliation'> = (...args) =>
  call('getStorageReconciliation', args);
export const consumeRateLimitRow: SqliteFunction<'consumeRateLimitRow'> = (...args) =>
  call('consumeRateLimitRow', args);
export const resetRateLimitRow: SqliteFunction<'resetRateLimitRow'> = (...args) =>
  call('resetRateLimitRow', args);
export const purgeRateLimitRows: SqliteFunction<'purgeRateLimitRows'> = (...args) =>
  call('purgeRateLimitRows', args);

export const enqueueJob: SqliteFunction<'enqueueJob'> = (...args) => call('enqueueJob', args);
export const getLatestJob: SqliteFunction<'getLatestJob'> = (...args) =>
  call('getLatestJob', args);
export const hasActiveJob: SqliteFunction<'hasActiveJob'> = (...args) =>
  call('hasActiveJob', args);
export const claimNextJob: SqliteFunction<'claimNextJob'> = (...args) =>
  call('claimNextJob', args);
export const heartbeatJob: SqliteFunction<'heartbeatJob'> = (...args) =>
  call('heartbeatJob', args);
export const finishJob: SqliteFunction<'finishJob'> = (...args) => call('finishJob', args);
export const failJob: SqliteFunction<'failJob'> = (...args) => call('failJob', args);
export const requeueJob: SqliteFunction<'requeueJob'> = (...args) => call('requeueJob', args);
export const recordWorkerHeartbeat: SqliteFunction<'recordWorkerHeartbeat'> = (...args) =>
  call('recordWorkerHeartbeat', args);
export const workerIsOnline: SqliteFunction<'workerIsOnline'> = (...args) =>
  call('workerIsOnline', args);
export const resetProjectForRun: SqliteFunction<'resetProjectForRun'> = (...args) =>
  call('resetProjectForRun', args);

/** Health-check entry point: opens the selected backend and validates schema. */
export async function ensureStorage(): Promise<void> {
  const binding = await d1Binding();
  if (!binding) {
    const module = await import('./db-sqlite');
    module.getDb();
    return;
  }
  const module = await import('./db-d1');
  module.init(binding as Parameters<typeof module.init>[0]);
  await module.ensureSchema();
}

export function toProjectJob(job: Job | null): ProjectJob | null {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}
