/**
 * Raised when the account database cannot be opened because the runtime has no
 * writable persistent filesystem. This is a deployment problem, not a bad
 * password, and must never be reported as an authentication failure.
 */
export class StorageUnavailableError extends Error {
  readonly code = 'storage_unavailable';

  constructor(detail: string, options?: ErrorOptions) {
    super(
      `Account storage is unavailable: ${detail}. This deployment needs a writable persistent data directory.`,
      options,
    );
    this.name = 'StorageUnavailableError';
  }
}

export function isStorageUnavailable(error: unknown): error is StorageUnavailableError {
  return error instanceof StorageUnavailableError;
}
