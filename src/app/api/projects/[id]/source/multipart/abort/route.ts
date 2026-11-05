import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { abortSourceUpload } from '@/lib/source-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  if (!(await db.getProjectForOwner(id, auth.user.id))) {
    return jsonError(404, 'project_not_found', 'That project does not exist.');
  }
  const body = (await request.json().catch(() => ({}))) as { uploadId?: unknown };
  const uploadId = String(body.uploadId ?? '').trim();
  if (!uploadId || uploadId.length > 512) {
    return jsonError(400, 'invalid_upload_id', 'uploadId is required.');
  }
  try {
    await abortSourceUpload(id, uploadId);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return jsonError(400, 'upload_abort_failed', (error as Error).message.slice(0, 300));
  }
}
