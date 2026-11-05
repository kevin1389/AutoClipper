import fs from 'node:fs/promises';
import path from 'node:path';
import type { TimedWord, TranscriptSegment } from '../types';
import { estimateWordTimings } from './timing';
import {
  ConfigError,
  ProviderError,
  type TranscriptionChunkInput,
  type TranscriptionChunkResult,
  type TranscriptionProvider,
} from './types';

/**
 * OpenAI-compatible speech-to-text.
 *
 * Works with OpenAI (`whisper-1`, `gpt-4o-transcribe`), Groq, and any server
 * exposing POST {baseUrl}/audio/transcriptions. Requests verbose_json with
 * word-level timestamps; providers that do not support word granularity are
 * detected and their segment timings are expanded locally (marked 'estimated').
 */

interface VerboseTranscript {
  text?: string;
  language?: string;
  duration?: number;
  words?: { word?: string; text?: string; start?: number; end?: number }[];
  segments?: { text?: string; start?: number; end?: number }[];
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON
  }
  return body.replace(/\s+/g, ' ').slice(0, 300);
}

export interface OpenAiTranscriptionOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  language?: string | null;
  label?: string;
}

export function createOpenAiTranscriber(options: OpenAiTranscriptionOptions): TranscriptionProvider {
  const { apiKey, baseUrl, model } = options;

  async function requestOnce(
    chunk: TranscriptionChunkInput,
    includeGranularities: boolean,
  ): Promise<VerboseTranscript> {
    const bytes = await fs.readFile(chunk.audioPath);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: chunk.mimeType }),
      path.basename(chunk.audioPath),
    );
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (options.language) form.append('language', options.language);
    if (includeGranularities) {
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ProviderError(
        aborted ? 'transcription_timeout' : 'transcription_network',
        aborted
          ? 'The transcription request timed out.'
          : 'Could not reach the transcription provider. Check the server network and TRANSCRIPTION_BASE_URL.',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text();
      const message = providerMessage(body);
      if (response.status === 400 && includeGranularities && /timestamp_granularities|word/i.test(message)) {
        return requestOnce(chunk, false);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(
          'transcription_auth_failed',
          `The transcription provider rejected the API key (HTTP ${response.status}). Check TRANSCRIPTION_API_KEY and that TRANSCRIPTION_BASE_URL (${
            new URL(baseUrl).host
          }) is correct.`,
          { status: response.status },
        );
      }
      throw new ProviderError(
        'transcription_failed',
        `Transcription provider returned HTTP ${response.status}: ${message}`,
        { retryable: TRANSIENT_STATUS.has(response.status), status: response.status },
      );
    }

    return (await response.json()) as VerboseTranscript;
  }

  async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderError && error.retryable;
        if (!retryable || attempt === 2) throw error;
        await sleep(1200 * (attempt + 1));
      }
    }
    throw lastError;
  }

  return {
    id: 'openai-compatible',
    label: `${model} (${new URL(baseUrl).host})`,
    async transcribeChunk(chunk: TranscriptionChunkInput): Promise<TranscriptionChunkResult> {
      const payload = await withRetry(() => requestOnce(chunk, true));
      const offset = chunk.offsetMs;

      let words: TimedWord[] = [];
      let timing: 'provider' | 'estimated' = 'provider';

      const segments: TranscriptSegment[] = (payload.segments ?? [])
        .map((segment) => ({
          text: (segment.text ?? '').trim(),
          startMs: Math.round((segment.start ?? 0) * 1000) + offset,
          endMs: Math.round((segment.end ?? 0) * 1000) + offset,
        }))
        .filter((segment) => segment.text.length > 0);

      if (payload.words && payload.words.length > 0) {
        words = payload.words
          .map((word) => {
            const text = (word.word ?? word.text ?? '').trim();
            if (!text) return null;
            const startMs = Math.round((word.start ?? 0) * 1000) + offset;
            const endMs = Math.max(startMs + 60, Math.round((word.end ?? word.start ?? 0) * 1000) + offset);
            return { text, startMs, endMs } satisfies TimedWord;
          })
          .filter((word): word is TimedWord => word !== null);
      }

      if (words.length === 0 && segments.length > 0) {
        words = estimateWordTimings(segments);
        timing = 'estimated';
      }

      if (words.length === 0) {
        const fallbackText = (payload.text ?? '').trim();
        if (fallbackText) {
          const segment: TranscriptSegment = {
            text: fallbackText,
            startMs: offset,
            endMs: offset + Math.max(1000, chunk.durationMs),
          };
          segments.push(segment);
          words = estimateWordTimings([segment]);
          timing = 'estimated';
        }
      }

      const text =
        segments.length > 0
          ? segments.map((segment) => segment.text).join(' ')
          : (payload.text ?? '').trim();

      return {
        words,
        segments,
        text,
        language: payload.language ?? options.language ?? null,
        timing,
      };
    },
  };
}


