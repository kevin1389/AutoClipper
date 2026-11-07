/**
 * Minimal same-origin loader for FFmpeg.wasm's ESM core.
 *
 * The @ffmpeg/ffmpeg convenience wrapper creates its inner worker with a
 * dynamic `new URL(classWorkerURL, import.meta.url)`. Turbopack cannot resolve
 * that expression at build time, so this worker talks to the official
 * @ffmpeg/core module directly. No CDN, server process or native binary is
 * involved.
 *
 * A wasm trap is not an ordinary FFmpeg command failure. Once the core traps,
 * its function table and heap can no longer be trusted. The wrapper marks the
 * instance unhealthy so the processor can dispose it, mount the source on a
 * fresh core and retry instead of reusing corrupted state.
 */

export interface FfmpegCore {
  loaded: boolean;
  FS: {
    writeFile(path: string, data: Uint8Array | ArrayBuffer | string): void;
    readFile(path: string, options?: { encoding?: 'utf8' }): Uint8Array | string;
    unlink(path: string): void;
    mkdir(path: string): void;
    /** WORKERFS reads a File/Blob on demand instead of copying it to MEMFS. */
    filesystems: { WORKERFS: unknown };
    mount(filesystem: unknown, options: Record<string, unknown>, path: string): void;
    unmount(path: string): void;
  };
  setLogger(logger: (entry: { type: string; message: string }) => void): void;
  setProgress(handler: (entry: { progress: number; time: number }) => void): void;
  exec(...args: string[]): number;
  ffprobe(...args: string[]): number;
  reset(): void;
  ret: number;
  HEAPU8?: Uint8Array;
}

interface CoreFactory {
  (options: { wasmBinary: ArrayBuffer }): Promise<FfmpegCore>;
}

type LogHandler = (entry: { type: string; message: string }) => void;
type ProgressHandler = (entry: { progress: number; time: number }) => void;

const loadModule = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<{ default: CoreFactory }>;

/** The wasm core trapped or aborted; the instance must not be reused. */
export class FfmpegCoreError extends Error {
  readonly code = 'ffmpeg_wasm_core_crashed';
  readonly generation: number;
  readonly execCount: number;
  readonly operation: 'exec' | 'ffprobe';
  readonly memoryBytes: number;

  constructor(
    message: string,
    options: {
      cause: unknown;
      generation: number;
      execCount: number;
      operation: 'exec' | 'ffprobe';
      memoryBytes: number;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'FfmpegCoreError';
    this.generation = options.generation;
    this.execCount = options.execCount;
    this.operation = options.operation;
    this.memoryBytes = options.memoryBytes;
  }
}

export function isFfmpegCoreError(error: unknown): error is FfmpegCoreError {
  return (
    error instanceof FfmpegCoreError ||
    (error instanceof Error &&
      (error.name === 'FfmpegCoreError' ||
        (error as { code?: unknown }).code === 'ffmpeg_wasm_core_crashed'))
  );
}

export class BrowserFfmpeg {
  loaded = false;
  private static nextGeneration = 1;
  readonly generation = BrowserFfmpeg.nextGeneration++;
  private core: FfmpegCore | null = null;
  private logHandlers: LogHandler[] = [];
  private progressHandlers: ProgressHandler[] = [];
  private sourceMounted = false;
  private execCount = 0;

  on(event: 'log', handler: LogHandler): void {
    if (event === 'log') this.logHandlers.push(handler);
  }

  onProgress(handler: ProgressHandler): void {
    this.progressHandlers.push(handler);
  }

  async load(): Promise<void> {
    if (this.loaded && this.core) return;
    const origin = self.location.origin;
    const response = await fetch(`${origin}/ffmpeg/ffmpeg-core.wasm`);
    if (!response.ok) throw new Error(`Could not load FFmpeg.wasm (HTTP ${response.status}).`);
    const wasmBinary = await response.arrayBuffer();
    const module = await loadModule(`${origin}/ffmpeg/ffmpeg-core.js`);
    const core = await module.default({ wasmBinary });
    core.setLogger((entry) => {
      for (const handler of this.logHandlers) handler(entry);
    });
    core.setProgress((entry) => {
      for (const handler of this.progressHandlers) handler(entry);
    });
    this.core = core;
    this.loaded = true;
  }

  private requireCore(): FfmpegCore {
    if (!this.core || !this.loaded) throw new Error('FFmpeg.wasm is not loaded.');
    return this.core;
  }

  /**
   * Mounts the original, still on disk, through FFmpeg's WORKERFS. The bytes
   * stay in the File/Blob and are read on demand by the worker; they are not
   * copied into the JS heap or the WASM MEMFS. This is what makes a large
   * source possible without also filling R2.
   */
  async mountSource(source: Blob | File, name = 'input.mp4'): Promise<void> {
    const core = this.requireCore();
    await this.unmountSource();
    try {
      core.FS.mkdir('/source');
    } catch {
      // The directory already exists from an earlier mount.
    }
    const canonicalName = name.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'input.mp4';
    const options =
      source instanceof File
        ? {
            files: [
              new File([source], canonicalName, {
                type: source.type || 'video/mp4',
                lastModified: source.lastModified,
              }),
            ],
          }
        : { blobs: [{ name: canonicalName, data: source }] };
    core.FS.mount(core.FS.filesystems.WORKERFS, options, '/source');
    this.sourceMounted = true;
  }

  async unmountSource(): Promise<void> {
    if (!this.sourceMounted) return;
    try {
      this.requireCore().FS.unmount('/source');
    } finally {
      this.sourceMounted = false;
    }
  }

  async writeFile(path: string, data: Uint8Array | ArrayBuffer | string): Promise<void> {
    this.requireCore().FS.writeFile(path, data);
  }

  async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
    const core = this.requireCore();
    return encoding ? core.FS.readFile(path, { encoding }) : core.FS.readFile(path);
  }

  async createDir(path: string): Promise<void> {
    this.requireCore().FS.mkdir(path);
  }

  async deleteFile(path: string): Promise<void> {
    this.requireCore().FS.unlink(path);
  }

  get memoryBytes(): number {
    return this.core?.HEAPU8?.byteLength ?? 0;
  }

  private crashMessage(operation: 'exec' | 'ffprobe', error: unknown): FfmpegCoreError {
    this.loaded = false;
    const cause = error instanceof Error ? error : new Error(String(error));
    return new FfmpegCoreError(
      `FFmpeg.wasm core trapped during ${operation} (generation ${this.generation}, exec ${this.execCount}): ${cause.message}`,
      {
        cause,
        generation: this.generation,
        execCount: this.execCount,
        operation,
        memoryBytes: this.memoryBytes,
      },
    );
  }

  async exec(args: string[]): Promise<number> {
    const core = this.requireCore();
    this.execCount += 1;
    core.reset();
    try {
      const result = core.exec(...args);
      if (result === undefined) {
        throw new Error('FFmpeg.wasm returned no exit status.');
      }
      return core.ret;
    } catch (error) {
      throw this.crashMessage('exec', error);
    }
  }

  async ffprobe(args: string[]): Promise<number> {
    const core = this.requireCore();
    this.execCount += 1;
    core.reset();
    try {
      const result = core.ffprobe(...args);
      const status = Number.isFinite(result) ? result : core.ret;
      if (!Number.isFinite(status)) {
        throw new Error('FFprobe returned no exit status.');
      }
      return status;
    } catch (error) {
      throw this.crashMessage('ffprobe', error);
    }
  }

  /** Drops the corrupt wasm instance; Chrome can reclaim its heap. */
  dispose(): void {
    try {
      if (this.sourceMounted) this.core?.FS.unmount('/source');
    } catch {
      // The core may already be unusable; disposal is still required.
    }
    this.sourceMounted = false;
    this.core = null;
    this.loaded = false;
  }
}
