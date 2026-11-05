/** Storage numbers shared by server code and the dashboard. */
export type StorageProviderRole = 'hot' | 'overflow' | 'cold';

export interface StorageProviderUsage {
  id: string;
  label: string;
  role: StorageProviderRole;
  /** True when the server has every credential needed to use this provider. */
  configured: boolean;
  /** True only after a successful provider listing in this measurement. */
  verified: boolean;
  /** Actual provider bytes (all objects in the bucket), or null if unmeasurable. */
  usedBytes: number | null;
  objectCount: number | null;
  /** Complete AutoClipper objects on this provider, from the D1 ledger. */
  appBytes: number;
  /** Other objects in this dedicated bucket, not account-wide billing usage. */
  externalBytes: number | null;
  /** Active upload reservations/multipart bytes counted against the cap. */
  reservedBytes: number;
  pendingUploads: number;
  /** Free-tier allowance and the application reserve. */
  limitBytes: number;
  reserveBytes: number;
  safeLimitBytes: number;
  availableBytes: number | null;
  error: string | null;
  measuredAt: string | null;
}

export interface StorageProjectUsage {
  projectId: string;
  usedBytes: number;
  sourceBytes: number;
  clipBytes: number;
  fileCount: number;
}

export interface StorageUsage {
  /** False when no provider could be measured; never report a fabricated zero. */
  available: boolean;
  /** 'pool' when S3 providers are active; legacy values remain supported. */
  backend: 'r2' | 'local' | 'pool';
  usedBytes: number;
  availableBytes: number;
  limitBytes: number;
  sourceBytes: number;
  clipBytes: number;
  fileCount: number;
  projects: StorageProjectUsage[];
  error: string | null;
  measuredAt: string;
  /** Per-provider detail. Empty for the legacy single-backend path. */
  providers: StorageProviderUsage[];
  /** Sum of configured safety caps, including providers not currently reachable. */
  configuredCapacityBytes: number;
  /** Sum of safety caps for providers that were actually measured. */
  verifiedCapacityBytes: number;
  totalUsedBytes: number;
  totalAvailableBytes: number;
  /** Bytes held by active uploads/multipart sessions. */
  reservedBytes: number;
  pendingUploads: number;
  failedUploads: number;
  failedDeletions: number;
  lastSuccessfulMeasurement: string | null;
  /** True only when every required provider is configured, reachable and measured. */
  targetVerified: boolean;
}

export interface FailedFileDeletion {
  /** Project-relative path, e.g. clips/clip-01.mp4. */
  path: string;
  error: string;
}

export interface ProjectFileDeletion {
  /** True only after the storage backend confirms that no project objects remain. */
  verified: boolean;
  deletedFiles: number;
  failedFiles: FailedFileDeletion[];
  /** Bytes confirmed gone. Always 0 when verification failed. */
  bytesFreed: number;
  bytesRemaining: number;
}
