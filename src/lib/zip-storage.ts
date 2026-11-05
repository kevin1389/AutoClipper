import { Readable } from 'node:stream';
import { getBlob, isRemoteObjectPath, pathExists } from './storage';

export interface ArchiveAppender {
  append(content: string | Readable, data: { name: string }): void;
  file(filePath: string, data: { name: string }): void;
}

/**
 * Adds a local or provider object to an on-the-fly ZIP without buffering the
 * whole MP4. The provider stream is piped directly into archiver.
 */
export async function appendStorageFile(
  archive: ArchiveAppender,
  target: string,
  name: string,
): Promise<boolean> {
  if (!(await pathExists(target))) return false;
  if (isRemoteObjectPath(target)) {
    const object = await getBlob(target);
    if (!object) return false;
    archive.append(
      Readable.fromWeb(object.body as Parameters<typeof Readable.fromWeb>[0]),
      { name },
    );
    return true;
  }
  archive.file(target, { name });
  return true;
}
