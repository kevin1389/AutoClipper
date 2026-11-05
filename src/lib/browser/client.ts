'use client';

import type { ClipEdits, ClipView } from '../types';
import type { RenderClipMessage, WorkerEvent } from './protocol';

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

  constructor(handler: EventHandler) {
    this.handler = handler;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./processor.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;
      if (message.type === 'render-done') {
        this.renderResolve?.(message.clip);
        this.renderResolve = null;
        this.renderReject = null;
      } else if (message.type === 'error') {
        const error = new Error(message.message);
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

  start(projectId: string, engine: 'auto' | 'wasm' = 'auto', sourceFile: File | null = null): void {
    this.sourceFile = sourceFile;
    this.ensureWorker().postMessage({ type: 'start', projectId, engine, sourceFile });
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
    this.renderReject?.(new Error('Processing was cancelled.'));
    this.renderResolve = null;
    this.renderReject = null;
    this.worker?.terminate();
    this.worker = null;
    this.sourceFile = null;
  }
}
