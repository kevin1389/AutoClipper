'use client';

import type { ClipEdits, ClipView } from '../types';
import type {
  PosterRequest,
  PosterResponse,
  ProbeSourceMessage,
  RenderClipMessage,
  SourceProbeMeta,
  WorkerEvent,
} from './protocol';
import { capturePosterFromVideo } from './poster-capture';

type EventHandler = (event: WorkerEvent) => void;

/**
 * Owns the processing Web Worker. The React page never does media work on the
 * main thread: FFmpeg.wasm and Transformers.js both run inside the worker.
 */
export class BrowserProcessorClient {
  private worker: Worker | null = null;
  private handler: EventHandler;
  private renderResolve: ((clip: ClipView) => void) | null = null;
  private renderReject: ((error: Error) => void) | null = null;
  private sourceFile: File | null = null;
  private probeWaiters = new Map<
    string,
    { resolve: (meta: SourceProbeMeta) => void; reject: (error: Error) => void }
  >();
  private probeCounter = 0;

  constructor(handler: EventHandler) {
    this.handler = handler;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      if (message.type === 'poster-request') {
        void this.respondWithPoster(message);
        return;
      }
      if (message.type === 'source-probe') {
        const waiter = this.probeWaiters.get(message.requestId);
        this.probeWaiters.delete(message.requestId);
        waiter?.resolve(message.meta);
        return;
      }
      if (message.type === 'source-probe-error') {
        const waiter = this.probeWaiters.get(message.requestId);
        this.probeWaiters.delete(message.requestId);
        waiter?.reject(new Error(message.message));
        return;
      }
      if (message.type === 'render-done') {
        this.renderResolve?.(message.clip);
        this.renderResolve = null;
        this.renderReject = null;
      } else if (message.type === 'error') {
        const error = new Error(message.message);
        this.rejectProbes(error);
        this.renderReject?.(error);
        this.renderResolve = null;
        this.renderReject = null;
        this.worker?.terminate();
        this.worker = null;
      }
      this.handler(message);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The browser processing worker crashed.');
      this.rejectProbes(error);
      this.renderReject?.(error);
      this.renderResolve = null;
      this.renderReject = null;
      this.handler({ type: 'error', code: 'worker_crashed', message: error.message });
      worker.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private async respondWithPoster(request: PosterRequest): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      const poster = await capturePosterFromVideo(request.video);
      const buffer = poster.buffer as ArrayBuffer;
      const response: PosterResponse = {
        type: 'poster-response',
        requestId: request.requestId,
        poster: buffer,
      };
      worker.postMessage(response, [buffer]);
    } catch (error) {
      const response: PosterResponse = {
        type: 'poster-response',
        requestId: request.requestId,
        error: (error as Error).message.slice(0, 500),
      };
      worker.postMessage(response);
    }
  }

  start(projectId: string, engine: 'auto' | 'wasm' = 'auto', sourceFile: File | null = null): void {
    this.sourceFile = sourceFile;
    this.ensureWorker().postMessage({ type: 'start', projectId, engine, sourceFile });
  }

  probeSource(projectId: string, sourceFile: File | null): Promise<SourceProbeMeta> {
    const worker = this.ensureWorker();
    const requestId = `probe-${Date.now()}-${this.probeCounter++}`;
    return new Promise<SourceProbeMeta>((resolve, reject) => {
      this.probeWaiters.set(requestId, { resolve, reject });
      const message: ProbeSourceMessage = {
        type: 'probe-source',
        requestId,
        projectId,
        sourceFile,
      };
      worker.postMessage(message);
    });
  }

  private rejectProbes(error: Error): void {
    for (const waiter of this.probeWaiters.values()) waiter.reject(error);
    this.probeWaiters.clear();
  }

  renderClip(
    projectId: string,
    clip: { id: string; index: number; title: string; startMs: number; endMs: number },
    edits: ClipEdits,
    sourceFile: File | null = this.sourceFile,
  ): Promise<ClipView> {
    const worker = this.ensureWorker();
    return new Promise<ClipView>((resolve, reject) => {
      this.renderResolve = resolve;
      this.renderReject = reject;
      const message: RenderClipMessage = {
        type: 'render-clip',
        projectId,
        clipId: clip.id,
        index: clip.index,
        title: clip.title,
        startMs: edits.startMs,
        endMs: edits.endMs,
        edits,
        sourceFile,
      };
      worker.postMessage(message);
    });
  }

  cancel(): void {
    this.rejectProbes(new Error('Processing was cancelled.'));
    this.renderReject?.(new Error('Processing was cancelled.'));
    this.renderResolve = null;
    this.renderReject = null;
    this.worker?.terminate();
    this.worker = null;
    this.sourceFile = null;
  }
}
