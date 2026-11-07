import { randomUUID } from 'node:crypto';
import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import {
  contentTypeFor,
  deleteStoragePath,
  ensureProjectDirs,
  joinStoragePath,
  writeUploadStream,
} from '@/lib/storage';
import { storagePoolConfigured } from '@/lib/storage-providers';
import {
  StoragePoolCapacityError,
  StoragePoolUnavailableError,
  storageObjectPath,
  uploadStorageObject,
} from '@/lib/storage-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// A rendered 9:16 60-second clip is normally well below this. Keeping the
// request under Cloudflare's body limit is required because object-storage
// credentials are never exposed to the browser; the authenticated route writes
// to the configured provider or legacy R2.
const MAX_CLIP_BYTES = 95 * 1024 * 1024;

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  const clip = await db.getClipForOwner(id, auth.user.id);
  if (!clip) return jsonError(404, 'clip_not_found', 'That clip does not exist.');
  const project = await db.getProjectForOwner(clip.projectId, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  const asset = new URL(request.url).searchParams.get('asset') ?? 'video';
  if (asset !== 'video' && asset !== 'poster') return jsonError(400, 'invalid_asset', 'asset must be video or poster.');

  const base = `clip-${String(clip.index + 1).padStart(2, '0')}`;
  const declared = Number(request.headers.get('x-file-size') ?? 0);
  const max = asset === 'video' ? MAX_CLIP_BYTES : 2 * 1024 * 1024;
  if (declared > max) return jsonError(413, 'file_too_large', `This ${asset} is too large for the browser upload limit.`);
  if (!request.body) return jsonError(400, 'empty_body', 'The upload had no body.');

  if (storagePoolConfigured()) {
    const extension = asset === 'video' ? 'mp4' : 'jpg';
    const version = randomUUID().slice(0, 8);
    const key = `projects/${project.id}/clips/${base}-${version}.${extension}`;
    try {
      const object = await uploadStorageObject({
        ownerId: auth.user.id,
        projectId: project.id,
        clipId: id,
        kind: asset,
        assetKey: `clip:${id}:${asset}:${version}`,
        key,
        contentType: contentTypeFor(key),
        body: request.body,
        maxBytes: max,
        expectedBytes: declared > 0 ? declared : null,
      });
      return Response.json(
        {
          ok: true,
          bytes: object.bytes,
          asset,
          provider: object.providerId,
          path: storageObjectPath(object),
          key: object.key,
        },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      const status = error instanceof StoragePoolCapacityError ? 507 : error instanceof StoragePoolUnavailableError ? 503 : 502;
      return jsonError(status, 'upload_failed', message);
    }
  }

  const dirs = await ensureProjectDirs(project.id);
  const destination = joinStoragePath(dirs.clips, asset === 'video' ? `${base}.mp4` : `${base}.jpg`);

  // Editing a clip replaces its old MP4/poster. Removing first also makes the
  // local writeUploadStream({flags:'wx'}) safe for re-renders.
  await deleteStoragePath(destination).catch(() => undefined);
  let written: number;
  try {
    written = await writeUploadStream(
      request.body,
      destination,
      max,
      declared > 0 ? declared : null,
    );
  } catch (error) {
    await deleteStoragePath(destination).catch(() => undefined);
    return jsonError(400, 'upload_failed', (error as Error).message.slice(0, 500));
  }
  if (written <= 0) return jsonError(400, 'empty_file', 'The uploaded file was empty.');
  return Response.json(
    { ok: true, bytes: written, asset },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
