import { slugify } from '@/lib/format';
import { fileResponse, jsonError } from '@/lib/http';
import { getClipForOwner } from '@/lib/db';
import { requireUser } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const { id } = await context.params;
  const clip = await getClipForOwner(id, auth.user.id);
  if (!clip) return jsonError(404, 'clip_not_found', 'That clip does not exist.');
  if (clip.status !== 'rendered' || !clip.filePath) {
    return jsonError(409, 'clip_not_ready', 'This clip has not finished rendering.');
  }

  const wantsDownload = new URL(request.url).searchParams.get('download') === '1';
  return fileResponse(request, clip.filePath, {
    contentType: 'video/mp4',
    downloadName: wantsDownload
      ? `${String(clip.index + 1).padStart(2, '0')}-${slugify(clip.title)}.mp4`
      : undefined,
  });
}
