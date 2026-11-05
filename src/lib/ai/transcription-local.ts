import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TimedWord, TranscriptSegment } from '../types';
import { estimateWordTimings } from './timing';
import {
  ProviderError,
  type TranscriptionChunkInput,
  type TranscriptionChunkResult,
  type TranscriptionProvider,
} from './types';

/**
 * Local Faster-Whisper transcription.
 *
 * The worker shells out to `worker/whisper_transcribe.py`, which decodes the
 * audio with the project's FFmpeg and runs faster-whisper on this machine. No
 * API key, no paid service, and nothing leaves the host once the model file is
 * cached. Word-level timings come from the model.
 */

interface HelperWord {
  word: string;
  start: number;
  end: number;
}

interface HelperSegment {
  start: number;
  end: number;
  text: string;
  words?: HelperWord[];
}

interface HelperOutput {
  language?: string | null;
  languageProbability?: number;
  durationSeconds?: number;
  segments?: HelperSegment[];
}

interface HelperErrorPayload {
  error?: { code?: string; message?: string; hint?: string };
}

export interface LocalWhisperOptions {
  pythonPath: string;
  helperPath: string;
  model: string;
  device: string;
  computeType: string;
  modelDir: string;
  threads: number;
  language: string | null;
  ffmpegPath: string;
}

function runHelper(
  pythonPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep the tail only: model loaders can be chatty.
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new ProviderError(
          'whisper_spawn_failed',
          `Could not start the local transcription helper (${pythonPath}): ${error.message}`,
        ),
      );
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseHelperError(stderr: string): { code: string; message: string; hint?: string } | null {
  const lines = stderr.trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as HelperErrorPayload;
      if (parsed.error?.message) {
        return {
          code: parsed.error.code ?? 'whisper_failed',
          message: parsed.error.message,
          hint: parsed.error.hint,
        };
      }
    } catch {
      // not the JSON error line
    }
  }
  return null;
}

function toProviderError(
  error: { code: string; message: string; hint?: string },
  model: string,
): ProviderError {
  switch (error.code) {
    case 'INSUFFICIENT_MEMORY':
      return new ProviderError(
        'insufficient_memory',
        `${error.message}${error.hint ? ` ${error.hint}` : ''}`,
      );
    case 'MISSING_DEPENDENCY':
      return new ProviderError(
        'whisper_not_installed',
        `${error.message} Run \"npm run setup:whisper\" and restart the worker.`,
      );
    case 'MODEL_LOAD_FAILED':
      return new ProviderError(
        'whisper_model_failed',
        `${error.message}${error.hint ? ` ${error.hint}` : ''} (WHISPER_MODEL=${model})`,
        { retryable: true },
      );
    default:
      return new ProviderError(
        error.code.toLowerCase(),
        `${error.message}${error.hint ? ` ${error.hint}` : ''}`,
      );
  }
}

export function createLocalWhisperTranscriber(options: LocalWhisperOptions): TranscriptionProvider {
  const label = `faster-whisper ${options.model} (local ${options.device}/${options.computeType})`;

  return {
    id: 'local-whisper',
    label,
    async transcribeChunk(chunk: TranscriptionChunkInput): Promise<TranscriptionChunkResult> {
      const outputPath = path.join(os.tmpdir(), `autoclipper-whisper-${randomUUID()}.json`);
      const args = [
        options.helperPath,
        '--audio',
        chunk.audioPath,
        '--model',
        options.model,
        '--device',
        options.device,
        '--compute-type',
        options.computeType,
        '--ffmpeg',
        options.ffmpegPath,
        '--model-dir',
        options.modelDir,
        '--threads',
        String(options.threads),
        '--output',
        outputPath,
      ];
      const language = options.language?.trim();
      if (language) args.push('--language', language);

      // CPU inference is roughly realtime-ish to ~10x realtime depending on the
      // model, so allow generous headroom before declaring a timeout.
      const timeoutMs = Math.max(180_000, Math.round(chunk.durationMs * 3) + 180_000);

      let result: Awaited<ReturnType<typeof runHelper>>;
      try {
        result = await runHelper(options.pythonPath, args, timeoutMs);
      } finally {
        void fsp.rm(outputPath, { force: true });
      }

      if (result.signal === 'SIGKILL' && result.code === null) {
        throw new ProviderError(
          'whisper_timeout',
          `Local transcription was stopped after ${Math.round(timeoutMs / 1000)}s. Use a smaller WHISPER_MODEL (tiny/base) or a faster machine.`,
        );
      }

      if (result.code !== 0) {
        if (result.code === 137) {
          throw new ProviderError(
            'insufficient_memory',
            'The transcription helper was killed, which usually means the machine ran out of memory. Use WHISPER_MODEL=tiny or add RAM.',
          );
        }
        const parsed = parseHelperError(result.stderr);
        if (parsed) throw toProviderError(parsed, options.model);
        throw new ProviderError(
          'whisper_failed',
          `Local transcription failed (exit ${result.code}). ${result.stderr.trim().split('\n').slice(-1)[0]?.slice(0, 300) ?? ''}`,
        );
      }

      let payload: HelperOutput;
      try {
        const raw = await fsp.readFile(outputPath, 'utf8');
        payload = JSON.parse(raw) as HelperOutput;
      } catch (error) {
        throw new ProviderError(
          'whisper_output_invalid',
          `The transcription helper produced no readable output: ${(error as Error).message}`,
        );
      }

      const offset = chunk.offsetMs;
      const segments: TranscriptSegment[] = (payload.segments ?? [])
        .map((segment) => ({
          text: (segment.text ?? '').trim(),
          startMs: Math.round(segment.start * 1000) + offset,
          endMs: Math.round(segment.end * 1000) + offset,
        }))
        .filter((segment) => segment.text.length > 0);

      const words: TimedWord[] = [];
      for (const segment of payload.segments ?? []) {
        for (const word of segment.words ?? []) {
          const text = (word.word ?? '').trim();
          if (!text) continue;
          const startMs = Math.round(word.start * 1000) + offset;
          const endMs = Math.max(startMs + 40, Math.round(word.end * 1000) + offset);
          words.push({ text, startMs, endMs });
        }
      }

      let timing: 'provider' | 'estimated' = 'provider';
      if (words.length === 0 && segments.length > 0) {
        // Extremely rare with word_timestamps=True, but never guess silently.
        words.push(...estimateWordTimings(segments));
        timing = 'estimated';
      }

      return {
        words,
        segments,
        text: segments.map((segment) => segment.text).join(' ').trim(),
        language: payload.language ?? options.language ?? null,
        timing,
      };
    },
  };
}
