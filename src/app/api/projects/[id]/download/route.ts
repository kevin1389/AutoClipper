import * as db from '@/lib/db';
import { requireUser } from '@/lib/api-auth';
import { slugify } from '@/lib/format';
import { jsonError } from '@/lib/http';
import { pathExists } from '@/lib/storage';
import { appendStorageFile, createZipStream } from '@/lib/zip-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface ArchiveEntry {
  index: number;
  title: string;
  startMs: number;
  endMs: number;
  fileName: string;
  path: string;
}

/** Zips the rendered MP4 files on the fly (no temporary archive on disk). */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const { id } = await context.params;
  const project = await db.getProjectForOwner(id, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');

  const clips = (await db.getClips(id)).filter((clip) => clip.status === 'rendered');
  if (clips.length === 0) {
    return jsonError(409, 'no_rendered_clips', 'There are no rendered clips to download yet.');
  }

  // Resolve every path before starting the response. Missing clips are skipped
  // exactly as before; storage read failures during generation abort the stream
  // rather than producing a silently truncated archive.
  const entries: ArchiveEntry[] = [];
  for (const clip of clips) {
    const detailed = await db.getClipForOwner(clip.id, auth.user.id);
    if (!detailed?.filePath || !(await pathExists(detailed.filePath))) continue;
    entries.push({
      index: clip.index + 1,
      title: clip.title,
      startMs: clip.startMs,
      endMs: clip.endMs,
      fileName: `${String(clip.index + 1).padStart(2, '0')}-${slugify(clip.title)}.mp4`,
      path: detailed.filePath,
    });
  }
  if (entries.length === 0) {
    return jsonError(409, 'no_rendered_clips', 'Rendered clip files are missing from storage.');
  }

  const archive = createZipStream();
  const manifest: {
    project: string;
    generatedAt: string;
    clips: { index: number; title: string; startMs: number; endMs: number; file: string }[];
  } = { project: project.title, generatedAt: new Date().toISOString(), clips: [] };

  // Start producing only after the Response stream exists, so the consumer
  // provides backpressure. A storage failure aborts the download instead of
  // emitting a ZIP with a truncated entry.
  void (async () => {
    try {
      for (const entry of entries) {
        if (!(await appendStorageFile(archive, entry.path, entry.fileName))) continue;
        manifest.clips.push({
          index: entry.index,
          title: entry.title,
          startMs: entry.startMs,
          endMs: entry.endMs,
          file: entry.fileName,
        });
      }
      if (manifest.clips.length === 0) {
        await archive.abort(new Error('Rendered clip files disappeared from storage.'));
        return;
      }
      await archive.append('clips.json', JSON.stringify(manifest, null, 2));
      await archive.finalize();
    } catch (error) {
      await archive.abort(
        error instanceof Error ? error : new Error(String(error)),
      ).catch(() => undefined);
    }
  })();

  return new Response(archive.stream, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${slugify(project.title, 'autoclipper')}-clips.zip"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
