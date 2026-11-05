import fs from 'node:fs/promises';
import { config } from '../env';
import type { TimedWord } from '../types';
import { estimateWordTimings } from './timing';
import {
  ConfigError,
  ProviderError,
  type TranscriptionChunkInput,
  type TranscriptionChunkResult,
  type TranscriptionProvider,
} from './types';

/**
 * TEST-ONLY transcription provider.
 *
 * It reads a pre-recorded transcript (with timings) from a JSON file instead of
 * calling a speech API. It exists so the upload -> select -> render -> zip path
 * can be verified end to end without spending API credits, and it refuses to
 * run in production. Projects processed this way record provider
 * `fixture:<file>` so results are never presented as a real transcription.
 */
export interface FixtureTranscriptFile {
  language?: string | null;
  words?: { text: string; startMs: number; endMs: number }[];
  segments?: { text: string; startMs: number; endMs: number }[];
}

export function createFixtureTranscriber(transcriptPath: string): TranscriptionProvider {
  const cfg = config();
  if (!cfg.allowFixtureTranscriber) {
    throw new ConfigError(
      'fixture_disabled',
      'The fixture transcriber is disabled. Set AC_ALLOW_FIXTURE_TRANSCRIBER=1 with NODE_ENV!=production to use it.',
    );
  }

  return {
    id: 'fixture',
    label: `fixture (${transcriptPath})`,
    async transcribeChunk(input: TranscriptionChunkInput): Promise<TranscriptionChunkResult> {
      let raw: FixtureTranscriptFile;
      try {
        raw = JSON.parse(await fs.readFile(transcriptPath, 'utf8')) as FixtureTranscriptFile;
      } catch (error) {
        throw new ProviderError(
          'fixture_read_failed',
          `Could not read fixture transcript: ${(error as Error).message}`,
        );
      }

      const words: TimedWord[] = (raw.words ?? []).map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
      }));
      const segments = raw.segments ?? [];
      const inChunk = words.length > 0
        ? words
        : estimateWordTimings(segments);

      const clamped = inChunk.filter(
        (word) => word.startMs >= input.offsetMs && word.startMs < input.offsetMs + input.durationMs,
      );

      return {
        words: clamped,
        segments: segments.filter(
          (segment) =>
            segment.startMs >= input.offsetMs && segment.startMs < input.offsetMs + input.durationMs,
        ),
        text: clamped.map((word) => word.text).join(' '),
        language: raw.language ?? null,
        timing: words.length > 0 ? 'provider' : 'estimated',
      };
    },
  };
}
