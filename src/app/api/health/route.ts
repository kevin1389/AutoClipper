import * as db from '@/lib/db';
import { publicConfig } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.ensureStorage();
    return Response.json({
      ok: true,
      config: publicConfig(),
      workerOnline: await db.workerIsOnline(),
      storage: 'd1',
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        config: publicConfig(),
        workerOnline: false,
        error: `Storage is not writable: ${(error as Error).message}`,
      },
      { status: 500 },
    );
  }
}
