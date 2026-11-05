import { NextResponse, type NextRequest } from 'next/server';
import {
  GOOGLE_STATE_COOKIE,
  exchangeGoogleCode,
  fetchGoogleProfile,
  googleConfig,
} from '@/lib/google';
import { issueSession, sessionCookie } from '@/lib/auth';
import { findOrCreateGoogleUser } from '@/lib/db';
import { canonicalOrigin, isSecureRequest } from '@/lib/origin';
import { safeNextPath } from '@/lib/safe-next';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function finish(response: NextResponse): NextResponse {
  response.cookies.set({ name: GOOGLE_STATE_COOKIE, value: '', path: '/', maxAge: 0, httpOnly: true });
  return response;
}

function errorRedirect(origin: string, code: string): NextResponse {
  return finish(NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(code)}`));
}

export async function GET(request: NextRequest): Promise<Response> {
  const config = googleConfig();
  const origin = canonicalOrigin() || request.nextUrl.origin;
  if (!config) return errorRedirect(origin, 'google_not_configured');

  if (request.nextUrl.searchParams.get('error')) return errorRedirect(origin, 'google_denied');

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const raw = request.cookies.get(GOOGLE_STATE_COOKIE)?.value;
  let saved: { state?: string; next?: string } | null = null;
  try {
    saved = raw ? (JSON.parse(raw) as { state?: string; next?: string }) : null;
  } catch {
    saved = null;
  }

  if (!code || !state || !saved?.state || saved.state !== state) {
    return errorRedirect(origin, 'google_state');
  }

  const tokens = await exchangeGoogleCode(config, code);
  if (!tokens) return errorRedirect(origin, 'google_exchange');

  const profile = await fetchGoogleProfile(tokens.access_token);
  if (!profile) return errorRedirect(origin, 'google_profile');

  const user = await findOrCreateGoogleUser({
    sub: profile.sub,
    email: profile.email,
    emailVerified: profile.emailVerified,
    name: profile.name,
    picture: profile.picture,
  });
  if (!user) return errorRedirect(origin, 'google_email_unverified');

  const response = NextResponse.redirect(`${origin}${safeNextPath(saved.next)}`);
  response.cookies.set(sessionCookie(await issueSession(user.id), isSecureRequest(request)));
  return finish(response);
}
