import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import {
  ensureProjectDirs,
  fileSize,
  joinStoragePath,
  pathExists,
} from '@/lib/storage';
import { storagePoolConfigured } from '@/lib/storage-providers';
import {
  cleanupSupersededObjects,
  getLatestClipObject,
  storageObjectPath,
  verifyStorageObject,
} from '@/lib/storage-pool';
import type { StorageObjectRecord } from '@/lib/db-sqlite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The browser uploads the MP4 and poster first, then finalizes the database row.
 * A clip is never marked rendered simply because the worker was asked to render
 * it: the file must exist and be at least one byte.
 */
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

  let videoPath: string;
  let posterPath: string | null = null;
  let videoBytes: number;
  let videoObject: StorageObjectRecord | null = null;
  let posterObject: StorageObjectRecord | null = null;

  if (storagePoolConfigured()) {
    videoObject = await getLatestClipObject(id, 'video');
    if (!videoObject) return jsonError(409, 'video_missing', 'The rendered video was not uploaded.');
    try {
      const verified = await verifyStorageObject(videoObject);
      if (!verified.exists) return jsonError(409, 'video_missing', 'The rendered video was not uploaded.');
      videoPath = storageObjectPath(videoObject);
      videoBytes = verified.size;
    } catch (error) {
      return jsonError(503, 'storage_unavailable', (error as Error).message.slice(0, 300));
    }

    posterObject = await getLatestClipObject(id, 'poster');
    if (posterObject) {
      try {
        const verified = await verifyStorageObject(posterObject);
        if (verified.exists) posterPath = storageObjectPath(posterObject);
      } catch {
        // A missing poster must not hide a verified video. The video is the
        // required artifact; the poster can be regenerated with the clip.
      }
    }
  } else {
    const dirs = await ensureProjectDirs(project.id);
    const base = `clip-${String(clip.index + 1).padStart(2, '0')}`;
    videoPath = joinStoragePath(dirs.clips, `${base}.mp4`);
    posterPath = joinStoragePath(dirs.clips, `${base}.jpg`);
    if (!(await pathExists(videoPath))) {
      return jsonError(409, 'video_missing', 'The rendered video was not uploaded.');
    }
    videoBytes = (await fileSize(videoPath)) ?? 0;
    if (!(await pathExists(posterPath))) posterPath = null;
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const width = Math.round(Number(body.width));
  const height = Math.round(Number(body.height));
  const durationMs = Math.round(Number(body.durationMs));
  if (width !== 1080 || height !== 1920) {
    return jsonError(422, 'invalid_output', 'Rendered clips must be 1080x1920.');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return jsonError(422, 'invalid_duration', 'A positive rendered duration is required.');
  }

  await db.updateClip(id, {
    status: 'rendered',
    error: null,
    filePath: videoPath,
    posterPath,
    bytes: videoBytes,
    width,
    height,
    durationMs,
    captionMode: String(body.captionMode ?? 'none').slice(0, 120),
    cropStrategy: String(body.cropStrategy ?? 'crop-center').slice(0, 80),
    edits: body.edits as never,
    effects: body.effects as never,
  });

  if (videoObject) await cleanupSupersededObjects(id, 'video', videoObject.id);
  if (posterObject) await cleanupSupersededObjects(id, 'poster', posterObject.id);
  const view = await (await import('@/lib/project-view')).buildProjectView(project.id, auth.user.id);
  const updated = view?.clips.find((entry) => entry.id === id);
  if (!updated) return jsonError(500, 'clip_view_failed', 'The clip was saved but could not be reloaded.');
  return Response.json({ ok: true, clip: updated }, { headers: { 'cache-control': 'private, no-store' } });
}
