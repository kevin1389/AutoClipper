import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import * as db from '@/lib/db';
import { requireUser } from '@/lib/api-auth';
import { slugify } from '@/lib/format';
import { jsonError } from '@/lib/http';
import { pathExists } from '@/lib/storage';
import { appendStorageFile } from '@/lib/zip-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * archiver is CommonJS and marked external. Resolving it from the project root
 * with createRequire keeps it out of the bundler and works in every module
 * format Next.js may emit for route handlers.
 */
const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));

interface ZipArchive {
  pipe(destination: PassThrough): void;
  file(filePath: string, data: { name: string }): void;
  append(content: string | Readable, data: { name: string }): void;
  finalize(): Promise<void>;
  abort(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

type ZipArchiveConstructor = new (options?: { zlib?: { level?: number } }) => ZipArchive;
type ArchiverFactory = (format: 'zip', options?: { zlib?: { level?: number } }) => ZipArchive;

// archiver v8 ships ES modules with named classes; v7 exported a factory function.
const archiverModule = nodeRequire('archiver') as {
  ZipArchive?: ZipArchiveConstructor;
  default?: ArchiverFactory;
};

function createZipArchive(options: { zlib?: { level?: number } }): ZipArchive {
  if (typeof archiverModule.ZipArchive === 'function') {
    return new archiverModule.ZipArchive(options);
  }
  if (typeof archiverModule.default === 'function') {
    return archiverModule.default('zip', options);
  }
  throw new Error('The installed archiver package does not expose a zip archive constructor.');
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

  const archive = createZipArchive({ zlib: { level: 0 } });
  const passThrough = new PassThrough();
  archive.on('warning', () => undefined);
  archive.on('error', () => {
    passThrough.destroy();
  });
  archive.pipe(passThrough);

  const manifest: {
    project: string;
    generatedAt: string;
    clips: { index: number; title: string; startMs: number; endMs: number; file: string }[];
  } = { project: project.title, generatedAt: new Date().toISOString(), clips: [] };

  try {
    for (const clip of clips) {
      const detailed = await db.getClipForOwner(clip.id, auth.user.id);
      if (!detailed?.filePath || !(await pathExists(detailed.filePath))) continue;
      const fileName = `${String(clip.index + 1).padStart(2, '0')}-${slugify(clip.title)}.mp4`;
      if (!(await appendStorageFile(archive, detailed.filePath, fileName))) continue;
      manifest.clips.push({
        index: clip.index + 1,
        title: clip.title,
        startMs: clip.startMs,
        endMs: clip.endMs,
        file: fileName,
      });
    }
  } catch (error) {
    // The response has not started yet, so report a retryable storage failure
    // instead of streaming a truncated ZIP to the browser.
    try {
      archive.abort();
    } catch {
      // The archive may not have started.
    }
    return jsonError(
      503,
      'zip_storage_unavailable',
      `The clip archive could not be prepared because storage did not return a complete file. Retry the download. ${(error as Error).message.slice(0, 300)}`,
      { retryable: true },
    );
  }

  if (manifest.clips.length === 0) {
    archive.abort();
    return jsonError(409, 'no_rendered_clips', 'Rendered clip files are missing from storage.');
  }

  archive.append(JSON.stringify(manifest, null, 2), { name: 'clips.json' });
  void archive.finalize();

  return new Response(Readable.toWeb(passThrough) as ReadableStream, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${slugify(project.title, 'autoclipper')}-clips.zip"`,
      'cache-control': 'no-store',
    },
  });
}
