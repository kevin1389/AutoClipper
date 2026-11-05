import { getCurrentUser, type SessionUser } from './auth';
import { isStorageUnavailable } from './storage-error';
import { canonicalOrigin, isSameOriginRequest } from './origin';

/** JSON responses about a private resource must never be cached. */
const PRIVATE_HEADERS = { 'cache-control': 'private, no-store' } as const;

export function privateJson(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: { ...PRIVATE_HEADERS, ...(init.headers ?? {}) },
  });
}

export function unauthorized(): Response {
  return privateJson({ error: 'Sign in to continue.', code: 'unauthenticated' }, { status: 401 });
}

/** A foreign or missing resource is reported as missing, never as forbidden. */
export function notFound(code = 'project_not_found', message = 'That project does not exist.'): Response {
  return privateJson({ error: message, code }, { status: 404 });
}

export type AuthResult = { user: SessionUser } | { response: Response };

export async function requireUser(): Promise<AuthResult> {
  try {
    const user = await getCurrentUser();
    if (!user) return { response: unauthorized() };
    return { user };
  } catch (error) {
    if (isStorageUnavailable(error)) {
      return {
        response: privateJson(
          {
            error:
              'Account storage is unavailable on this deployment. The server needs a writable persistent data directory.',
            code: 'storage_unavailable',
          },
          { status: 503 },
        ),
      };
    }
    throw error;
  }
}

/**
 * CSRF protection for state-changing requests: the Origin must match the
 * configured origin or the origin the request was actually served from.
 * SameSite cookies alone are not treated as sufficient.
 */
export function sameOriginError(request: Request): Response | null {
  const origin = canonicalOrigin();
  if (!origin && process.env.NODE_ENV === 'production') {
    return privateJson(
      { error: 'APP_ORIGIN is not configured, so state-changing requests are refused.', code: 'origin_not_configured' },
      { status: 403 },
    );
  }
  if (isSameOriginRequest(request, origin)) return null;
  return privateJson({ error: 'Cross-origin request refused.', code: 'cross_origin_refused' }, { status: 403 });
}
