import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  GOOGLE_STATE_COOKIE,
  googleAuthorizeUrl,
  googleConfig,
  googleStateCookieOptions,
} from '@/lib/google';
import { canonicalOrigin } from '@/lib/origin';
import { safeNextPath } from '@/lib/safe-next';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const config = googleConfig();
  const origin = canonicalOrigin() || new URL(request.url).origin;
  if (!config) {
    return NextResponse.redirect(`${origin}/login?error=google_not_configured`);
  }

  const next = safeNextPath(new URL(request.url).searchParams.get('next'));
  const state = randomBytes(24).toString('base64url');

  const response = NextResponse.redirect(googleAuthorizeUrl(config, state));
  response.cookies.set({
    name: GOOGLE_STATE_COOKIE,
    value: JSON.stringify({ state, next }),
    ...googleStateCookieOptions(config),
  });
  return response;
}
