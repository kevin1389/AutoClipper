/// <reference lib="webworker" />
import type { DecodedAudio } from './audio';
import type { BrowserTranscript } from './protocol';

/**
 * A small pool of dedicated Whisper workers.
 *
 * Transcription is 85–97% of a long run's wall time, and one WebGPU session
 * leaves most of the machine idle. Each worker owns its own Transformers.js
 * pipeline, so two independent 5-minute sections can generate concurrently.
 * The processor worker keeps a serial `BrowserTranscriber` fallback: if a
 * worker cannot initialize, crashes, or the pool is slower/unavailable, the
 * same section is transcribed in-process without changing its result.
 */

export interface TranscriptionPoolHooks {
  onModelProgress: (detail: string, fraction: number) => void;
  onEngine: (engine: 'webgpu' | 'wasm', detail: string) => void;
}

export interface TranscriptionPoolOptions {
  /** Requested number of workers; a successful load may return fewer. */
  size: number;
  forceWasm: boolean;
  hooks: TranscriptionPoolHooks;
  assetBaseUrl?: string;
}

type PoolRequest =
  | { type: 'init'; forceWasm: boolean; assetBaseUrl?: string }
  | {
      type: 'transcribe';
      id: number;
      samples: Float32Array;
      sampleRate: number;
      durationMs: number;
      offsetMs: number;
    };

type PoolResponse =
  | { type: 'ready'; engine: 'webgpu' | 'wasm' }
  | { type: 'init-error'; message: string }
  | { type: 'model'; detail: string; fraction: number }
  | { type: 'engine'; engine: 'webgpu' | 'wasm'; detail: string }
  | { type: 'progress'; id: number; fraction: number; detail: string }
  | { type: 'result'; id: number; transcript: BrowserTranscript }
  | { type: 'task-error'; id: number; message: string };

interface Task {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  offsetMs: number;
  onProgress: (fraction: number, detail: string) => void;
  resolve: (transcript: BrowserTranscript) => void;
  reject: (error: Error) => void;
}

interface Slot {
  index: number;
  worker: Worker;
  ready: boolean;
  engine: 'webgpu' | 'wasm' | null;
  busy: Task | null;
  dead: boolean;
}

export class TranscriptionPoolError extends Error {
  readonly code = 'whisper_pool_failed';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranscriptionPoolError';
  }
}

export class TranscriptionPool {
  private readonly requestedSize: number;
  private readonly forceWasm: boolean;
  private readonly hooks: TranscriptionPoolHooks;
  private readonly assetBaseUrl?: string;
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: TranscriptionPoolOptions) {
    this.requestedSize = Math.max(1, Math.floor(options.size));
    this.forceWasm = options.forceWasm;
    this.hooks = options.hooks;
    this.assetBaseUrl = options.assetBaseUrl;
  }

  /** Number of workers that actually initialized. */
  get size(): number {
    return this.slots.length;
  }

  get engines(): ('webgpu' | 'wasm')[] {
    return this.slots.map((slot) => slot.engine ?? 'wasm');
  }

  async load(): Promise<void> {
    for (let index = 0; index < this.requestedSize; index += 1) {
      try {
        const slot = await this.spawn(index);
        if (this.closed) {
          slot.worker.terminate();
          break;
        }
        this.slots.push(slot);
        // The first worker has already filled Cache Storage with the model, so
        // initializing sequentially avoids two concurrent 100 MB downloads.
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (index === 0) {
          throw new TranscriptionPoolError(
            `The parallel Whisper worker could not start: ${cause.message}`,
            { cause },
          );
        }
        console.warn(
          `[ac-whisper-pool] second worker unavailable (${cause.message.slice(0, 160)}); continuing with one`,
        );
        break;
      }
    }
    if (this.slots.length === 0) {
      throw new TranscriptionPoolError('No Whisper worker could be initialized.');
    }
    this.pump();
  }

  transcribe(
    audio: DecodedAudio,
    offsetMs: number,
    onProgress: (fraction: number, detail: string) => void,
  ): Promise<BrowserTranscript> {
    if (this.closed || this.slots.length === 0) {
      return Promise.reject(
        new TranscriptionPoolError('The parallel Whisper pool is not available.'),
      );
    }
    return new Promise<BrowserTranscript>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        // Copy: the caller still owns the section samples (and a serial
        // fallback may need them if this worker fails).
        samples: audio.samples.slice(),
        sampleRate: audio.sampleRate,
        durationMs: audio.durationMs,
        offsetMs,
        onProgress,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  dispose(): void {
    if (this.closed && this.slots.length === 0) return;
    this.closed = true;
    const error = new TranscriptionPoolError('The parallel Whisper pool was closed.');
    for (const slot of this.slots) {
      slot.dead = true;
      try {
        slot.worker.terminate();
      } catch {
        // The worker may already be gone.
      }
      if (slot.busy) {
        const task = slot.busy;
        slot.busy = null;
        task.reject(error);
      }
    }
    this.slots = [];
    for (const task of this.queue.splice(0)) task.reject(error);
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      const slot = this.slots.find((candidate) => candidate.ready && !candidate.busy && !candidate.dead);
      if (!slot) return;
      const task = this.queue.shift();
      if (!task) return;
      slot.busy = task;
      const request: PoolRequest = {
        type: 'transcribe',
        id: task.id,
        samples: task.samples,
        sampleRate: task.sampleRate,
        durationMs: task.durationMs,
        offsetMs: task.offsetMs,
      };
      try {
        slot.worker.postMessage(request, [task.samples.buffer]);
      } catch (error) {
        slot.busy = null;
        task.reject(error instanceof Error ? error : new Error(String(error)));
        this.handleSlotFailure(slot, new TranscriptionPoolError('The Whisper worker could not be reached.'));
      }
    }
  }

  private spawn(index: number): Promise<Slot> {
    return new Promise<Slot>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const slot: Slot = {
        index,
        worker,
        ready: false,
        engine: null,
        busy: null,
        dead: false,
      };
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const fail = (error: Error) => {
        cleanup();
        if (settled) {
          this.handleSlotFailure(slot, error);
          return;
        }
        settled = true;
        slot.dead = true;
        try {
          worker.terminate();
        } catch {
          // Ignore double termination.
        }
        reject(error);
      };

      timer = setTimeout(() => {
        fail(new TranscriptionPoolError(`Whisper worker ${index + 1} did not initialize within 180 seconds.`));
      }, 180_000);

      worker.onmessage = (event: MessageEvent<PoolResponse>) => {
        const message = event.data;
        if (message.type === 'model') {
          if (index === 0) this.hooks.onModelProgress(message.detail, message.fraction);
          return;
        }
        if (message.type === 'engine') {
          if (index === 0) this.hooks.onEngine(message.engine, message.detail);
          return;
        }
        if (message.type === 'ready') {
          slot.ready = true;
          slot.engine = message.engine;
          cleanup();
          if (!settled) {
            settled = true;
            resolve(slot);
          } else {
            this.pump();
          }
          return;
        }
        if (message.type === 'init-error') {
          fail(new TranscriptionPoolError(message.message));
          return;
        }
        if (message.type === 'progress') {
          if (slot.busy?.id === message.id) slot.busy.onProgress(message.fraction, message.detail);
          return;
        }
        if (message.type === 'result') {
          const task = slot.busy;
          if (task?.id === message.id) {
            slot.busy = null;
            task.resolve(message.transcript);
            this.pump();
          }
          return;
        }
        if (message.type === 'task-error') {
          const task = slot.busy;
          if (task?.id === message.id) {
            slot.busy = null;
            task.reject(new TranscriptionPoolError(message.message));
            this.pump();
          }
        }
      };

      worker.onerror = (event) => {
        fail(new TranscriptionPoolError(event.message || `Whisper worker ${index + 1} crashed.`));
      };

      const request: PoolRequest = {
        type: 'init',
        forceWasm: this.forceWasm,
        assetBaseUrl: this.assetBaseUrl,
      };
      worker.postMessage(request);
    });
  }

  private handleSlotFailure(slot: Slot, error: Error): void {
    if (slot.dead && !this.slots.includes(slot)) return;
    slot.dead = true;
    try {
      slot.worker.terminate();
    } catch {
      // Already terminated.
    }
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    if (slot.busy) {
      const task = slot.busy;
      slot.busy = null;
      task.reject(error);
    }
    if (this.slots.length === 0) {
      this.closed = true;
      for (const task of this.queue.splice(0)) task.reject(error);
      return;
    }
    this.pump();
  }
}
