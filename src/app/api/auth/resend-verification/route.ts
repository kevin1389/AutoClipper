import { NextResponse } from 'next/server';
import { sameOriginError } from '@/lib/api-auth';
import { authError, clientKey, readJsonObject, storageUnavailableResponse } from '@/lib/auth-request';
import { issueAccountToken } from '@/lib/auth';
import { verificationMail } from '@/lib/auth-mail';
import { findUserByEmail } from '@/lib/db';
import { isValidEmail, normalizeEmail } from '@/lib/email';
import { mailDelivery, trySendMail } from '@/lib/mailer';
import { publicBaseUrl } from '@/lib/origin';
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
  if (!isValidEmail(email)) {
    return authError(400, 'invalid_email', 'Enter a valid email address.');
  }

  const delivery = mailDelivery();
  if (!delivery.configured) {
    return authError(
      503,
      'email_not_configured',
      'Email delivery is not configured on this deployment, so verification links cannot be sent.',
    );
  }

  const limit = await takeRateLimit(
    `resend-verify:${clientKey(request)}:${email}`,
    5,
    15 * 60_000,
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Wait a few minutes and try again.', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'cache-control': 'private, no-store', 'retry-after': String(limit.retryAfter) },
      },
    );
  }

  const user = await findUserByEmail(email);
  if (user && !user.emailVerified) {
    const token = await issueAccountToken(user.id, 'verify_email');
    const verifyUrl = `${publicBaseUrl(request)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    await trySendMail(verificationMail(email, verifyUrl));
  }

  // The same answer whether or not the address has an account.
  return NextResponse.json(
    { ok: true, message: 'If that address needs verification, a new link is on its way.' },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
