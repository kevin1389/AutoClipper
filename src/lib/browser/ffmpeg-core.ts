/**
 * Minimal same-origin loader for FFmpeg.wasm's ESM core.
 *
 * The @ffmpeg/ffmpeg convenience wrapper creates its inner worker with a
 * dynamic `new URL(classWorkerURL, import.meta.url)`. Turbopack cannot resolve
 * that expression at build time, so this worker talks to the official
 * @ffmpeg/core module directly. No CDN, server process or native binary is
 * involved.
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
}

interface CoreFactory {
  (options: { wasmBinary: ArrayBuffer }): Promise<FfmpegCore>;
}

type LogHandler = (entry: { type: string; message: string }) => void;
type ProgressHandler = (entry: { progress: number; time: number }) => void;

const loadModule = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<{ default: CoreFactory }>;

export class BrowserFfmpeg {
  loaded = false;
  private core: FfmpegCore | null = null;
  private logHandlers: LogHandler[] = [];
  private progressHandlers: ProgressHandler[] = [];
  private sourceMounted = false;

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

  async exec(args: string[]): Promise<number> {
    const core = this.requireCore();
    core.reset();
    core.exec(...args);
    return core.ret;
  }

  async ffprobe(args: string[]): Promise<number> {
    const core = this.requireCore();
    core.reset();
    const result = core.ffprobe(...args);
    return Number.isFinite(result) ? result : core.ret;
  }
}
