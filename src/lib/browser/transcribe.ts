import { pipeline, env, type ProgressInfo } from '@huggingface/transformers';
import type { TimedWord, TranscriptSegment } from '../types';
import { segmentsFromWords, type DecodedAudio } from './audio';
import type { BrowserTranscript } from './protocol';
import { parseWhisperWords, type WhisperResultLike } from './whisper-words';
import { transcriptionWindows } from './whisper-chunks';
import {
  cleanupTranscriptWords,
  hasSpeechEnergy,
  isTranscriptPlaceholder,
  isWordOwnedByRange,
  largestWordGap,
} from './transcript-cleanup';
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

type AsrOutput = WhisperResultLike & { language?: string };
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

  /** Backend actually initialized (WebGPU may fall back to WASM). */
  get backend(): 'webgpu' | 'wasm' {
    return this.engine;
  }

  async load(hooks: TranscriptionHooks, forceWasm = false): Promise<void> {
    if (this.transcriber) return;
    const startedAt = performance.now();
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
        console.info(
          `[ac-timing] whisper-model-${engine} ${Math.round(performance.now() - startedAt)}ms`,
        );
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
    const transcriber = this.transcriber;
    if (!transcriber) throw new ModelLoadError('The Whisper model is not loaded.');

    const windows = transcriptionWindows(audio.samples.length, audio.sampleRate);
    if (windows.length === 0) {
      throw new Error('No audio samples were available for transcription.');
    }
    const words: TimedWord[] = [];
    let language: string | null = 'en';
    let estimatedTiming = false;
    let mergedChunks = 0;
    let segmentChunks = 0;
    let untimedChunks = 0;
    let emptyWindows = 0;
    let sparseWindows = 0;
    let droppedWindows = 0;
    let repairAttempts = 0;
    let repairedWindows = 0;
    const sampleTexts: string[] = [];

    for (const chunk of windows) {
      const start = chunk.startSample;
      const end = chunk.endSample;
      hooks.onProgress(
        chunk.index / windows.length,
        `Transcribing audio ${chunk.index + 1} of ${windows.length} with ${this.engine === 'webgpu' ? 'WebGPU' : 'WASM CPU'}`,
      );
      let output: AsrOutput | AsrOutput[];
      const chunkStartedAt = performance.now();
      try {
        output = await transcriber(audio.samples.subarray(start, end), {
          return_timestamps: 'word',
          force_full_sequences: false,
          // The decoder can lock into a three-token loop on noisy far-field
          // speech. This is a decoding guard, not a post-hoc edit, so it costs
          // no extra inference and prevents the loop instead of cleaning it.
          no_repeat_ngram_size: 3,
        });
        console.info(
          `[ac-timing] whisper-chunk ${this.engine} ${chunk.index + 1}/${windows.length} ${Math.round(performance.now() - chunkStartedAt)}ms`,
        );
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        throw new TranscriptionError(
          `Whisper loaded successfully, but transcription failed at audio chunk ${chunk.index + 1} of ${windows.length}: ${error.message}`,
          { cause: error },
        );
      }
      const result = Array.isArray(output) ? output[0] : output;
      if (!result) continue;
      language = result.language ?? language;
      // Accept word-level chunks, merged token groups and segment-level
      // responses. Provider word timings are preserved; segment entries are
      // expanded inside their own window instead of failing the project.
      const parsed = parseWhisperWords(result, {
        offsetMs: offsetMs + chunk.startMs,
        durationMs: chunk.endMs - chunk.startMs,
        fallbackText: result.text ?? '',
      });
      if (parsed.timing === 'estimated') estimatedTiming = true;
      mergedChunks += parsed.stats.mergedChunks;
      segmentChunks += parsed.stats.segmentChunks;
      untimedChunks += parsed.stats.untimedChunks;
      if (sampleTexts.length < 3) sampleTexts.push(...parsed.stats.samples.slice(0, 3 - sampleTexts.length));
      const ownerStart = offsetMs + (chunk.index === 0 ? 0 : chunk.skipBeforeMs);
      const ownerEnd = offsetMs + chunk.endMs;
      let chunkWords = parsed.words.filter((word) => isWordOwnedByRange(word, ownerStart, ownerEnd));
      const realChunkWords = chunkWords.filter((word) => !isTranscriptPlaceholder(word.text));
      const realWords = realChunkWords.length;
      const windowSamples = audio.samples.subarray(start, end);
      const windowStartMs = offsetMs + chunk.startMs;
      // Measure gaps on real words only. Timestamp fragments can otherwise
      // make a garbage-filled window look continuous and suppress the retry.
      const uncovered = largestWordGap(realChunkWords, ownerStart, ownerEnd);
      const sparse = realWords > 0 && realWords < 6 && uncovered.gapMs >= 12_000;
      // A handful of surviving fragments can be spread across the window, so
      // there is no large timestamp gap to detect. Treat any low-word window
      // with speech energy as repairable; this catches the 02:30-style garbage
      // that the gap-only check missed without retrying silent windows.
      const windowHasSpeech = hasSpeechEnergy(windowSamples, audio.sampleRate);
      // A decoder-noise window can contain dozens of detached fragments plus a
      // handful of real-looking words. The raw real-word count hides that; the
      // non-word share exposes it.
      const fragmentFlood =
        chunkWords.length >= 20 &&
        realWords < 8 &&
        (chunkWords.length - realWords) / chunkWords.length >= 0.8;
      const needsRepair =
        (realWords < 6 && windowHasSpeech) || (fragmentFlood && windowHasSpeech);
      if (realWords === 0) emptyWindows += 1;
      else if (sparse) sparseWindows += 1;

      if (needsRepair) {
        repairAttempts += 1;
        try {
          // A normal pass can emit nothing (or only a couple of words) on a
          // window with several seconds of speech. Retry only the uncovered
          // part's owning window; the first pass is kept for every healthy
          // window so the two-worker speed profile is unchanged.
          const rate = audio.sampleRate;
          const contextSamples = Math.round(rate * 1);
          const retryStart = Math.max(0, start - contextSamples);
          const retryEnd = Math.min(audio.samples.length, end + contextSamples);
          const retryStartMs = offsetMs + Math.round((retryStart / rate) * 1000);
          const retryDurationMs = Math.round(((retryEnd - retryStart) / rate) * 1000);
          const best: {
            words: TimedWord[];
            real: number;
            stats: ReturnType<typeof parseWhisperWords>['stats'] | null;
            estimated: boolean;
            source: string;
          } = { words: chunkWords, real: realWords, stats: null, estimated: false, source: '' };

          const consider = (candidate: ReturnType<typeof parseWhisperWords>, source: string): boolean => {
            const candidateWords = candidate.words.filter((word) =>
              isWordOwnedByRange(word, ownerStart, ownerEnd),
            );
            const candidateReal = candidateWords.filter((word) => !isTranscriptPlaceholder(word.text)).length;
            if (candidateReal <= best.real) return false;
            best.words = candidateWords;
            best.real = candidateReal;
            best.stats = candidate.stats;
            best.estimated = candidate.timing === 'estimated';
            best.source = source;
            return true;
          };

          const decode = async (
            samples: Float32Array,
            baseMs: number,
            durationMs: number,
            options: Record<string, unknown>,
          ): Promise<ReturnType<typeof parseWhisperWords> | null> => {
            const retryOutput = await transcriber(samples, options);
            const retryResult = Array.isArray(retryOutput) ? retryOutput[0] : retryOutput;
            if (!retryResult) return null;
            return parseWhisperWords(retryResult, {
              offsetMs: baseMs,
              durationMs,
              fallbackText: retryResult.text ?? '',
            });
          };

          // The no-repeat guard stops the decoder loop that produced the
          // hole. One second of context on either side helps it retain the
          // words around the boundary.
          const wordRetry = await decode(
            audio.samples.subarray(retryStart, retryEnd),
            retryStartMs,
            retryDurationMs,
            { return_timestamps: 'word', force_full_sequences: false, no_repeat_ngram_size: 3 },
          );
          if (wordRetry) consider(wordRetry, 'word retry');

          // Some model runs return no word timings while still decoding the
          // speech. Segment timestamps are then expanded across the window so
          // the words survive; they are marked estimated rather than treated
          // as provider-accurate.
          if (best.real < 12) {
            const segmentRetry = await decode(
              windowSamples,
              windowStartMs,
              chunk.endMs - chunk.startMs,
              { return_timestamps: true, force_full_sequences: false, no_repeat_ngram_size: 3 },
            );
            if (segmentRetry) consider(segmentRetry, 'segment fallback');
          }

          // Last resort for a silent word-timestamp pass: plain text still
          // preserves the spoken content. It is only accepted when it beats
          // every timed attempt, and is explicitly marked estimated.
          if (best.real < 12) {
            const plainRetry = await decode(
              windowSamples,
              windowStartMs,
              chunk.endMs - chunk.startMs,
              { return_timestamps: false, force_full_sequences: false, no_repeat_ngram_size: 3 },
            );
            if (plainRetry) consider(plainRetry, 'plain fallback');
          }

          if (best.stats && best.real > realWords) {
            chunkWords = best.words;
            if (best.estimated) estimatedTiming = true;
            mergedChunks += best.stats.mergedChunks;
            segmentChunks += best.stats.segmentChunks;
            untimedChunks += best.stats.untimedChunks;
            repairedWindows += 1;
            console.info(
              `[ac-whisper] repaired ${realWords === 0 ? 'empty' : 'sparse'} window ${chunk.index + 1}/${windows.length} with ${best.real} words via ${best.source}`,
            );
          }
        } catch (caught) {
          // A repair is best-effort. The normal pass already completed and
          // the project must not fail because the optional retry did.
          console.warn(
            `[ac-whisper] window repair ${chunk.index + 1} failed (${caught instanceof Error ? caught.message : String(caught)})`,
          );
        }
      }

      // A few real-looking tokens in a window with no sustained speech are
      // almost always decoder noise around a sound effect or room tone. The
      // same is true for a placeholder flood that survived a failed repair.
      // Retrying silence only invents different words, so discard the window.
      const finalRealWords = chunkWords.filter((word) => !isTranscriptPlaceholder(word.text)).length;
      const finalPlaceholderRatio =
        chunkWords.length > 0 ? (chunkWords.length - finalRealWords) / chunkWords.length : 0;
      const fragmentedWindow =
        chunkWords.length >= 20 && finalRealWords < 8 && finalPlaceholderRatio >= 0.8;
      const silentLowWord = realWords > 0 && realWords < 6 && !windowHasSpeech;
      if (fragmentedWindow || silentLowWord) {
        droppedWindows += 1;
        console.info(
          `[ac-whisper] dropped low-confidence window ${chunk.index + 1}/${windows.length} (${finalRealWords} real of ${chunkWords.length} tokens)`,
        );
        chunkWords = [];
      }

      for (const word of chunkWords) words.push(word);
      hooks.onProgress((chunk.index + 1) / windows.length, `Transcribed ${chunk.index + 1} of ${windows.length} audio chunks`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    words.sort((a, b) => a.startMs - b.startMs);
    const cleaned = cleanupTranscriptWords(words);
    if (cleaned.words.length === 0) {
      throw new Error('No speech was detected in this video. AutoClipper will not invent a transcript.');
    }
    console.info(
      `[ac-whisper] ${cleaned.words.length} words · timing=${estimatedTiming ? 'estimated' : 'provider'} · mergedChunks=${mergedChunks} · segments=${segmentChunks} · untimed=${untimedChunks}` +
        ` · placeholdersRemoved=${cleaned.stats.placeholdersRemoved} · repeatRuns=${cleaned.stats.repeatedRuns} · repeatWordsRemoved=${cleaned.stats.repeatedWordsRemoved}` +
        ` · denseRuns=${cleaned.stats.denseRuns} · denseWordsRemoved=${cleaned.stats.denseWordsRemoved}` +
        ` · emptyWindows=${emptyWindows} · sparseWindows=${sparseWindows} · droppedWindows=${droppedWindows} · repairs=${repairedWindows}/${repairAttempts}` +
        (cleaned.stats.examples.length > 0 ? ` · repeats=${JSON.stringify(cleaned.stats.examples)}` : '') +
        (sampleTexts.length > 0 ? ` · samples=${JSON.stringify(sampleTexts)}` : ''),
    );
    const segments: TranscriptSegment[] = segmentsFromWords(cleaned.words);
    return {
      provider: `transformers.js ${MODEL_ID} (${this.engine}, same-origin)`,
      language,
      timing: estimatedTiming ? 'estimated' : 'provider',
      text: cleaned.text,
      words: cleaned.words,
      segments,
    };
  }
}

export const WHISPER_MODEL = MODEL_ID;
