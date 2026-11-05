import { getClipForOwner } from '@/lib/db';
import { requireUser } from '@/lib/api-auth';
import { fileResponse, jsonError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const { id } = await context.params;
  const clip = await getClipForOwner(id, auth.user.id);
  if (!clip?.posterPath) return jsonError(404, 'poster_not_found', 'No poster for this clip.');
  return fileResponse(request, clip.posterPath, { contentType: 'image/jpeg' });
}
