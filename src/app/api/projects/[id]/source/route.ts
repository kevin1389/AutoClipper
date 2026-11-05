import { randomUUID } from 'node:crypto';
import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { config } from '@/lib/env';
import { jsonError } from '@/lib/http';
import {
  deleteStoragePath,
  ensureProjectDirs,
  isBlobKey,
  joinStoragePath,
  writeUploadStream,
} from '@/lib/storage';
import { storagePoolConfigured } from '@/lib/storage-providers';
import {
  cleanupSupersededSource,
  StoragePoolCapacityError,
  StoragePoolUnavailableError,
  storageObjectPath,
  uploadStorageObject,
} from '@/lib/storage-pool';
import { mimeForExtension, validateUploadCandidate } from '@/lib/upload';
import { isLocalSourcePath } from '@/lib/upload-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Legacy single-request source upload retained for local tooling only. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  const project = await db.getProjectForOwner(id, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  if (project.status === 'processing' || (await db.hasActiveJob(id))) {
    return jsonError(409, 'project_busy', 'This project is processing; wait before replacing the source.');
  }
  const fileName = decodeURIComponent(request.headers.get('x-file-name') ?? '');
  const declaredBytes = Number.parseInt(request.headers.get('x-file-size') ?? '', 10);
  const validation = validateUploadCandidate(fileName, Number.isFinite(declaredBytes) ? declaredBytes : null);
  if (!validation.ok || !validation.extension) {
    return jsonError(400, validation.error?.code ?? 'invalid_upload', validation.error?.message ?? 'Invalid upload.');
  }
  if (!request.body) return jsonError(400, 'empty_body', 'The upload request had no body.');
  const oldSourcePath = await db.getProjectSourcePath(id);

  if (storagePoolConfigured()) {
    const version = randomUUID().slice(0, 8);
    const key = `projects/${id}/source/input-${version}${validation.extension}`;
    try {
      const object = await uploadStorageObject({
        ownerId: auth.user.id,
        projectId: id,
        kind: 'source',
        assetKey: `source:${id}:${validation.extension}:${version}`,
        key,
        contentType: mimeForExtension(validation.extension),
        body: request.body,
        maxBytes: config().maxUploadBytes,
        expectedBytes: Number.isFinite(declaredBytes) ? declaredBytes : null,
      });
      await db.updateProject(id, {
        sourcePath: storageObjectPath(object),
        sourceFileName: validation.fileName,
        sourceBytes: object.bytes,
        sourceMime: mimeForExtension(validation.extension),
        status: 'ready',
        stage: 'queued',
        progress: 0,
        error: null,
        statusDetail: 'Source ready for browser processing',
      });
      await cleanupSupersededSource(id, object.id);
      if (oldSourcePath && oldSourcePath !== storageObjectPath(object) && !isLocalSourcePath(oldSourcePath)) {
        await deleteStoragePath(oldSourcePath).catch(() => undefined);
      }
      return Response.json(
        { ok: true, bytes: object.bytes, probe: null, provider: object.providerId },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      const status = error instanceof StoragePoolCapacityError ? 507 : error instanceof StoragePoolUnavailableError ? 503 : 502;
      return jsonError(status, 'upload_failed', message);
    }
  }

  const dirs = await ensureProjectDirs(id);
  const destination = joinStoragePath(dirs.source, `input${validation.extension}`);
  await deleteStoragePath(destination).catch(() => undefined);
  let written: number;
  try {
    written = await writeUploadStream(request.body, destination, config().maxUploadBytes, Number.isFinite(declaredBytes) ? declaredBytes : null);
  } catch (error) {
    await deleteStoragePath(destination).catch(() => undefined);
    return jsonError(400, 'upload_failed', (error as Error).message.slice(0, 300));
  }
  if (written <= 0) return jsonError(400, 'empty_file', 'That file is empty.');
  await db.updateProject(id, {
    sourcePath: destination,
    sourceFileName: validation.fileName,
    sourceBytes: written,
    sourceMime: mimeForExtension(validation.extension),
    status: 'ready',
    stage: 'queued',
    progress: 0,
    error: null,
    statusDetail: 'Source ready for browser processing',
  });
  return Response.json({ ok: true, bytes: written, probe: isBlobKey(destination) ? null : undefined });
}
