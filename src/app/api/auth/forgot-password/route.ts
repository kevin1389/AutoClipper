import { NextResponse } from 'next/server';
import { sameOriginError } from '@/lib/api-auth';
import { authError, clientKey, readJsonObject, storageUnavailableResponse } from '@/lib/auth-request';
import { issueAccountToken } from '@/lib/auth';
import { passwordResetMail } from '@/lib/auth-mail';
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
      'Password reset email is not configured on this deployment. Ask the operator to set RESEND_API_KEY and EMAIL_FROM.',
    );
  }

  const limit = takeRateLimit(`forgot:${clientKey(request)}:${email}`, 5, 15 * 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many reset requests. Wait a few minutes and try again.', code: 'rate_limited' },
      {
        status: 429,
        headers: { 'cache-control': 'private, no-store', 'retry-after': String(limit.retryAfter) },
      },
    );
  }

  const user = await findUserByEmail(email);
  // Google-only accounts have no password to reset; they receive nothing, and
  // the response is identical so this endpoint cannot enumerate accounts.
  if (user?.passwordHash) {
    const token = await issueAccountToken(user.id, 'reset_password');
    const resetUrl = `${publicBaseUrl(request)}/reset-password?token=${encodeURIComponent(token)}`;
    await trySendMail(passwordResetMail(email, resetUrl));
  }

  return NextResponse.json(
    {
      ok: true,
      message: 'If an account exists for that email, a password reset link has been sent.',
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
