/**
 * Canonical origin and same-origin checks.
 *
 * The canonical origin comes from configuration, never from an untrusted
 * request. In development it defaults to localhost. Same-origin checks also
 * accept the origin the request was actually served from (via the proxy's
 * forwarded host), because a preview or tunnel uses a different hostname than
 * the configured production origin.
 */

export function canonicalOrigin(): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';
  return '';
}

export function isSecureOrigin(origin: string): boolean {
  return origin.startsWith('https://');
}

/** Scheme + host the browser used, as reported by the reverse proxy. */
export function effectiveRequestOrigin(request: Request): string | null {
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host');
  if (!host) return null;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwardedProto || (request.url.startsWith('https:') ? 'https' : 'http');
  return `${scheme}://${host}`;
}

/**
 * Base URL used in emailed links. A configured non-loopback APP_ORIGIN always
 * wins, so production links cannot be poisoned by a Host header. On a preview
 * or localhost deployment the request's own origin is used, otherwise links
 * would point at localhost when the app is served from a preview hostname.
 */
export function publicBaseUrl(request: Request): string {
  const canonical = canonicalOrigin();
  if (canonical && !isLoopbackOrigin(canonical)) return canonical;
  const effective = effectiveRequestOrigin(request);
  if (effective) {
    try {
      return new URL(effective).origin;
    } catch {
      // fall through to the configured origin
    }
  }
  return canonical || 'http://localhost:3000';
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto) return proto === 'https';
  return request.url.startsWith('https:');
}

export function isSameOriginRequest(request: Request, canonical: string): boolean {
  const origin = request.headers.get('origin');
  if (origin) {
    if (canonical && origin === canonical) return true;
    return origin === effectiveRequestOrigin(request);
  }
  // No Origin header: allow non-browser clients and same-origin navigations,
  // but reject an explicitly cross-site browser request.
  const site = request.headers.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}
