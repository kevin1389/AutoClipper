import { checkReconcileSecret, MIN_RECONCILE_SECRET_LENGTH } from '@/lib/reconcile-secret';
import { maybePurgeRateLimits, takeRateLimit } from '@/lib/rate-limit';
import { clientKey } from '@/lib/auth-request';
import { reconcileStorageProviders } from '@/lib/storage-reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daily storage reconciliation endpoint for a production scheduler.
 *
 * Configure AC_RECONCILE_SECRET (at least 32 characters) and have the scheduler
 * send it as `Authorization: Bearer <secret>` or `x-ac-reconcile-secret`.
 * Without a configured secret the endpoint refuses every request rather than
 * running unauthenticated. The work itself is idempotent: the per-provider
 * lease and `next_attempt_at` gate mean repeated calls cannot fan out into
 * extra listings.
 *
 * Two durable limits sit in front of the work: a per-client request limit that
 * blunts secret guessing, and a global run limit so a leaked secret still
 * cannot drive more than a handful of listings per window.
 */

const RECONCILE_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.AC_RECONCILE_RATE_WINDOW_MS) || 15 * 60_000,
);
const RECONCILE_CLIENT_LIMIT = Math.max(
  1,
  Number(process.env.AC_RECONCILE_CLIENT_LIMIT) || 30,
);
const RECONCILE_RUN_LIMIT = Math.max(1, Number(process.env.AC_RECONCILE_RATE_LIMIT) || 20);

function providedSecret(request: Request): string | null {
  const header = request.headers.get('x-ac-reconcile-secret');
  if (header) return header;
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : null;
}

function tooMany(retryAfter: number): Response {
  return Response.json(
    {
      error: 'Too many reconciliation requests. Try again after the retry window.',
      code: 'rate_limited',
    },
    {
      status: 429,
      headers: { 'cache-control': 'no-store', 'retry-after': String(retryAfter) },
    },
  );
}

async function handle(request: Request): Promise<Response> {
  const clientLimit = await takeRateLimit(
    `reconcile:client:${clientKey(request)}`,
    RECONCILE_CLIENT_LIMIT,
    RECONCILE_WINDOW_MS,
  );
  void maybePurgeRateLimits();
  if (!clientLimit.ok) return tooMany(clientLimit.retryAfter);

  const secretState = checkReconcileSecret(
    process.env.AC_RECONCILE_SECRET,
    providedSecret(request),
  );
  if (secretState === 'not_configured') {
    return Response.json(
      {
        error:
          'AC_RECONCILE_SECRET is not configured, so scheduled reconciliation is disabled. Set it in the server secret store before calling this endpoint.',
        code: 'reconcile_not_configured',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (secretState === 'too_short') {
    return Response.json(
      {
        error: `AC_RECONCILE_SECRET is too short. Use at least ${MIN_RECONCILE_SECRET_LENGTH} characters of random data.`,
        code: 'reconcile_secret_weak',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (secretState === 'unauthorized') {
    return Response.json(
      { error: 'Unauthorized.', code: 'unauthorized' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }

  const runLimit = await takeRateLimit(
    'reconcile:run:global',
    RECONCILE_RUN_LIMIT,
    RECONCILE_WINDOW_MS,
  );
  if (!runLimit.ok) return tooMany(runLimit.retryAfter);

  const force = new URL(request.url).searchParams.get('force') === '1';
  try {
    const report = await reconcileStorageProviders({ force });
    return Response.json(report, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      {
        error: `Reconciliation failed: ${(error as Error).message.slice(0, 300)}`,
        code: 'reconcile_failed',
      },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}

/** POST is preferred; GET is supported for schedulers that only issue GETs. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
