import { NextResponse } from 'next/server';
import { sameOriginError } from '@/lib/api-auth';
import { authError, clientKey, readJsonObject, storageUnavailableResponse } from '@/lib/auth-request';
import { hashSessionToken } from '@/lib/auth';
import { consumeAuthToken, revokeUserSessions, setUserPassword } from '@/lib/db';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/password';
import { takeRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePost(request);
  } catch (error) {
    const storageResponse = storageUnavailableResponse(error);
    if (storageResponse) return storageResponse;
    throw error;
  }
}

async function handlePost(request: Request): Promise<Response> {
  const originError = sameOriginError(request);
  if (originError) return originError;

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

  if (!token || token.length > 200) {
    return authError(400, 'reset_invalid', 'That reset link is invalid or has expired. Request a new one.');
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return authError(
      400,
      'invalid_password',
      `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (confirmPassword !== password) {
    return authError(400, 'password_mismatch', 'The two passwords do not match.');
  }

  const limit = await takeRateLimit(`reset:${clientKey(request)}`, 10, 15 * 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Wait a few minutes and try again.', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'cache-control': 'private, no-store', 'retry-after': String(limit.retryAfter) },
      },
    );
  }

  const consumed = await consumeAuthToken(hashSessionToken(token), 'reset_password');
  if (!consumed) {
    return authError(400, 'reset_invalid', 'That reset link is invalid or has expired. Request a new one.');
  }

  const passwordHash = await hashPassword(password);
  await setUserPassword(consumed.userId, passwordHash);
  // A reset invalidates every existing login, including one an attacker holds.
  await revokeUserSessions(consumed.userId);

  return NextResponse.json(
    { ok: true, message: 'Your password has been updated. Sign in with the new password.' },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
