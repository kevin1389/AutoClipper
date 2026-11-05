import { pipeline, env, type ProgressInfo } from '@huggingface/transformers';
import type { TimedWord, TranscriptSegment } from '../types';
import { segmentsFromWords, type DecodedAudio } from './audio';
import type { BrowserTranscript } from './protocol';
import {
  WHISPER_MODEL_ID,
  WHISPER_MODEL_REVISION,
  WHISPER_MODEL_ROOT,
  preloadWhisperAssets,
  whisperAssetCache,
} from './whisper-assets';

// Xenova/whisper-tiny.en is the Transformers.js reference model documented for
// return_timestamps: 'word'. The onnx-community export omits cross-attentions,
// which makes provider word timestamps impossible (it fails rather than
// fabricating timings). The assets are pinned to the reviewed commit.
const MODEL_ID = WHISPER_MODEL_ID;
const CHUNK_SECONDS = 28;
const OVERLAP_SECONDS = 1.5;

type AsrChunk = { text?: string; timestamp?: [number | null, number | null] };
type AsrOutput = { text?: string; chunks?: AsrChunk[]; language?: string };
type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<AsrOutput | AsrOutput[]>;

export interface TranscriptionHooks {
  onModelProgress: (detail: string, fraction: number) => void;
  onEngine: (engine: 'webgpu' | 'wasm', detail: string) => void;
  onProgress: (fraction: number, detail: string) => void;
}

/** A model file/inference-session problem, distinct from bad or silent audio. */
export class ModelLoadError extends Error {
  readonly code = 'whisper_model_load_failed';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelLoadError';
  }
}

/** The model loaded, but Whisper failed while transcribing audio. */
export class TranscriptionError extends Error {
  readonly code = 'whisper_transcription_failed';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranscriptionError';
  }
}

function cleanWord(value: string): string {
  return value.replace(/^\s+/, '').replace(/\s+$/, '');
}

async function canUseWebGpu(): Promise<boolean> {
  try {
    const gpu = (self.navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

function configureModelLoader(): void {
  if (typeof env.backends.onnx.wasm === 'object') {
    env.backends.onnx.wasm.wasmPaths = new URL('/transformers/', self.location.origin).href;
    // The app does not require COOP/COEP headers. Keep inference single-threaded
    // so SharedArrayBuffer availability cannot break the WASM fallback.
    env.backends.onnx.wasm.numThreads = 1;
  }
  // Never make model loading depend on a third-party CDN. These assets are
  // pinned and served from the same origin as the application.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  // Transformers.js appends the model ID (`Xenova/whisper-tiny.en`) itself.
  // The root must therefore be `/models/`, not the model's directory.
  env.localModelPath = '/models/';
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = whisperAssetCache;
}

export class BrowserTranscriber {
  private transcriber: AsrPipeline | null = null;
  private engine: 'webgpu' | 'wasm' = 'wasm';

  async load(hooks: TranscriptionHooks, forceWasm = false): Promise<void> {
    if (this.transcriber) return;
    configureModelLoader();

    const webgpu = !forceWasm && (await canUseWebGpu());
    const attempts: ('webgpu' | 'wasm')[] = webgpu ? ['webgpu', 'wasm'] : ['wasm'];
    const failures: Array<{ engine: 'webgpu' | 'wasm'; phase: 'download' | 'initialize'; error: Error }> = [];

    for (const engine of attempts) {
      let phase: 'download' | 'initialize' = 'download';
      try {
        hooks.onEngine(engine, engine === 'webgpu' ? 'WebGPU' : 'WASM CPU');
        await preloadWhisperAssets(engine, ({ detail, fraction }) => {
          hooks.onModelProgress(detail, fraction);
        });
        phase = 'initialize';
        hooks.onModelProgress(
          `Initializing Whisper tiny.en with ${engine === 'webgpu' ? 'WebGPU' : 'WASM CPU'}`,
          1,
        );
        const options: Record<string, unknown> = {
          device: engine,
          dtype: engine === 'webgpu'
            ? { encoder_model: 'fp16', decoder_model_merged: 'q4' }
            : 'q8',
          progress_callback: (event: ProgressInfo) => {
            // The preloader owns aggregate progress. Only surface the final
            // initialization event here so per-file counters cannot make the
            // bar jump backwards.
            if (event.status === 'ready') {
              hooks.onModelProgress('Whisper model initialized', 1);
            }
          },
        };
        const result = await pipeline('automatic-speech-recognition', MODEL_ID, options as never);
        this.transcriber = result as unknown as AsrPipeline;
        this.engine = engine;
        hooks.onModelProgress('Whisper model ready', 1);
        hooks.onEngine(
          engine,
          engine === 'webgpu' ? 'WebGPU · quantized Whisper tiny.en' : 'WASM CPU · quantized Whisper tiny.en',
        );
        return;
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        failures.push({ engine, phase, error });
        if (engine === 'webgpu') {
          hooks.onEngine('wasm', `WebGPU unavailable (${error.message.slice(0, 120)}); using WASM CPU`);
        }
      }
    }

    const last = failures.at(-1);
    const phase = last?.phase === 'download' ? 'download' : 'initialize';
    const revision = WHISPER_MODEL_REVISION.slice(0, 8);
    const detail = last?.error.message ?? 'No WebGPU or WASM backend was available.';
    throw new ModelLoadError(
      `Whisper model ${phase === 'download' ? 'download' : 'initialization'} failed for ${MODEL_ID}@${revision}. ${detail} The source video and any saved transcript are still intact; retry does not require re-uploading the video.`,
      { cause: last?.error },
    );
  }

  async transcribe(
    audio: DecodedAudio,
    hooks: TranscriptionHooks,
    /** Absolute source offset for a segmented extraction. */
    offsetMs = 0,
  ): Promise<BrowserTranscript> {
    await this.load(hooks);
    if (!this.transcriber) throw new ModelLoadError('The Whisper model is not loaded.');

    const chunkSamples = CHUNK_SECONDS * audio.sampleRate;
    const overlapSamples = Math.round(OVERLAP_SECONDS * audio.sampleRate);
    const totalChunks = Math.max(1, Math.ceil(audio.samples.length / chunkSamples));
    const words: TimedWord[] = [];
    let text = '';
    let language: string | null = 'en';

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSamples;
      const end = Math.min(audio.samples.length, start + chunkSamples);
      if (end <= start) continue;
      hooks.onProgress(
        index / totalChunks,
        `Transcribing audio ${index + 1} of ${totalChunks} with ${this.engine === 'webgpu' ? 'WebGPU' : 'WASM CPU'}`,
      );
      let output: AsrOutput | AsrOutput[];
      try {
        output = await this.transcriber(audio.samples.subarray(start, end), {
          return_timestamps: 'word',
          force_full_sequences: false,
        });
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        throw new TranscriptionError(
          `Whisper loaded successfully, but transcription failed at audio chunk ${index + 1} of ${totalChunks}: ${error.message}`,
          { cause: error },
        );
      }
      const result = Array.isArray(output) ? output[0] : output;
      if (!result) continue;
      language = result.language ?? language;
      const chunks = Array.isArray(result.chunks) ? result.chunks : [];
      const chunkWords: TimedWord[] = [];
      for (const chunk of chunks) {
        const timestamp = chunk.timestamp;
        const wordText = cleanWord(String(chunk.text ?? ''));
        if (!wordText || !timestamp) continue;
        const wordStart = Number(timestamp[0]);
        const wordEnd = Number(timestamp[1]);
        if (!Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd <= wordStart) continue;
        if (wordText.split(/\s+/).filter(Boolean).length > 1 && chunks.length < 4) {
          throw new TranscriptionError(
            'Whisper returned segment timestamps instead of word timestamps. Word-synced captions cannot be produced from this model output.',
          );
        }
        chunkWords.push({
          text: wordText,
          startMs: offsetMs + Math.round((start / audio.sampleRate + wordStart) * 1000),
          endMs: offsetMs + Math.round((start / audio.sampleRate + wordEnd) * 1000),
        });
      }
      const skipBefore =
        index === 0 ? -1 : offsetMs + Math.round(((start + overlapSamples) / audio.sampleRate) * 1000);
      for (const word of chunkWords) {
        if (word.startMs < skipBefore) continue;
        if (words.some((existing) => Math.abs(existing.startMs - word.startMs) < 40 && existing.text === word.text)) continue;
        words.push(word);
      }
      text = `${text} ${result.text ?? chunkWords.map((word) => word.text).join(' ')}`.trim();
      hooks.onProgress((index + 1) / totalChunks, `Transcribed ${index + 1} of ${totalChunks} audio chunks`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    words.sort((a, b) => a.startMs - b.startMs);
    if (words.length === 0) {
      throw new Error('No speech was detected in this video. AutoClipper will not invent a transcript.');
    }
    const segments: TranscriptSegment[] = segmentsFromWords(words);
    return {
      provider: `transformers.js ${MODEL_ID} (${this.engine}, same-origin)`,
      language,
      timing: 'provider',
      text: text || words.map((word) => word.text).join(' '),
      words,
      segments,
    };
  }
}

export const WHISPER_MODEL = MODEL_ID;
