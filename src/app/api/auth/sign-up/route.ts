import { NextResponse } from 'next/server';
import { sameOriginError } from '@/lib/api-auth';
import { authError, clientKey, readJsonObject, storageUnavailableResponse } from '@/lib/auth-request';
import { issueAccountToken } from '@/lib/auth';
import { issueSession, sessionCookie } from '@/lib/auth';
import { createEmailUser, markEmailVerified } from '@/lib/db';
import { isValidEmail, normalizeEmail } from '@/lib/email';
import { verificationMail } from '@/lib/auth-mail';
import { mailDelivery, trySendMail } from '@/lib/mailer';
import { publicBaseUrl, isSecureRequest } from '@/lib/origin';
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

  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
  const name =
    typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) : '';

  if (!isValidEmail(email)) {
    return authError(400, 'invalid_email', 'Enter a valid email address.');
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

  const limit = takeRateLimit(`sign-up:${clientKey(request)}`, 20, 60 * 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many accounts were created from this address. Try again later.', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'cache-control': 'private, no-store', 'retry-after': String(limit.retryAfter) },
      },
    );
  }

  const passwordHash = await hashPassword(password);
  const user = await createEmailUser({ email, name: name || null, passwordHash });
  if (!user) {
    return authError(409, 'email_taken', 'An account with that email already exists. Sign in instead.');
  }

  const delivery = mailDelivery();
  let verificationRequired = false;
  let deliveryState: 'sent' | 'failed' | 'unconfigured' = 'unconfigured';

  if (delivery.configured) {
    verificationRequired = true;
    const token = await issueAccountToken(user.id, 'verify_email');
    const verifyUrl = `${publicBaseUrl(request)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    deliveryState = (await trySendMail(verificationMail(email, verifyUrl))) ? 'sent' : 'failed';
  } else {
    // Without a mail provider the address cannot be verified. The account is
    // still password-protected, and login pages state that verification is off.
    await markEmailVerified(user.id);
  }

  const response = NextResponse.json(
    {
      ok: true,
      verificationRequired,
      delivery: deliveryState,
      user: { id: user.id, email: user.email, name: user.name },
    },
    { status: 201, headers: { 'cache-control': 'private, no-store' } },
  );
  if (!verificationRequired) {
    response.cookies.set(sessionCookie(await issueSession(user.id), isSecureRequest(request)));
  }
  return response;
}
