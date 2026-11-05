import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { config } from '@/lib/env';
import { jsonError } from '@/lib/http';
import { getStorageUsage } from '@/lib/storage';
import { startSourceUpload } from '@/lib/source-upload';
import { StoragePoolCapacityError, StoragePoolUnavailableError } from '@/lib/storage-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  const project = await db.getProjectForOwner(id, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  if (project.status === 'processing' || (await db.hasActiveJob(id))) {
    return jsonError(409, 'project_busy', 'This project is processing. Wait for it to finish before replacing the source.');
  }
  const body = (await request.json().catch(() => ({}))) as { fileName?: unknown; size?: unknown };
  const fileName = String(body.fileName ?? '');
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return jsonError(400, 'invalid_size', 'A positive file size is required.');
  if (size > config().maxUploadBytes) {
    return jsonError(413, 'file_too_large', 'That file exceeds the configured upload limit.');
  }

  // A server-side source copy shares the managed R2 allowance with clips.
  // Refuse before creating a multipart upload when it cannot fit. The normal
  // local-first path never needs this check or any R2 source bytes.
  const projects = await db.listProjects(auth.user.id, 1000);
  const usage = await getStorageUsage([...projects.map((entry) => entry.id), id]);
  if (!usage.available) {
    return jsonError(503, 'storage_unavailable', 'Storage usage could not be measured, so a server-side source copy was not started.');
  }
  if (size > usage.availableBytes) {
    return jsonError(
      413,
      'insufficient_storage',
      `A server-side source copy needs ${(size / 1_000_000).toFixed(0)} MB, but only ${(usage.availableBytes / 1_000_000).toFixed(0)} MB is available. Keep the source on this device instead.`,
    );
  }
  try {
    const upload = await startSourceUpload(id, auth.user.id, fileName, size);
    return Response.json(upload, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof StoragePoolCapacityError) {
      return jsonError(413, 'insufficient_storage', (error as Error).message.slice(0, 500));
    }
    if (error instanceof StoragePoolUnavailableError) {
      return jsonError(503, 'storage_unavailable', (error as Error).message.slice(0, 500));
    }
    return jsonError(400, 'upload_start_failed', (error as Error).message.slice(0, 500));
  }
}
