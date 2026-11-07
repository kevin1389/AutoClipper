import { after } from 'next/server';
import * as db from '@/lib/db';
import { requireUser } from '@/lib/api-auth';
import { getStorageUsage } from '@/lib/storage';
import { reconcileStorageProviders } from '@/lib/storage-reconcile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  try {
    const projects = await db.listProjects(auth.user.id, 500);
    const force = new URL(request.url).searchParams.get('refresh') === '1';
    const usage = await getStorageUsage(projects.map((project) => project.id), { force });
    // Safety net for deployments without an external scheduler: the first
    // read after the daily window starts reconciliation after the response.
    // The lease and next-attempt gate make repeated calls harmless, and an
    // active upload defers a provider instead of listing it.
    after(() => reconcileStorageProviders().catch(() => undefined));
    return Response.json(usage, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return Response.json(
      {
        error: `Could not read storage usage: ${(error as Error).message.slice(0, 300)}`,
        code: 'storage_usage_failed',
      },
      { status: 500, headers: { 'cache-control': 'private, no-store' } },
    );
  }
}
