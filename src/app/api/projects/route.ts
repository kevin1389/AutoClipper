import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, processingBlocker, publicConfig } from '@/lib/env';
import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError, unexpectedErrorResponse } from '@/lib/http';
import { probeMedia } from '@/lib/media/ffmpeg';
import { ensureProjectDirs } from '@/lib/storage';
import { MAX_SOURCE_BYTES, localSourcePath } from '@/lib/upload-limits';
import { mimeForExtension, validateUploadCandidate } from '@/lib/upload';
import { MAX_BROWSER_SOURCE_BYTES } from '@/lib/source-upload';
import { fetchYoutubeMetadata, parseYoutubeUrl, YoutubeLookupError } from '@/lib/youtube';
import { resolveAuthorizedMedia } from '@/lib/youtube-content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function titleFromFileName(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || 'Untitled video').slice(0, 120);
}

export async function GET() {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const projects = await db.listProjects(auth.user.id, 60);
  const views = [];
  for (const project of projects.slice(0, 24)) {
    const rendered = (await db.getClips(project.id)).filter((clip) => clip.status === 'rendered').length;
    views.push({ ...project, renderedClips: rendered });
  }
  return Response.json(
    {
      projects: views,
      workerOnline: await db.workerIsOnline(),
      config: publicConfig(),
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}

export async function POST(request: Request) {
  try {
    return await createProject(request);
  } catch (error) {
    console.error('[api/projects] project creation failed:', error);
    return unexpectedErrorResponse(
      error,
      'project_create_failed',
      'Could not create the project',
    );
  }
}

async function createProject(request: Request) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const ownerId = auth.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid_body', 'Expected a JSON request body.');
  }

  const payload = (body ?? {}) as {
    kind?: string;
    fileName?: string;
    size?: number | null;
    url?: string;
    /**
     * Keep the source in the browser's local store instead of R2. This is the
     * normal path for large uploads: it avoids filling the 1 GB object quota
     * with a source that can be larger than the quota itself.
     */
    local?: boolean;
    /** YouTube only: run the whole job from the authorized provider, no upload. */
    auto?: boolean;
  };

  if (payload.kind === 'upload') {
    const validation = validateUploadCandidate(String(payload.fileName ?? ''), payload.size ?? null);
    if (!validation.ok || !validation.extension) {
      return jsonError(400, validation.error?.code ?? 'invalid_upload', validation.error?.message ?? 'Invalid upload.');
    }
    if (payload.size && payload.size > MAX_SOURCE_BYTES) {
      return jsonError(
        413,
        'file_too_large',
        `The source limit is 1 GB. This file is ${(payload.size / 1024 / 1024).toFixed(0)} MB; compress or trim it first.`,
      );
    }

    const id = randomUUID();
    const common = {
      id,
      ownerId,
      title: titleFromFileName(validation.fileName as string),
      sourceKind: 'upload' as const,
      sourceFileName: validation.fileName,
      sourceBytes: payload.size ?? null,
      sourceMime: mimeForExtension(validation.extension),
    };

    if (payload.local === true) {
      const project = await db.createProject({
        ...common,
        sourcePath: localSourcePath(id),
        status: 'ready',
      });
      return Response.json(
        { project, localSource: true, maxUploadBytes: config().maxUploadBytes },
        { status: 201 },
      );
    }

    const project = await db.createProject({ ...common, status: 'draft' });

    return Response.json(
      { project, uploadEndpoint: `/api/projects/${id}/source`, maxUploadBytes: config().maxUploadBytes },
      { status: 201 },
    );
  }

  if (payload.kind === 'youtube') {
    const parsed = parseYoutubeUrl(String(payload.url ?? ''));
    if (!parsed) {
      return jsonError(
        400,
        'invalid_youtube_url',
        'That does not look like a YouTube video link. Paste a youtube.com/watch, youtu.be, or /shorts URL.',
      );
    }

    try {
      const metadata = await fetchYoutubeMetadata(parsed, config().youtube.contentProvider);

      // One-step path: the deployer's authorized provider supplies the media.
      // Nothing here can fetch from YouTube, so an unconfigured provider is a
      // clear refusal rather than a silent failure or a bypass.
      if (payload.auto === true) {
        const resolution = resolveAuthorizedMedia(
          { provider: config().youtube.contentProvider, mediaDir: config().youtube.mediaDir },
          parsed.videoId,
        );
        if (!resolution.available) {
          return jsonError(409, 'youtube_automatic_access_unavailable', resolution.reason, {
            // `code` is reserved for the HTTP error code above; the provider's own
            // reason travels separately so clients can tell the cases apart.
            resolution: resolution.code,
            metadata,
            contentAccess: metadata.contentAccess,
          });
        }

        const { media } = resolution;
        if (media.bytes > MAX_BROWSER_SOURCE_BYTES) {
          return jsonError(
            413,
            'file_too_large',
            `The authorized copy is ${(media.bytes / 1024 / 1024).toFixed(1)} MB; the source limit is 1 GB.`,
            { metadata },
          );
        }

        const id = randomUUID();
        const dirs = await ensureProjectDirs(id);
        const extension = path.extname(media.fileName).toLowerCase();
        const destination = path.join(dirs.source, `input${extension}`);
        try {
          await fsp.copyFile(media.path, destination);
        } catch {
          return jsonError(
            502,
            'authorized_copy_unreadable',
            'The authorized copy exists but could not be read. Check the operator’s media permissions and try again.',
            { metadata },
          );
        }

        let probe;
        try {
          probe = await probeMedia(destination);
        } catch (error) {
          await fsp.rm(destination, { force: true });
          return jsonError(
            422,
            'not_a_video',
            `The authorized copy could not be read as a video: ${(error as Error).message.slice(0, 200)}`,
            { metadata },
          );
        }

        await db.createProject({
          id,
          ownerId,
          title: metadata.title.slice(0, 120),
          sourceKind: 'youtube',
          sourceUrl: metadata.watchUrl,
          sourcePath: destination,
          sourceFileName: media.fileName,
          sourceBytes: media.bytes,
          sourceMime: mimeForExtension(extension),
          status: 'ready',
        });
        await db.updateProject(id, {
          durationMs: probe.durationMs,
          width: probe.width,
          height: probe.height,
          fps: probe.fps,
        });

        // A missing transcription engine is explained on the project page; the
        // source is already stored, so the job can start once it is configured.
        const blocker = processingBlocker();
        let jobId: string | null = null;
        if (!blocker) {
          const job = await db.enqueueJob(id, randomUUID());
          await db.updateProject(id, { statusDetail: 'Waiting for a processing worker', error: null });
          jobId = job.id;
        }

        return Response.json(
          {
            project: await db.getProjectForOwner(id, ownerId),
            metadata,
            automatic: true,
            provider: media.provider,
            jobId,
            blocker,
          },
          { status: 201 },
        );
      }

      // Two-step path: the link itself is the authorized part; it supplies the title, channel
      // and canonical URL. The media file cannot come from YouTube (its API has
      // no download endpoint and its terms forbid extraction), so the media comes
      // from the user. The normal client keeps that File local; the explicit
      // server-copy path remains available for older clients.
      const id = randomUUID();
      const localRequest = payload.local === true;
      if (localRequest) {
        const validation = validateUploadCandidate(String(payload.fileName ?? ''), payload.size ?? null);
        if (!validation.ok || !validation.extension) {
          return jsonError(400, validation.error?.code ?? 'invalid_upload', validation.error?.message ?? 'Invalid upload.');
        }
        if (payload.size && payload.size > MAX_SOURCE_BYTES) {
          return jsonError(413, 'file_too_large', 'The source limit is 1 GB.');
        }
        const project = await db.createProject({
          id,
          ownerId,
          title: metadata.title.slice(0, 120),
          sourceKind: 'youtube',
          sourceUrl: metadata.watchUrl,
          sourcePath: localSourcePath(id),
          sourceFileName: validation.fileName,
          sourceBytes: payload.size ?? null,
          sourceMime: mimeForExtension(validation.extension),
          status: 'ready',
        });
        return Response.json(
          {
            project,
            metadata,
            contentAccess: metadata.contentAccess,
            localSource: true,
            maxUploadBytes: config().maxUploadBytes,
          },
          { status: 201 },
        );
      }

      const project = await db.createProject({
        id,
        ownerId,
        title: metadata.title.slice(0, 120),
        sourceKind: 'youtube',
        sourceUrl: metadata.watchUrl,
        status: 'draft',
      });

      return Response.json(
        {
          project,
          metadata,
          contentAccess: metadata.contentAccess,
          uploadEndpoint: `/api/projects/${id}/source`,
          maxUploadBytes: config().maxUploadBytes,
        },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof YoutubeLookupError) {
        return jsonError(error.code === 'VIDEO_UNAVAILABLE' ? 404 : 502, error.code, error.message);
      }
      return jsonError(502, 'youtube_lookup_failed', 'Could not read metadata for that YouTube video.');
    }
  }

  return jsonError(400, 'unsupported_kind', 'Create projects with kind "upload" or "youtube".');
}

