import { NextResponse } from 'next/server';
import { sameOriginError } from '@/lib/api-auth';
import { authError, clientKey, readJsonObject, storageUnavailableResponse } from '@/lib/auth-request';
import { issueSession, sessionCookie } from '@/lib/auth';
import { findUserByEmail, markEmailVerified } from '@/lib/db';
import { isValidEmail, normalizeEmail } from '@/lib/email';
import { mailDelivery } from '@/lib/mailer';
import { isSecureRequest } from '@/lib/origin';
import { hashPassword, verifyPassword } from '@/lib/password';
import { clearRateLimit, maybePurgeRateLimits, takeRateLimit } from '@/lib/rate-limit';

// Sign-in throttling is durable (shared database), so these limits hold across
// every Worker rather than resetting per isolate. The account bucket cannot be
// spoofed; the client bucket bounds guessing spread over many accounts.
const SIGN_IN_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.AC_SIGNIN_RATE_WINDOW_MS) || 15 * 60_000,
);
const SIGN_IN_ACCOUNT_LIMIT = Math.max(1, Number(process.env.AC_SIGNIN_ACCOUNT_LIMIT) || 10);
const SIGN_IN_CLIENT_LIMIT = Math.max(1, Number(process.env.AC_SIGNIN_CLIENT_LIMIT) || 30);

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

  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!isValidEmail(email) || password.length === 0 || password.length > 200) {
    return authError(400, 'invalid_credentials_format', 'Enter a valid email address and password.');
  }

  const accountKey = `sign-in:account:${email}`;
  const clientKeyId = `sign-in:client:${clientKey(request)}`;
  const [accountLimit, clientLimit] = await Promise.all([
    takeRateLimit(accountKey, SIGN_IN_ACCOUNT_LIMIT, SIGN_IN_WINDOW_MS),
    takeRateLimit(clientKeyId, SIGN_IN_CLIENT_LIMIT, SIGN_IN_WINDOW_MS),
  ]);
  void maybePurgeRateLimits();
  if (!accountLimit.ok || !clientLimit.ok) {
    const retryAfter = Math.max(accountLimit.retryAfter, clientLimit.retryAfter);
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Wait a few minutes and try again.', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'cache-control': 'private, no-store', 'retry-after': String(retryAfter) },
      },
    );
  }

  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    // Spend the same scrypt work as a real check so response timing does not
    // reveal whether an address has an account.
    await hashPassword(password);
    return authError(401, 'invalid_credentials', 'Incorrect email or password.');
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    return authError(401, 'invalid_credentials', 'Incorrect email or password.');
  }

  if (!user.emailVerified) {
    if (mailDelivery().configured) {
      return authError(
        403,
        'email_unverified',
        'Verify your email address before signing in. Check your inbox or request a new link.',
      );
    }
    // Deployments without a mail provider cannot complete verification, so an
    // existing password account is activated on first successful sign-in.
    await markEmailVerified(user.id);
  }

  await clearRateLimit(accountKey);
  await clearRateLimit(clientKeyId);
  const response = NextResponse.json(
    { ok: true, user: { id: user.id, email: user.email, name: user.name } },
    { headers: { 'cache-control': 'private, no-store' } },
  );
  response.cookies.set(sessionCookie(await issueSession(user.id), isSecureRequest(request)));
  return response;
}
