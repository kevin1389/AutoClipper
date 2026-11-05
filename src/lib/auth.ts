import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import * as db from './db';
import { canonicalOrigin, isSecureOrigin } from './origin';

/**
 * Server-side identity resolution.
 *
 * A signed-in user is identified by an opaque session token in an HTTP-only
 * cookie. Only the SHA-256 hash of that token is stored, so the database never
 * contains a usable cookie value. A user id supplied in a request body, query
 * string or header is never trusted.
 *
 * Automated tests may enable fixed identities through AC_ALLOW_TEST_AUTH; that
 * path is disabled in production and cannot be reached over HTTP.
 */

export const SESSION_COOKIE = 'ac_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const TEST_AUTH_COOKIE = 'ac_test_user';

export interface SessionUser extends db.AppUser {}

export interface SessionTicket {
  userId: string;
  token: string;
  maxAge: number;
}

function testAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.AC_ALLOW_TEST_AUTH === '1' &&
    Boolean(process.env.AC_TEST_AUTH_USERS?.trim())
  );
}

async function testUser(): Promise<SessionUser | null> {
  if (!testAuthEnabled()) return null;
  let map: Record<string, { sub: string; email?: string | null; name?: string | null; picture?: string | null }>;
  try {
    map = JSON.parse(process.env.AC_TEST_AUTH_USERS as string);
  } catch {
    return null;
  }
  const token = (await cookies()).get(TEST_AUTH_COOKIE)?.value;
  if (!token) return null;
  const entry = map[token];
  if (!entry?.sub) return null;
  return await db.upsertUser({
    id: entry.sub,
    email: entry.email ?? null,
    name: entry.name ?? null,
    picture: entry.picture ?? null,
  });
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a single-use email token and returns the raw value for the link; the
 * database only receives its SHA-256 hash, exactly like a session cookie.
 */
export async function issueAccountToken(userId: string, purpose: 'verify_email' | 'reset_password'): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const ttlMs = purpose === 'verify_email' ? 24 * 60 * 60_000 : 60 * 60_000;
  await db.createAuthToken(
    hashSessionToken(token),
    userId,
    purpose,
    new Date(Date.now() + ttlMs).toISOString(),
  );
  return token;
}

/** Creates a session row and returns the raw token; only its hash is stored. */
export async function issueSession(userId: string): Promise<SessionTicket> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db.createSessionRow(hashSessionToken(token), userId, expiresAt);
  return { userId, token, maxAge: SESSION_MAX_AGE_SECONDS };
}

/** Cookie attributes for a new session. Secure only when served over HTTPS. */
export function sessionCookie(ticket: SessionTicket, secure: boolean) {
  return {
    name: SESSION_COOKIE,
    value: ticket.token,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secure || isSecureOrigin(canonicalOrigin()),
    path: '/',
    maxAge: ticket.maxAge,
  };
}

export function clearedSessionCookie(secure: boolean) {
  return {
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secure || isSecureOrigin(canonicalOrigin()),
    path: '/',
    maxAge: 0,
  };
}

/** Deletes the current session row (sign-out). The caller clears the cookie. */
export async function endCurrentSession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await db.deleteSessionRow(hashSessionToken(token));
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const test = await testUser();
  if (test) return test;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return await db.getSessionUser(hashSessionToken(token));
}

/** Display name for the account chip; never rendered as HTML. */
export function accountLabel(user: SessionUser): string {
  return user.name?.trim() || user.email?.trim() || 'Your account';
}
