import type { SelectedClip, TimedWord, TranscriptSegment } from '../types';
import type { MediaSignals } from '../media/signals';

export interface TranscriptionChunkInput {
  audioPath: string;
  mimeType: string;
  /** Absolute start of this chunk in the source timeline. */
  offsetMs: number;
  durationMs: number;
}

export interface TranscriptionChunkResult {
  words: TimedWord[];
  segments: TranscriptSegment[];
  text: string;
  language: string | null;
  timing: 'provider' | 'estimated';
}

/**
 * Pluggable speech-to-text. One implementation talks to any OpenAI-compatible
 * /audio/transcriptions endpoint; another (fixture) exists only for tests.
 * Adding a different vendor means implementing this interface.
 */
export interface TranscriptionProvider {
  readonly id: string;
  readonly label: string;
  transcribeChunk(input: TranscriptionChunkInput): Promise<TranscriptionChunkResult>;
}

export interface SelectionInput {
  words: TimedWord[];
  segments: TranscriptSegment[];
  durationMs: number;
  targetCount: number;
  /** Measured audio peaks and visual scene changes, when analysis succeeded. */
  signals?: MediaSignals | null;
}

/** Pluggable highlight selection (LLM or deterministic heuristics). */
export interface ClipSelector {
  readonly id: string;
  readonly label: string;
  select(input: SelectionInput): Promise<SelectedClip[]>;
}

/** Error with a message that is safe and useful to show to the end user. */
export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(code: string, message: string, options: { retryable?: boolean; status?: number | null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}
