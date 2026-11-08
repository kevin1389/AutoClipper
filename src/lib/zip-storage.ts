import fs from 'node:fs';
import { strToU8, Zip, ZipPassThrough } from 'fflate';
import { getBlob, isRemoteObjectPath, pathExists } from './storage';

/**
 * A ZIP stream that can be filled one entry at a time.
 *
 * fflate writes the ZIP format incrementally and has no native/Node
 * dependencies, so the same code works in workerd. The output is connected to
 * a TransformStream writer; every entry chunk yields to the writer's
 * backpressure before the next chunk is read from storage.
 */
export interface StorageZip {
  stream: ReadableStream<Uint8Array>;
  append(name: string, data: Uint8Array | string): Promise<void>;
  appendStream(name: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  finalize(): Promise<void>;
  abort(error: Error): Promise<void>;
}

const REMOTE_READ_ATTEMPTS = 3;
const REMOTE_READ_TIMEOUT_MS = 20_000;
/** One rendered clip is bounded well below this by the upload route. */
const MAX_REMOTE_FILE_BYTES = 100 * 1024 * 1024;
const ENTRY_CHUNK_BYTES = 1024 * 1024;
const OUTPUT_HIGH_WATER_MARK = 4;

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
 * Reads a provider object into memory before handing it to the ZIP writer.
 *
 * A ZIP entry is a single stream: once its bytes have been written, the entry
 * cannot be restarted at an offset. Buffering one clip at a time (the route is
 * sequential) lets a transient provider read be retried before any bytes enter
 * the archive. All eight clips are never held at once.
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
 * Creates a streaming ZIP. The caller must consume `stream` while appending;
 * otherwise the writer's backpressure will intentionally pause the producer.
 */
export function createZipStream(): StorageZip {
  const transform = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, {
    highWaterMark: OUTPUT_HIGH_WATER_MARK,
    size: (chunk) => chunk.byteLength,
  });
  const writer = transform.writable.getWriter();
  let outputChain: Promise<void> = Promise.resolve();
  let failure: Error | null = null;
  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // A generation failure is delivered through the response stream. This no-op
  // handler keeps `done` from becoming an unhandled rejection if the caller
  // aborts before it reaches finalize().
  void done.catch(() => undefined);

  const fail = (error: Error) => {
    if (!failure) failure = error;
    if (!settled) {
      settled = true;
      rejectDone(error);
    }
  };

  const zip = new Zip((error, chunk, final) => {
    if (error) {
      fail(error);
      outputChain = outputChain
        .then(() => writer.abort(error))
        .catch(() => undefined);
      return;
    }
    if (chunk && chunk.byteLength > 0) {
      outputChain = outputChain
        .then(() => writer.write(chunk))
        .catch((writeError) => {
          const converted = writeError instanceof Error ? writeError : new Error(String(writeError));
          fail(converted);
          throw converted;
        });
    }
    if (final) {
      outputChain = outputChain
        .then(() => writer.close())
        .then(() => {
          if (!settled) {
            settled = true;
            resolveDone();
          }
        })
        .catch((closeError) => {
          fail(closeError instanceof Error ? closeError : new Error(String(closeError)));
        });
    }
  });

  const drain = async (): Promise<void> => {
    if (failure) throw failure;
    await outputChain;
    if (failure) throw failure;
  };

  const addEntry = async (
    name: string,
    data: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<void> => {
    if (failure) throw failure;
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    if (data instanceof Uint8Array) {
      if (data.byteLength === 0) {
        entry.push(new Uint8Array(0), true);
        await drain();
        return;
      }
      for (let offset = 0; offset < data.byteLength; offset += ENTRY_CHUNK_BYTES) {
        const end = Math.min(data.byteLength, offset + ENTRY_CHUNK_BYTES);
        entry.push(data.subarray(offset, end), end === data.byteLength);
        await drain();
      }
      return;
    }
    for await (const chunk of data) {
      if (!chunk || chunk.byteLength === 0) continue;
      entry.push(chunk, false);
      await drain();
    }
    entry.push(new Uint8Array(0), true);
    await drain();
  };

  return {
    stream: transform.readable,
    append: async (name, data) => {
      await addEntry(name, typeof data === 'string' ? strToU8(data) : data);
    },
    appendStream: async (name, chunks) => {
      await addEntry(name, chunks);
    },
    finalize: async () => {
      if (failure) throw failure;
      try {
        zip.end();
        await done;
      } catch (error) {
        const converted = error instanceof Error ? error : new Error(String(error));
        fail(converted);
        throw converted;
      }
    },
    abort: async (error) => {
      if (settled) return;
      settled = true;
      try {
        zip.terminate();
      } catch {
        // The archive may already be finished.
      }
      try {
        await writer.abort(error);
      } catch {
        // The response may already be closed.
      }
      rejectDone(error);
    },
  };
}

/**
 * Adds a local or provider object to an on-the-fly ZIP. Remote objects are read
 * with bounded retries before their entry starts; local files stream directly
 * through fflate. The whole archive is never buffered in memory.
 */
export async function appendStorageFile(
  archive: StorageZip,
  target: string,
  name: string,
): Promise<boolean> {
  if (isRemoteObjectPath(target)) {
    const body = await readRemoteFile(target, name);
    if (!body) return false;
    await archive.append(name, body);
    return true;
  }
  if (!(await pathExists(target))) return false;
  await archive.appendStream(name, fs.createReadStream(target));
  return true;
}
