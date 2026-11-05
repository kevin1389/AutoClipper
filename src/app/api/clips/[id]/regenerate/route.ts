import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { resolveEdits } from '@/lib/render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Expands the same moment's bounds; the browser worker performs the re-render. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  const clip = await db.getClipForOwner(id, auth.user.id);
  if (!clip) return jsonError(404, 'clip_not_found', 'That clip does not exist.');
  const project = await db.getProjectForOwner(clip.projectId, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  const current = resolveEdits(clip);
  const sourceDuration = project.durationMs ?? current.endMs + 2_000;
  const startMs = Math.max(0, Math.round(current.startMs - 1_200));
  const endMs = Math.min(sourceDuration, Math.round(current.endMs + 1_500));
  const edits = { ...current, startMs, endMs };
  await db.updateClip(id, { edits, status: 'pending', error: null });
  const { buildProjectView } = await import('@/lib/project-view');
  const view = await buildProjectView(project.id, auth.user.id);
  return Response.json(
    { ok: true, clip: view?.clips.find((entry) => entry.id === id) ?? null },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
