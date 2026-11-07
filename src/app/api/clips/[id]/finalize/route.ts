import fsp from 'node:fs/promises';
import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { inspectMp4 } from '@/lib/mp4';
import { posterReceiptError } from '@/lib/poster';
import {
  ensureProjectDirs,
  fileSize,
  getBlob,
  isRemoteObjectPath,
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
const MP4_PREFIX_BYTES = 512 * 1024;

async function readMp4Prefix(target: string, size: number): Promise<Uint8Array | null> {
  const length = Math.min(size, MP4_PREFIX_BYTES);
  if (length <= 0) return null;
  if (isRemoteObjectPath(target)) {
    const object = await getBlob(target, { offset: 0, length });
    if (!object) return null;
    return new Uint8Array(await new Response(object.body).arrayBuffer());
  }
  const handle = await fsp.open(target, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } finally {
    await handle.close();
  }
}

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

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const storagePool = storagePoolConfigured();
  const receiptIssue = posterReceiptError(
    { hasPoster: body.hasPoster, posterBytes: body.posterBytes, posterKey: body.posterKey },
    storagePool,
  );
  if (receiptIssue) return jsonError(422, receiptIssue.code, receiptIssue.message);
  const posterBytes = Math.round(Number(body.posterBytes));
  const posterKey = typeof body.posterKey === 'string' && body.posterKey.length > 0 ? body.posterKey : null;

  let videoPath: string;
  let posterPath: string | null = null;
  let videoBytes: number;
  let videoObject: StorageObjectRecord | null = null;
  let posterObject: StorageObjectRecord | null = null;

  if (storagePool) {
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
    if (!posterObject || !posterKey || posterObject.key !== posterKey) {
      return jsonError(409, 'poster_missing', 'The poster for this render was not uploaded.');
    }
    if (posterObject.bytes !== posterBytes) {
      return jsonError(409, 'poster_missing', 'The uploaded poster did not match this render.');
    }
    try {
      const verified = await verifyStorageObject(posterObject);
      if (!verified.exists) {
        return jsonError(409, 'poster_missing', 'The poster for this render was not uploaded.');
      }
      posterPath = storageObjectPath(posterObject);
    } catch (error) {
      return jsonError(503, 'storage_unavailable', (error as Error).message.slice(0, 300));
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
    if (!(await pathExists(posterPath))) {
      return jsonError(422, 'poster_missing', 'The poster for this render was not uploaded.');
    }
    if (((await fileSize(posterPath)) ?? 0) !== posterBytes) {
      return jsonError(422, 'poster_missing', 'The uploaded poster did not match this render.');
    }
  }
  const width = Math.round(Number(body.width));
  const height = Math.round(Number(body.height));
  const durationMs = Math.round(Number(body.durationMs));
  if (width !== 1080 || height !== 1920) {
    return jsonError(422, 'invalid_output', 'Rendered clips must be 1080x1920.');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return jsonError(422, 'invalid_duration', 'A positive rendered duration is required.');
  }

  // A HEAD request only proves that some bytes arrived. Verify the actual
  // object's ISO-BMFF structure before this clip can be marked rendered.
  let prefix: Uint8Array | null = null;
  try {
    prefix = await readMp4Prefix(videoPath, videoBytes);
  } catch (error) {
    return jsonError(503, 'storage_unavailable', (error as Error).message.slice(0, 300));
  }
  const inspection = prefix ? inspectMp4(prefix) : null;
  if (!inspection?.valid) {
    return jsonError(
      422,
      'invalid_video',
      `The uploaded clip did not pass MP4 verification: ${inspection?.reason ?? 'the stored file was empty'}.`,
    );
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
