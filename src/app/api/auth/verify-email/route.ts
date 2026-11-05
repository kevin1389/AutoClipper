import { NextResponse } from 'next/server';
import { storageUnavailableResponse } from '@/lib/auth-request';
import { hashSessionToken } from '@/lib/auth';
import { consumeAuthToken, markEmailVerified } from '@/lib/db';
import { publicBaseUrl } from '@/lib/origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Consumes a one-time verification link. Email clients open links with GET, so
 * this route accepts GET; the token is opaque, hashed at rest, expiring and
 * single-use, so a prefetch cannot do more than consume the link once.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    return await handleGet(request);
  } catch (error) {
    const storageResponse = storageUnavailableResponse(error);
    if (storageResponse) return storageResponse;
    throw error;
  }
}

async function handleGet(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');
  let verified = false;
  if (token && token.length <= 200) {
    const result = await consumeAuthToken(hashSessionToken(token), 'verify_email');
    if (result) {
      await markEmailVerified(result.userId);
      verified = true;
    }
  }

  const destination = new URL(verified ? '/login?verified=1' : '/login?error=verify_invalid', publicBaseUrl(request));
  return NextResponse.redirect(destination, 303);
}
