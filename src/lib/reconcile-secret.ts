import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Minimum length for AC_RECONCILE_SECRET.
 *
 * The endpoint is public and unauthenticated apart from this shared secret, so
 * a short value would be guessable by an offline-speed brute force. 32
 * characters is the shortest length that still leaves a comfortable margin for
 * a random URL-safe secret (about 190 bits at base64url).
 */
export const MIN_RECONCILE_SECRET_LENGTH = 32;

export type ReconcileSecretCheck = 'ok' | 'not_configured' | 'too_short' | 'unauthorized';

/**
 * Decides whether a request may run reconciliation.
 *
 * Comparison is over fixed-length SHA-256 digests: `timingSafeEqual` on raw
 * strings would short-circuit on a length mismatch and leak the configured
 * secret's length.
 */
export function checkReconcileSecret(
  configured: string | null | undefined,
  provided: string | null,
): ReconcileSecretCheck {
  const expected = (configured ?? '').trim();
  if (!expected) return 'not_configured';
  if (expected.length < MIN_RECONCILE_SECRET_LENGTH) return 'too_short';
  if (!provided) return 'unauthorized';
  const left = createHash('sha256').update(provided, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right) ? 'ok' : 'unauthorized';
}
