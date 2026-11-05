import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { resolveEdits } from '@/lib/render';
import type { ClipEdits } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIN_CLIP_MS = 4_000;
const MAX_CLIP_MS = 60_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function viewClip(projectId: string, ownerId: string, clipId: string) {
  const { buildProjectView } = await import('@/lib/project-view');
  const view = await buildProjectView(projectId, ownerId);
  return view?.clips.find((clip) => clip.id === clipId) ?? null;
}

/**
 * Saves the editor's overrides. Rendering now happens in the browser worker;
 * this endpoint never claims a new file exists until the browser uploads and
 * finalizes it.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  const clip = await db.getClipForOwner(id, auth.user.id);
  if (!clip) return jsonError(404, 'clip_not_found', 'That clip does not exist.');
  const project = await db.getProjectForOwner(clip.projectId, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const current = resolveEdits(clip);
  const startMs = Math.round(Number(body.startMs ?? current.startMs));
  const endMs = Math.round(Number(body.endMs ?? current.endMs));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0) {
    return jsonError(400, 'invalid_range', 'Start and end must be non-negative numbers in milliseconds.');
  }
  if (endMs - startMs < MIN_CLIP_MS) return jsonError(400, 'clip_too_short', `A clip must be at least ${MIN_CLIP_MS / 1000} seconds long.`);
  if (endMs - startMs > MAX_CLIP_MS) return jsonError(400, 'clip_too_long', `A clip can be at most ${MAX_CLIP_MS / 1000} seconds long.`);
  if (project.durationMs && endMs > project.durationMs + 500) return jsonError(400, 'invalid_range', 'The clip cannot end after the source video does.');
  const rawCaption = body.captionText === undefined ? current.captionText : body.captionText;
  const edits: ClipEdits = {
    startMs,
    endMs,
    captionText: typeof rawCaption === 'string' && rawCaption.trim() ? rawCaption.trim().slice(0, 1200) : null,
    zoomEnabled: body.zoomEnabled === undefined ? current.zoomEnabled : Boolean(body.zoomEnabled),
    zoomIntensity: clamp(Number(body.zoomIntensity ?? current.zoomIntensity), 0.4, 2),
    slowMotionEnabled: body.slowMotionEnabled === undefined ? current.slowMotionEnabled : Boolean(body.slowMotionEnabled),
  };
  await db.updateClip(id, { edits, status: 'pending', error: null });
  return Response.json({ ok: true, clip: await viewClip(project.id, auth.user.id, id) }, { headers: { 'cache-control': 'private, no-store' } });
}
