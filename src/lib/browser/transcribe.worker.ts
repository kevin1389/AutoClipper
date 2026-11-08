/// <reference lib="webworker" />
import type { DecodedAudio } from './audio';
import type { BrowserTranscript } from './protocol';
import { BrowserTranscriber } from './transcribe';

/**
 * Dedicated Whisper worker owned by `TranscriptionPool`. It loads the model
 * once and then transcribes one section at a time; it never touches FFmpeg or
 * the project API, so a failure here is always recoverable by the processor's
 * serial fallback.
 */

type PoolRequest =
  | { type: 'init'; forceWasm: boolean }
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

const scope = self as unknown as DedicatedWorkerGlobalScope;
let transcriber: BrowserTranscriber | null = null;

function post(message: PoolResponse): void {
  scope.postMessage(message);
}

async function initialize(forceWasm: boolean): Promise<void> {
  try {
    const instance = new BrowserTranscriber();
    await instance.load(
      {
        onModelProgress: (detail, fraction) => post({ type: 'model', detail, fraction }),
        onEngine: (engine, detail) => post({ type: 'engine', engine, detail }),
        onProgress: () => undefined,
      },
      forceWasm,
    );
    transcriber = instance;
    post({ type: 'ready', engine: instance.backend });
  } catch (error) {
    post({
      type: 'init-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function transcribe(message: Extract<PoolRequest, { type: 'transcribe' }>): Promise<void> {
  if (!transcriber) {
    post({ type: 'task-error', id: message.id, message: 'The Whisper worker is not initialized.' });
    return;
  }
  const audio: DecodedAudio = {
    samples: message.samples,
    sampleRate: message.sampleRate,
    durationMs: message.durationMs,
  };
  try {
    const transcript = await transcriber.transcribe(
      audio,
      {
        onModelProgress: (detail, fraction) => post({ type: 'model', detail, fraction }),
        onEngine: (engine, detail) => post({ type: 'engine', engine, detail }),
        onProgress: (fraction, detail) =>
          post({ type: 'progress', id: message.id, fraction, detail }),
      },
      message.offsetMs,
    );
    post({ type: 'result', id: message.id, transcript });
  } catch (error) {
    post({
      type: 'task-error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

scope.onmessage = (event: MessageEvent<PoolRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    void initialize(message.forceWasm);
  } else if (message.type === 'transcribe') {
    void transcribe(message);
  }
};
