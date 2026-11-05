import type { TimedWord, TranscriptSegment } from '../types';

/**
 * Word-timing estimation.
 *
 * Providers that only return segment-level timestamps cannot drive word-karaoke
 * captions directly. This distributes each segment's duration across its words
 * proportionally to word length and reports `timing: 'estimated'` so the UI can
 * be honest about caption precision.
 */

const MIN_WORD_MS = 70;

export function splitWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

export function estimateWordTimings(segments: TranscriptSegment[]): TimedWord[] {
  const words: TimedWord[] = [];

  for (const segment of segments) {
    const text = (segment.text ?? '').trim();
    if (!text) continue;
    const tokens = splitWords(text);
    if (tokens.length === 0) continue;

    const segmentStart = Math.max(0, Math.round(segment.startMs));
    const segmentEnd = Math.max(segmentStart + tokens.length * MIN_WORD_MS, Math.round(segment.endMs));
    const totalChars = tokens.reduce((sum, token) => sum + token.length, 0) || tokens.length;
    const span = segmentEnd - segmentStart;

    let cursor = segmentStart;
    tokens.forEach((token, index) => {
      const share = index === tokens.length - 1 ? segmentEnd - cursor : Math.round((span * token.length) / totalChars);
      const end = index === tokens.length - 1 ? segmentEnd : cursor + Math.max(MIN_WORD_MS, share);
      words.push({
        text: token,
        startMs: cursor,
        endMs: Math.min(segmentEnd, Math.max(cursor + MIN_WORD_MS, end)),
      });
      cursor = words[words.length - 1].endMs;
    });
  }

  return words;
}

/** Shifts timings produced for an audio chunk back onto the full-timeline. */
export function offsetWords(words: TimedWord[], offsetMs: number): TimedWord[] {
  if (offsetMs === 0) return words;
  return words.map((word) => ({
    text: word.text,
    startMs: word.startMs + offsetMs,
    endMs: word.endMs + offsetMs,
  }));
}

export function offsetSegments(segments: TranscriptSegment[], offsetMs: number): TranscriptSegment[] {
  if (offsetMs === 0) return segments;
  return segments.map((segment) => ({
    text: segment.text,
    startMs: segment.startMs + offsetMs,
    endMs: segment.endMs + offsetMs,
    words: segment.words ? offsetWords(segment.words, offsetMs) : undefined,
  }));
}

export function cleanWordText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}
