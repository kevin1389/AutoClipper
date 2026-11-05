import { canonicalOrigin, isSecureOrigin } from './origin';

/**
 * Google OAuth 2.0 (authorization-code flow).
 *
 * Only the public profile scopes are requested. An account is created or
 * linked only when Google reports the email as verified, so an unverified
 * Google address can never take over an existing email account.
 */

export const GOOGLE_STATE_COOKIE = 'ac_google_state';
export const GOOGLE_STATE_MAX_AGE = 600;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  origin: string;
  redirectUri: string;
}

export function googleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const origin = canonicalOrigin();
  if (!clientId || !clientSecret || !origin) return null;
  return {
    clientId,
    clientSecret,
    origin,
    redirectUri: `${origin}/api/auth/google/callback`,
  };
}

export function googleAvailability(): { configured: boolean; reason: string | null } {
  if (googleConfig()) return { configured: true, reason: null };
  if (!process.env.GOOGLE_CLIENT_ID?.trim() || !process.env.GOOGLE_CLIENT_SECRET?.trim()) {
    return {
      configured: false,
      reason:
        'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set for this deployment. Email and password sign-in still works.',
    };
  }
  return {
    configured: false,
    reason: 'APP_ORIGIN is not set, so the Google redirect URI is unknown.',
  };
}

export function googleAuthorizeUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function googleStateCookieOptions(config: GoogleConfig) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureOrigin(config.origin),
    path: '/',
    maxAge: GOOGLE_STATE_MAX_AGE,
  };
}

export interface GoogleTokens {
  access_token: string;
  id_token?: string;
}

export async function exchangeGoogleCode(
  config: GoogleConfig,
  code: string,
): Promise<GoogleTokens | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<GoogleTokens>;
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) return null;
    return { access_token: data.access_token, id_token: data.id_token };
  } catch {
    return null;
  }
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile | null> {
  try {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      sub?: unknown;
      email?: unknown;
      email_verified?: unknown;
      name?: unknown;
      picture?: unknown;
    };
    if (typeof data.sub !== 'string' || data.sub.length === 0) return null;
    return {
      sub: data.sub,
      email: typeof data.email === 'string' && data.email.length > 0 ? data.email : null,
      emailVerified: data.email_verified === true || data.email_verified === 'true',
      name: typeof data.name === 'string' ? data.name : null,
      picture: typeof data.picture === 'string' ? data.picture : null,
    };
  } catch {
    return null;
  }
}
