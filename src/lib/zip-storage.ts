import { Readable } from 'node:stream';
import { getBlob, isRemoteObjectPath, pathExists } from './storage';

export interface ArchiveAppender {
  append(content: string | Readable, data: { name: string }): void;
  file(filePath: string, data: { name: string }): void;
}

const REMOTE_READ_ATTEMPTS = 3;
const REMOTE_READ_TIMEOUT_MS = 20_000;
/** One rendered clip is bounded well below this by the upload route. */
const MAX_REMOTE_FILE_BYTES = 100 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads a provider body with a deadline. The fetch controller in s3-client only
 * covers response headers; once a 200 is returned a stalled socket could hold
 * the ZIP request open forever. Cancelling the reader makes that failure
 * retryable and bounds the whole download.
 */
async function readBodyWithTimeout(
  body: ReadableStream<Uint8Array>,
  name: string,
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel('storage read timed out').catch(() => undefined);
      reject(new Error(`read timed out after ${REMOTE_READ_TIMEOUT_MS}ms`));
    }, REMOTE_READ_TIMEOUT_MS);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REMOTE_FILE_BYTES) {
        await reader.cancel('archive size limit').catch(() => undefined);
        throw new Error(`the stored file is larger than the ${MAX_REMOTE_FILE_BYTES} byte archive limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (total === 0) throw new Error(`${name} returned an empty body`);
  return Buffer.concat(chunks, total);
}

/**
 * Reads a provider object into memory before handing it to archiver.
 *
 * A ZIP is a single stream: once an entry has started, archiver cannot restart
 * it at a byte offset. Passing the provider's network stream straight through
 * meant a transient B2/undici socket close became a truncated ZIP and, worse, an
 * uncaught stream error. Buffering one clip at a time (the route is sequential)
 * lets a failed body be retried before any bytes enter the archive.
 */
async function readRemoteFile(target: string, name: string): Promise<Buffer | null> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REMOTE_READ_ATTEMPTS; attempt += 1) {
    try {
      const object = await getBlob(target);
      if (!object) return null;
      if (object.size > MAX_REMOTE_FILE_BYTES) {
        throw new Error(`the stored file is larger than the ${MAX_REMOTE_FILE_BYTES} byte archive limit`);
      }
      // The bounded reader rejects on a stalled socket, so the retry runs
      // before anything is appended to the archive.
      const body = await readBodyWithTimeout(object.body, name);
      if (object.size > 0 && body.byteLength !== object.size) {
        throw new Error(`storage returned ${body.byteLength} of ${object.size} bytes`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < REMOTE_READ_ATTEMPTS) {
        console.warn(
          `[ac-zip] ${name} read attempt ${attempt} failed (${errorMessage(error)}); retrying`,
        );
        await wait(250 * attempt);
      }
    }
  }
  throw new Error(`Could not read ${name} from storage after ${REMOTE_READ_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}

/**
 * Adds a local or provider object to an on-the-fly ZIP. Local files are streamed
 * by archiver; provider objects are read with bounded retries first so a
 * transient network reset cannot corrupt the archive.
 */
export async function appendStorageFile(
  archive: ArchiveAppender,
  target: string,
  name: string,
): Promise<boolean> {
  if (isRemoteObjectPath(target)) {
    const body = await readRemoteFile(target, name);
    if (!body) return false;
    archive.append(Readable.from(body), { name });
    return true;
  }
  if (!(await pathExists(target))) return false;
  archive.file(target, { name });
  return true;
}
