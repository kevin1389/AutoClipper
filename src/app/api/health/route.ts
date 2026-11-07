import * as db from '@/lib/db';
import { publicConfig } from '@/lib/env';
import { healthFailure } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public health probe.
 *
 * Success exposes only coarse component booleans plus the same non-secret
 * configuration the browser already receives from `/api/projects`. Failures
 * return a fixed message: exception text, filesystem paths, database names,
 * connection strings and environment values never leave the server.
 */
export async function GET() {
  try {
    await db.ensureStorage();
    return Response.json(
      {
        ok: true,
        status: 'ok',
        config: publicConfig(),
        workerOnline: await db.workerIsOnline(),
        checks: { database: true, storageWritable: true },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json(healthFailure(), {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
