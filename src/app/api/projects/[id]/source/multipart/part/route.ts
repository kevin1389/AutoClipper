import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { uploadSourcePart } from '@/lib/source-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_PART_BYTES = 8 * 1024 * 1024 + 1024;

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  if (!(await db.getProjectForOwner(id, auth.user.id))) {
    return jsonError(404, 'project_not_found', 'That project does not exist.');
  }
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId') ?? '';
  const partNumber = Number(url.searchParams.get('partNumber'));
  if (!uploadId || !Number.isInteger(partNumber)) {
    return jsonError(400, 'invalid_upload_part', 'uploadId and partNumber are required.');
  }
  if (!request.body) return jsonError(400, 'empty_part', 'The upload part had no body.');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_PART_BYTES) return jsonError(413, 'part_too_large', 'Upload parts must be 8 MB or less.');
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_PART_BYTES) return jsonError(413, 'part_too_large', 'Upload parts must be 8 MB or less.');
  try {
    const part = await uploadSourcePart(id, uploadId, partNumber, body);
    return Response.json(part, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    return jsonError(400, 'upload_part_failed', (error as Error).message.slice(0, 500));
  }
}
