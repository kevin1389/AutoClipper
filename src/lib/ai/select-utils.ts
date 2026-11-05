import type { SelectedClip, TimedWord, TranscriptSegment } from '../types';

export interface Sentence {
  text: string;
  startMs: number;
  endMs: number;
  wordCount: number;
  /** True when the sentence ends on punctuation, not just a pause. */
  terminal: boolean;
}

export const MIN_CLIP_MS = 7_000;
export const MAX_CLIP_MS = 60_000;
export const MIN_CLIP_GAP_MS = 1_200;

const TERMINAL_RE = /[.!?]["')\]]?$/;

export function sentenceEndsComplete(text: string): boolean {
  return TERMINAL_RE.test(text.trim());
}

/**
 * Builds sentence-like units from word timings.
 *
 * Whisper often inserts a pause in the middle of a sentence. Splitting on every
 * 550 ms gap turns those pauses into fake sentence starts and makes clips begin
 * on a dangling "and…" or "because…". We only break on real terminal
 * punctuation, a clear new-capitalized thought after a long pause, or a very
 * long run without punctuation. That keeps a complete thought together for the
 * selector and for the edit plan.
 */
export function buildSentences(words: TimedWord[], segments: TranscriptSegment[]): Sentence[] {
  if (words.length === 0) {
    return segments
      .map((segment) => {
        const text = segment.text.trim();
        return {
          text,
          startMs: segment.startMs,
          endMs: segment.endMs,
          wordCount: text.split(/\s+/).filter(Boolean).length,
          terminal: sentenceEndsComplete(text),
        };
      })
      .filter((sentence) => sentence.text.length > 0);
  }

  const sentences: Sentence[] = [];
  let current: TimedWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((word) => word.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    if (!text) {
      current = [];
      return;
    }
    sentences.push({
      text,
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      wordCount: current.length,
      terminal: sentenceEndsComplete(current[current.length - 1].text),
    });
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = word.startMs - previous.endMs;
      const nextStartsCapital = /^["'([{]?[A-Z0-9]/.test(word.text.trim());
      if (
        gap > 1_600 ||
        (gap > 850 && nextStartsCapital) ||
        current.length >= 30
      ) {
        flush();
      }
    }
    current.push(word);
    if (TERMINAL_RE.test(word.text) && current.length > 0) flush();
  }
  flush();
  return sentences.filter((sentence) => sentence.text.length > 0);
}

function overlapRatio(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): number {
  const intersection = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (intersection <= 0) return 0;
  const smaller = Math.min(a.endMs - a.startMs, b.endMs - b.startMs) || 1;
  return intersection / smaller;
}

/**
 * Validates provider output: clamps to the media duration, drops unusable
 * ranges, removes heavy overlaps and never returns more than 10 clips.
 */
export function finalizeSelection(
  candidates: SelectedClip[],
  options: { durationMs: number; targetCount: number; minDurationMs?: number; maxDurationMs?: number },
): SelectedClip[] {
  const minDuration = options.minDurationMs ?? MIN_CLIP_MS;
  const maxDuration = options.maxDurationMs ?? MAX_CLIP_MS;
  const limit = Math.max(1, Math.min(10, options.targetCount));

  const cleaned = candidates
    .map((clip) => {
      const startMs = Math.max(0, Math.min(options.durationMs - minDuration, Math.round(clip.startMs)));
      const endMs = Math.max(
        startMs + minDuration,
        Math.min(options.durationMs, Math.round(clip.endMs)),
      );
      return {
        ...clip,
        startMs,
        endMs: Math.min(endMs, options.durationMs),
        title: clip.title.trim().slice(0, 120) || 'Untitled highlight',
        reason: clip.reason?.trim() ?? '',
        hook: clip.hook?.trim() ?? '',
        score: Number.isFinite(clip.score) ? clip.score : 0,
      };
    })
    .filter((clip) => clip.endMs - clip.startMs >= minDuration * 0.95)
    .sort((a, b) => b.score - a.score);

  const accepted: SelectedClip[] = [];
  for (const clip of cleaned) {
    if (clip.endMs - clip.startMs > maxDuration) {
      clip.endMs = clip.startMs + maxDuration;
    }
    const conflicts = accepted.some(
      (existing) =>
        overlapRatio(existing, clip) > 0.15 ||
        Math.abs(existing.startMs - clip.startMs) < MIN_CLIP_GAP_MS,
    );
    if (conflicts) continue;
    accepted.push(clip);
    if (accepted.length >= limit) break;
  }

  return accepted.sort((a, b) => a.startMs - b.startMs);
}
