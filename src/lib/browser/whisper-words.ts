import type { TimedWord } from '../types';

/**
 * Whisper timestamp parsing.
 *
 * Transformers.js word mode flattens decoded words into `chunks` entries, but a
 * single entry can still contain several whitespace-separated words when the
 * tokenizer merges tokens (byte/unicode boundaries, punctuation, music notes).
 * OpenAI-compatible servers instead return `segments`, and some return a
 * segment-level `chunks` array without token timestamps.
 *
 * Both shapes are accepted here. Real word timings are kept exactly; any
 * segment-level or merged entry is split into words inside its own timestamp
 * window, which keeps karaoke captions synchronized without discarding an
 * otherwise usable transcription.
 */

export type WhisperTiming = 'provider' | 'estimated';

type TimestampTuple = [number | null, number | null] | null | undefined;

export interface WhisperWordLike {
  text?: string;
  word?: string;
  start?: number | null;
  end?: number | null;
  /** Word/segment timestamps in seconds, as Transformers.js returns them. */
  timestamp?: TimestampTuple;
}

export interface WhisperChunkLike extends WhisperWordLike {
  /** Present on segment-level chunk objects produced mid-decode. */
  words?: WhisperWordLike[] | null;
}

export interface WhisperResultLike {
  text?: string;
  chunks?: WhisperChunkLike[] | null;
  /** Verbose-JSON segment timestamps, in seconds. */
  segments?: WhisperWordLike[] | null;
  /** Verbose-JSON word timestamps, in seconds. */
  words?: WhisperWordLike[] | null;
}

export interface WhisperParseOptions {
  /** Absolute start of the audio window on the source timeline. */
  offsetMs: number;
  /** Length of the audio window that produced this response. */
  durationMs: number;
  /** Response text, used only when nothing else can be timed. */
  fallbackText?: string;
}

export interface WhisperParseStats {
  /** Chunks that carried usable timestamps. */
  chunks: number;
  /** Chunks already timed per word (or that held a single word). */
  wordChunks: number;
  /** Chunks that held several words and had to be distributed in place. */
  mergedChunks: number;
  /** Segment entries expanded because no word data was present. */
  segmentChunks: number;
  /** Entries with text but no usable timestamps. */
  untimedChunks: number;
  /** Bounded examples of merged/segment text, for local diagnostics only. */
  samples: string[];
}

export interface ParsedWhisperWords {
  words: TimedWord[];
  timing: WhisperTiming;
  stats: WhisperParseStats;
}

interface Span {
  startMs: number;
  endMs: number;
}

const MIN_WORD_MS = 70;
/** A plausible reading pace for text that carries no timing information. */
const FALLBACK_WORD_MS = 420;
const SAMPLE_LIMIT = 120;
const MAX_SAMPLES = 3;

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function splitWords(text: string): string[] {
  const trimmed = normalizeText(text);
  return trimmed ? trimmed.split(' ') : [];
}

function spanFromSeconds(start: unknown, end: unknown): Span | null {
  // `Number(null)` is 0, so missing timestamps must be rejected before coercion.
  if (start === null || start === undefined || end === null || end === undefined) return null;
  const startSeconds = Number(start);
  const endSeconds = Number(end);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
  if (startSeconds < 0) return null;
  const startMs = Math.round(startSeconds * 1000);
  const endMs = Math.round(endSeconds * 1000);
  if (endMs <= startMs) {
    // Transformers.js rounds token timestamps to 10 ms, so a very short word
    // can collapse to a point. Keep its position rather than dropping it and
    // deferring the text to the end of the window.
    return { startMs, endMs: startMs + 20 };
  }
  return { startMs, endMs };
}

function spanOf(entry: WhisperWordLike): Span | null {
  if (Array.isArray(entry.timestamp)) {
    const span = spanFromSeconds(entry.timestamp[0], entry.timestamp[1]);
    if (span) return span;
  }
  return spanFromSeconds(entry.start, entry.end);
}

function providerWord(entry: WhisperWordLike): TimedWord | null {
  if (!entry || typeof entry !== 'object') return null;
  const text = normalizeText(entry.text ?? entry.word);
  if (!text) return null;
  const span = spanOf(entry);
  if (!span) return null;
  return { text, startMs: span.startMs, endMs: span.endMs };
}

/** Splits a segment-level entry into words inside its own timestamp window. */
function distributeWords(tokens: string[], span: Span): TimedWord[] {
  if (tokens.length === 0) return [];
  if (tokens.length === 1) {
    return [{ text: tokens[0], startMs: span.startMs, endMs: span.endMs }];
  }

  const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || tokens.length;
  // Never compress words below a readable minimum; extend the window instead so
  // every word gets a distinct start and end.
  const spanMs = Math.max(span.endMs - span.startMs, tokens.length * MIN_WORD_MS);
  const endLimit = span.startMs + spanMs;
  const words: TimedWord[] = [];
  let consumed = 0;

  for (const token of tokens) {
    const fromChars = consumed;
    consumed += token.length;
    const previousEnd = words.at(-1)?.endMs ?? span.startMs;
    const startMs = Math.max(span.startMs + Math.round((spanMs * fromChars) / totalChars), previousEnd);
    const proportionalEnd = span.startMs + Math.round((spanMs * consumed) / totalChars);
    const endMs = Math.min(endLimit, Math.max(proportionalEnd, startMs + MIN_WORD_MS));
    words.push({ text: token, startMs, endMs: Math.max(startMs + 1, endMs) });
  }

  const last = words.at(-1);
  if (last && last.endMs < endLimit) last.endMs = endLimit;
  return words;
}

function fallbackSpan(startMs: number, tokenCount: number, durationMs: number): Span {
  const start = Math.max(0, startMs);
  const minEnd = start + Math.max(1, tokenCount) * MIN_WORD_MS;
  const naturalEnd = start + Math.max(1, tokenCount) * FALLBACK_WORD_MS;
  const capped = durationMs > 0 ? Math.min(Math.max(durationMs, start), naturalEnd) : naturalEnd;
  return { startMs: start, endMs: Math.max(minEnd, capped) };
}

/**
 * Parses one Whisper response into absolute word timings.
 *
 * Never throws on an unusual shape: when only segment-level or untimed text is
 * available it is expanded into words and the result is marked `estimated`, so
 * one odd audio window cannot fail the whole project.
 */
export function parseWhisperWords(
  result: WhisperResultLike | null | undefined,
  options: WhisperParseOptions,
): ParsedWhisperWords {
  const offsetMs = Math.max(0, Math.round(Number(options.offsetMs) || 0));
  const durationMs = Math.max(0, Math.round(Number(options.durationMs) || 0));
  const stats: WhisperParseStats = {
    chunks: 0,
    wordChunks: 0,
    mergedChunks: 0,
    segmentChunks: 0,
    untimedChunks: 0,
    samples: [],
  };
  const words: TimedWord[] = [];
  let estimated = false;

  const sample = (text: string) => {
    if (stats.samples.length < MAX_SAMPLES) stats.samples.push(text.slice(0, SAMPLE_LIMIT));
  };
  const add = (word: TimedWord, fromFallback: boolean) => {
    words.push({
      text: word.text,
      startMs: Math.max(0, Math.round(word.startMs)),
      endMs: Math.max(1, Math.round(word.endMs)),
    });
    if (fromFallback) estimated = true;
  };

  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    const nested = Array.isArray(chunk.words) ? chunk.words : [];

    // A segment-style chunk may still carry exact word timings.
    const nestedWords = nested
      .map((entry) => providerWord(entry))
      .filter((word): word is TimedWord => word !== null);
    if (nestedWords.length > 0) {
      stats.chunks += 1;
      stats.wordChunks += 1;
      for (const word of nestedWords) add(word, false);
      continue;
    }

    const text = normalizeText(chunk.text);
    if (!text) continue;
    const span = spanOf(chunk);
    if (!span) {
      stats.untimedChunks += 1;
      sample(text);
      const tokens = splitWords(text);
      const start = words.at(-1)?.endMs ?? 0;
      for (const word of distributeWords(tokens, fallbackSpan(start, tokens.length, durationMs))) {
        add(word, true);
      }
      continue;
    }

    stats.chunks += 1;
    const tokens = splitWords(text);
    if (tokens.length <= 1) {
      stats.wordChunks += 1;
      add({ text: tokens[0] ?? text, startMs: span.startMs, endMs: span.endMs }, false);
      continue;
    }

    // Merged token group or a genuine segment timestamp. Split it in place.
    stats.mergedChunks += 1;
    sample(text);
    for (const word of distributeWords(tokens, span)) add(word, true);
  }

  if (words.length === 0) {
    const verboseWords = Array.isArray(result?.words) ? result.words : [];
    for (const entry of verboseWords) {
      const word = providerWord(entry);
      if (word) add(word, false);
    }
  }

  if (words.length === 0) {
    const segments = Array.isArray(result?.segments) ? result.segments : [];
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const text = normalizeText(segment.text);
      if (!text) continue;
      const span = spanOf(segment);
      if (!span) {
        stats.untimedChunks += 1;
        sample(text);
        const tokens = splitWords(text);
        const start = words.at(-1)?.endMs ?? 0;
        for (const word of distributeWords(tokens, fallbackSpan(start, tokens.length, durationMs))) {
          add(word, true);
        }
        continue;
      }
      stats.segmentChunks += 1;
      sample(text);
      for (const word of distributeWords(splitWords(text), span)) add(word, true);
    }
  }

  if (words.length === 0) {
    const tokens = splitWords(normalizeText(options.fallbackText ?? result?.text));
    if (tokens.length > 0) {
      sample(tokens.join(' '));
      for (const word of distributeWords(tokens, fallbackSpan(0, tokens.length, durationMs))) {
        add(word, true);
      }
    }
  }

  const absolute = words
    .map((word) => ({
      text: word.text,
      startMs: offsetMs + word.startMs,
      endMs: offsetMs + word.endMs,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return {
    words: absolute,
    timing: estimated ? 'estimated' : 'provider',
    stats,
  };
}
