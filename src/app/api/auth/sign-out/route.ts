import { NextResponse } from 'next/server';
import { sameOriginError } from '@/lib/api-auth';
import { clearedSessionCookie, endCurrentSession } from '@/lib/auth';
import { canonicalOrigin, isSecureRequest } from '@/lib/origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const originError = sameOriginError(request);
  if (originError) return originError;

  await endCurrentSession();

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  const accept = (request.headers.get('accept') ?? '').toLowerCase();
  const fromForm = contentType.includes('application/x-www-form-urlencoded') || accept.includes('text/html');
  const origin = canonicalOrigin() || new URL(request.url).origin;

  const response = fromForm
    ? NextResponse.redirect(`${origin}/`, 303)
    : NextResponse.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } });
  response.cookies.set(clearedSessionCookie(isSecureRequest(request)));
  return response;
}
