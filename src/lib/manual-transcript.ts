import type { TimedWord, Transcript, TranscriptSegment } from './types';

export const MANUAL_TRANSCRIPT_ACCEPT = '.srt,.vtt,.txt,text/plain,application/x-subrip,text/vtt';
export const MAX_MANUAL_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MANUAL_TRANSCRIPT_FORMATS = ['srt', 'vtt', 'txt'] as const;

export type ManualTranscriptFormat = (typeof MANUAL_TRANSCRIPT_FORMATS)[number];

export interface ManualTranscriptInput {
  text: string;
  filename?: string;
  format?: ManualTranscriptFormat;
  durationMs?: number | null;
}

export interface ManualTranscriptResult {
  format: ManualTranscriptFormat;
  transcript: Transcript;
  cueCount: number;
  wordCount: number;
  startMs: number;
  endMs: number;
  warnings: string[];
  preview: { startMs: number; endMs: number; text: string }[];
}

export class ManualTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualTranscriptError';
  }
}

interface ParsedCue {
  startMs: number;
  endMs: number;
  text: string;
  order: number;
}

const MAX_RAW_CHARS = 2_000_000;
const MAX_TRANSCRIPT_CHARS = 500_000;
const MAX_WORDS = 100_000;
const MAX_CUES = 20_000;
const MIN_CUE_MS = 20;
const TIMESTAMP_RE = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/;

export function formatFromFilename(filename: string): ManualTranscriptFormat | null {
  const extension = filename.toLowerCase().split('.').pop();
  return extension === 'srt' || extension === 'vtt' || extension === 'txt' ? extension : null;
}

function detectFormat(text: string): ManualTranscriptFormat | null {
  if (/^\s*WEBVTT\b/im.test(text)) return 'vtt';
  if (/-->/.test(text)) return /\d,\d{3}/.test(text) ? 'srt' : 'vtt';
  return null;
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function stripCueMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]+\}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTimestamp(token: string): number | null {
  const match = TIMESTAMP_RE.exec(token.trim());
  if (!match) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4].padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function parseTimingLine(line: string): { startMs: number; endMs: number } | null {
  const parts = line.split(/\s+-->\s+/);
  if (parts.length !== 2) return null;
  const startMs = parseTimestamp(parts[0]);
  const endToken = parts[1].trim().split(/\s+/)[0] ?? '';
  const endMs = parseTimestamp(endToken);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { startMs, endMs };
}

/**
 * Scans cue blocks without requiring a blank line between them. That makes the
 * parser tolerant of hand-edited SRT files while still ignoring SRT indices,
 * VTT cue identifiers, and VTT NOTE/STYLE/REGION blocks.
 */
function scanCues(text: string): { cues: ParsedCue[]; invalidLines: number; missingTiming: number } {
  const lines = text.split('\n');
  const cues: ParsedCue[] = [];
  let invalidLines = 0;
  let missingTiming = 0;
  let order = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.includes('-->')) {
      if (line.trim() && !/^WEBVTT$/i.test(line.trim())) {
        // Text before the first cue is normal for VTT headers and SRT indices.
        // Text after a cue is collected below.
        if (cues.length === 0 && !/^\d+$/.test(line.trim())) {
          missingTiming += 1;
        }
      }
      index += 1;
      continue;
    }

    const timing = parseTimingLine(line);
    if (!timing) {
      invalidLines += 1;
      index += 1;
      continue;
    }

    const textLines: string[] = [];
    index += 1;
    while (index < lines.length && !lines[index].includes('-->')) {
      textLines.push(lines[index]);
      index += 1;
    }

    // If the next block starts with an SRT-style numeric index immediately
    // before its timing line, the scanner has already stopped at the timing
    // line, so remove a trailing index from this cue's text.
    while (textLines.length > 0 && textLines[textLines.length - 1].trim() === '') textLines.pop();
    if (textLines.length > 0 && /^\d+$/.test(textLines[textLines.length - 1].trim())) {
      textLines.pop();
    }
    while (textLines.length > 0 && textLines[textLines.length - 1].trim() === '') textLines.pop();

    const cueText = stripCueMarkup(textLines.join(' '));
    if (!cueText || !/[\p{L}\p{N}]/u.test(cueText)) {
      // A timestamp with no readable text is not a usable cue.
      continue;
    }
    cues.push({ ...timing, text: cueText, order: order++ });
  }

  return { cues, invalidLines, missingTiming };
}

function normalizeCues(
  cues: ParsedCue[],
  durationMs: number | null,
): {
  cues: ParsedCue[];
  skipped: number;
  clamped: number;
  overlaps: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.order - b.order);
  const normalized: ParsedCue[] = [];
  let skipped = 0;
  let clamped = 0;
  let overlaps = 0;
  let previousEnd = 0;

  for (const cue of sorted) {
    let startMs = Math.max(0, cue.startMs);
    let endMs = cue.endMs;

    if (durationMs !== null && startMs >= durationMs) {
      skipped += 1;
      continue;
    }
    if (durationMs !== null && endMs > durationMs) {
      endMs = durationMs;
      clamped += 1;
    }
    if (endMs <= startMs || endMs - startMs < MIN_CUE_MS) {
      skipped += 1;
      continue;
    }
    if (startMs < previousEnd) {
      startMs = previousEnd;
      overlaps += 1;
      if (endMs <= startMs || endMs - startMs < MIN_CUE_MS) {
        skipped += 1;
        continue;
      }
    }

    normalized.push({ ...cue, startMs, endMs });
    previousEnd = endMs;
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} cue${skipped === 1 ? '' : 's'} had missing, invalid, zero-length, or out-of-range timestamps and ${skipped === 1 ? 'was' : 'were'} skipped.`,
    );
  }
  if (clamped > 0) {
    warnings.push(
      `${clamped} cue${clamped === 1 ? '' : 's'} extended past the video and ${clamped === 1 ? 'was' : 'were'} clamped to the video duration.`,
    );
  }
  if (overlaps > 0) {
    warnings.push(
      `${overlaps} overlapping cue${overlaps === 1 ? '' : 's'} ${overlaps === 1 ? 'was' : 'were'} shifted so captions stay monotonic.`,
    );
  }
  if (durationMs !== null && normalized.length > 0) {
    const coverage = normalized[normalized.length - 1].endMs / durationMs;
    if (coverage < 0.5 && durationMs > 60_000) {
      warnings.push(
        `The transcript covers only ${Math.round(coverage * 100)}% of the video. Clips can only be selected from the covered speech.`,
      );
    }
  }

  return { cues: normalized, skipped, clamped, overlaps, warnings };
}

function splitWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0 && /[\p{L}\p{N}]/u.test(word));
}

function distributeWords(text: string, startMs: number, endMs: number): TimedWord[] {
  const tokens = splitWords(text);
  if (tokens.length === 0 || endMs <= startMs) return [];
  const weights = tokens.map((word) => Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, '').length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const available = endMs - startMs;
  const words: TimedWord[] = [];
  let used = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const wordStart = startMs + Math.floor((used / total) * available);
    used += weights[index];
    const next = index === tokens.length - 1
      ? endMs
      : startMs + Math.floor((used / total) * available);
    const wordEnd = Math.max(wordStart + 1, Math.min(endMs, next));
    words.push({
      text: tokens[index],
      startMs: Math.min(wordStart, endMs - 1),
      endMs: Math.min(wordEnd, endMs),
    });
  }
  return words;
}

function plainTextCues(text: string, durationMs: number | null): ParsedCue[] {
  if (durationMs === null || durationMs <= 0) {
    throw new ManualTranscriptError('The video duration is required to place a plain-text transcript.');
  }
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => stripCueMarkup(sentence))
    .filter((sentence) => sentence.length > 0);
  const chunks = sentences.length > 0 ? sentences : [stripCueMarkup(text)];
  const wordCounts = chunks.map((chunk) => splitWords(chunk).length);
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
  if (totalWords === 0) return [];

  let cursor = 0;
  let remainingWords = totalWords;
  return chunks.map((chunk, index) => {
    const words = wordCounts[index];
    const nextCursor = index === chunks.length - 1
      ? durationMs
      : Math.round(cursor + (durationMs * words) / Math.max(1, remainingWords));
    const cue = {
      startMs: cursor,
      endMs: Math.max(cursor + 1, nextCursor),
      text: chunk,
      order: index,
    };
    cursor = cue.endMs;
    remainingWords -= words;
    return cue;
  }).filter((cue) => cue.endMs > cue.startMs);
}

function makeTranscript(
  cues: ParsedCue[],
  format: ManualTranscriptFormat,
): { transcript: Transcript; wordCount: number; startMs: number; endMs: number } {
  if (cues.length > MAX_CUES) {
    throw new ManualTranscriptError(`The transcript has too many cues (limit ${MAX_CUES.toLocaleString()}).`);
  }

  const segments: TranscriptSegment[] = [];
  const words: TimedWord[] = [];
  for (const cue of cues) {
    const cueWords = distributeWords(cue.text, cue.startMs, cue.endMs);
    if (cueWords.length === 0) continue;
    segments.push({
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      words: cueWords,
    });
    words.push(...cueWords);
    if (words.length > MAX_WORDS) {
      throw new ManualTranscriptError(`The transcript has too many words (limit ${MAX_WORDS.toLocaleString()}).`);
    }
  }

  if (segments.length === 0 || words.length === 0) {
    throw new ManualTranscriptError('No readable caption text was found in the transcript.');
  }
  const text = segments.map((segment) => segment.text).join(' ').trim();
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new ManualTranscriptError(
      `The transcript is too long (limit ${MAX_TRANSCRIPT_CHARS.toLocaleString()} characters after parsing).`,
    );
  }
  const startMs = words[0].startMs;
  const endMs = words[words.length - 1].endMs;
  return {
    transcript: {
      provider: `manual-${format}`,
      language: null,
      timing: 'estimated',
      text,
      words,
      segments,
    },
    wordCount: words.length,
    startMs,
    endMs,
  };
}

/**
 * Parses a user-supplied transcript into the same transcript shape used by the
 * Whisper pipeline. SRT/VTT cue boundaries are preserved; words are distributed
 * inside each cue because those formats do not carry word-level timestamps.
 * Plain text is accepted, but timestamps are estimated across the full video.
 */
export function parseManualTranscript(input: ManualTranscriptInput): ManualTranscriptResult {
  if (!input || typeof input.text !== 'string') {
    throw new ManualTranscriptError('Choose a transcript file to continue.');
  }
  if (input.text.length > MAX_RAW_CHARS) {
    throw new ManualTranscriptError('The transcript file is too large. Use a file under 2 MB.');
  }
  const raw = normalizeText(input.text);
  if (!raw) throw new ManualTranscriptError('The transcript file is empty.');

  const durationMs = Number.isFinite(Number(input.durationMs)) && Number(input.durationMs) > 0
    ? Math.round(Number(input.durationMs))
    : null;
  const format = input.format
    ?? (input.filename ? formatFromFilename(input.filename) : null)
    ?? detectFormat(raw);
  if (!format) {
    throw new ManualTranscriptError('Unsupported transcript format. Use .srt, .vtt, or .txt.');
  }

  const warnings: string[] = [];
  let cues: ParsedCue[];
  if (format === 'txt') {
    if (durationMs === null) {
      throw new ManualTranscriptError('The video duration is required to place a plain-text transcript.');
    }
    cues = plainTextCues(raw, durationMs);
    warnings.push(
      'Plain text has no timestamps. Word timings are estimated across the full video, so automatic clipping and captions may be less accurate. Upload SRT or VTT for accurate timing.',
    );
  } else {
    const scanned = scanCues(raw);
    if (scanned.cues.length === 0) {
      const reason = scanned.invalidLines > 0
        ? 'No valid cues were found. Every timestamp was missing or invalid.'
        : 'No timestamped cues were found. Use a valid SRT or VTT file, or upload .txt for plain text.';
      throw new ManualTranscriptError(reason);
    }
    if (scanned.invalidLines > 0) {
      warnings.push(
        `${scanned.invalidLines} timing line${scanned.invalidLines === 1 ? '' : 's'} could not be parsed and ${scanned.invalidLines === 1 ? 'was' : 'were'} skipped.`,
      );
    }
    const normalized = normalizeCues(scanned.cues, durationMs);
    if (normalized.cues.length === 0) {
      throw new ManualTranscriptError(
        'No cue timestamps fall inside the video duration. Check the transcript and video before trying again.',
      );
    }
    warnings.push(...normalized.warnings);
    cues = normalized.cues;
  }

  const built = makeTranscript(cues, format);
  return {
    format,
    transcript: built.transcript,
    cueCount: built.transcript.segments.length,
    wordCount: built.wordCount,
    startMs: built.startMs,
    endMs: built.endMs,
    warnings,
    preview: built.transcript.segments.slice(0, 3).map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
  };
}
