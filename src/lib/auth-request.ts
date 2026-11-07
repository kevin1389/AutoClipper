import { isStorageUnavailable } from './storage-error';

const MAX_BODY_BYTES = 8 * 1024;

/** Private, uncached JSON error used by the credential routes. */
export function authError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: message, code },
    { status, headers: { 'cache-control': 'private, no-store' } },
  );
}

/**
 * Converts an unwritable-database failure into an actionable 503. Returns null
 * for every other error so real bugs are not swallowed.
 */
export function storageUnavailableResponse(error: unknown): Response | null {
  if (!isStorageUnavailable(error)) return null;
  return authError(
    503,
    'storage_unavailable',
    'Account storage is unavailable on this deployment. The server needs a writable persistent data directory; this is a hosting configuration problem, not a password problem.',
  );
}

/** Reads a small JSON object, rejecting wrong content types and oversized bodies. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return authError(415, 'unsupported_media_type', 'Send this request as application/json.');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return authError(413, 'body_too_large', 'That request body is too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return authError(400, 'invalid_body', 'Expected a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return authError(400, 'invalid_body', 'Expected a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Best-effort caller address for rate limiting.
 *
 * These headers are only trustworthy when a proxy sets them: on a directly
 * exposed Node server a client can invent `x-forwarded-for`. Client-scoped
 * limits are therefore a secondary guard, and sign-in additionally throttles
 * an unspoofable account bucket. `cf-connecting-ip` is set by Cloudflare and
 * is preferred because Cloudflare overwrites any client-supplied value.
 */
export function clientKey(request: Request): string {
  const forwarded =
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'local';
}
