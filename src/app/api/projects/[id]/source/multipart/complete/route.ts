import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { completeSourceUpload } from '@/lib/source-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  if (!(await db.getProjectForOwner(id, auth.user.id))) {
    return jsonError(404, 'project_not_found', 'That project does not exist.');
  }
  const body = (await request.json().catch(() => ({}))) as {
    uploadId?: unknown;
    parts?: { partNumber?: unknown; etag?: unknown }[];
  };
  if (!body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) {
    return jsonError(400, 'invalid_completion', 'uploadId and uploaded parts are required.');
  }
  try {
    const result = await completeSourceUpload(
      id,
      String(body.uploadId),
      body.parts.map((part) => ({ partNumber: Number(part.partNumber), etag: String(part.etag) })),
    );
    return Response.json({
      ok: true,
      bytes: result.bytes,
      project: await db.getProjectForOwner(id, auth.user.id),
    }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return jsonError(400, 'upload_complete_failed', (error as Error).message.slice(0, 500));
  }
}
