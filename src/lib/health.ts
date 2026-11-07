/**
 * Public health payloads.
 *
 * `/api/health` is unauthenticated, so a failure must stay useful (the caller
 * learns the datastore is the failing component) without echoing exception
 * text. Driver and filesystem errors routinely contain absolute paths, table
 * names, connection strings or credentials; none of that is returned.
 */

export interface HealthFailure {
  ok: false;
  status: 'unavailable';
  code: 'storage_unavailable';
  error: string;
}

export const HEALTH_UNAVAILABLE_MESSAGE =
  'Storage is unavailable on this deployment. The service is running, but its data store could not be opened.';

/**
 * Accepts the caught error only so callers do not need a separate branch; the
 * value is deliberately not inspected or serialized.
 */
export function healthFailure(): HealthFailure {
  return {
    ok: false,
    status: 'unavailable',
    code: 'storage_unavailable',
    error: HEALTH_UNAVAILABLE_MESSAGE,
  };
}
