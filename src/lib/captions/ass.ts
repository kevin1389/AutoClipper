import type { TimedWord } from '../types';
import { emphasisScore } from '../edit/plan';

/**
 * Caption rendering.
 *
 * Produces an ASS subtitle file with word-level karaoke timing so the burned-in
 * captions animate in sync with speech (each word fills in as it is spoken).
 * Pure function: same input always yields the same file, which keeps it easy to
 * test and to reuse for different render targets.
 */

export interface CaptionStyle {
  fontName: string;
  fontSize: number;
  primaryColour: string;
  secondaryColour: string;
  outlineColour: string;
  backColour: string;
  outline: number;
  shadow: number;
  alignment: number;
  marginLR: number;
  marginV: number;
  maxWordsPerCue: number;
  maxCharsPerCue: number;
  maxCueMs: number;
  gapBreakMs: number;
  playResX: number;
  playResY: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontName: 'DejaVu Sans',
  fontSize: 84,
  primaryColour: '&H00FFFFFF', // spoken words: white
  secondaryColour: '&H00909AA8', // upcoming words: dim grey
  outlineColour: '&H00101014',
  backColour: '&H64000000',
  outline: 7,
  shadow: 0,
  alignment: 2, // bottom center
  marginLR: 70,
  // 300 px of a 1920 px frame: keeps captions clear of TikTok/Reels/Shorts
  // interface chrome at the bottom of the screen.
  marginV: 300,
  maxWordsPerCue: 4,
  maxCharsPerCue: 20,
  maxCueMs: 2400,
  gapBreakMs: 700,
  playResX: 1080,
  playResY: 1920,
};

export interface BuildCaptionsOptions {
  startMs: number;
  endMs: number;
  style?: Partial<CaptionStyle>;
  /** Optional text shown once, top of frame (e.g. clip title). Disabled by default. */
  title?: string | null;
  /** Scale up numbers, emphasis and reaction words. On by default. */
  highlightKeywords?: boolean;
}

export interface BuildCaptionsResult {
  ass: string;
  cueCount: number;
  wordCount: number;
}

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

export function sanitizeCaptionText(input: string): string {
  return input
    .replace(EMOJI_RE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAssTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const centiseconds = Math.floor((total % 1000) / 10);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    centiseconds,
  ).padStart(2, '0')}`;
}

interface CueWord {
  text: string;
  startMs: number;
  endMs: number;
}

function groupIntoCues(words: CueWord[], style: CaptionStyle): CueWord[][] {
  const cues: CueWord[][] = [];
  let current: CueWord[] = [];

  const flush = () => {
    if (current.length > 0) cues.push(current);
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = word.startMs - previous.endMs;
      const cueDuration = word.endMs - current[0].startMs;
      const chars = current.reduce((sum, entry) => sum + entry.text.length + 1, word.text.length);
      if (
        current.length >= style.maxWordsPerCue ||
        gap > style.gapBreakMs ||
        chars > style.maxCharsPerCue ||
        cueDuration > style.maxCueMs
      ) {
        flush();
      }
    }
    current.push(word);
  }
  flush();
  return cues;
}

function renderCue(
  cue: CueWord[],
  style: CaptionStyle,
  maxEndMs: number,
  highlightKeywords: boolean,
): string | null {
  const start = cue[0].startMs;
  // The 320 ms floor keeps very short cues readable, but it must never push a
  // cue past the end of the clip, which would leave it cut off in the render.
  const end = Math.min(maxEndMs, Math.max(cue[cue.length - 1].endMs, start + 320));
  const breakAfter = cue.length >= 4 && cue.reduce((sum, word) => sum + word.text.length + 1, 0) > 22
    ? Math.ceil(cue.length / 2)
    : -1;

  const parts: string[] = ['{\\fad(70,50)\\fscx93\\fscy93\\t(0,120,\\fscx100\\fscy100)}'];
  cue.forEach((word, index) => {
    const durationCs = Math.max(
      5,
      Math.round((Math.max(60, word.endMs - word.startMs)) / 10),
    );
    const text = sanitizeCaptionText(word.text);
    // Word-level karaoke fill for sync, plus a monochrome scale bump on words
    // that carry the emphasis (numbers, reactions, superlatives).
    const emphasis = highlightKeywords && emphasisScore(text) >= 0.6;
    parts.push(
      `{\\kf${durationCs}${emphasis ? '\\fscx110\\fscy110' : ''}}${text}${
        emphasis ? '{\\fscx100\\fscy100}' : ''
      }`,
    );
    if (index === breakAfter - 1 && index < cue.length - 1) parts.push('\\N');
    else if (index < cue.length - 1) parts.push(' ');
  });

  const text = parts.join('').trim();
  if (!text.replace(/\{[^}]*\}/g, '').trim()) return null;
  return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Clip,,0,0,0,,${text}`;
}

function styleLine(style: CaptionStyle): string {
  return [
    'Style: Clip',
    style.fontName,
    String(style.fontSize),
    style.primaryColour,
    style.secondaryColour,
    style.outlineColour,
    style.backColour,
    '-1', // bold
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    '1', // border style: outline + shadow
    String(style.outline),
    String(style.shadow),
    String(style.alignment),
    String(style.marginLR),
    String(style.marginLR),
    String(style.marginV),
    '1',
  ].join(',');
}

export function buildAssCaptions(
  words: TimedWord[],
  options: BuildCaptionsOptions,
): BuildCaptionsResult {
  const style: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...options.style };
  const startMs = options.startMs;
  const endMs = Math.max(options.endMs, startMs + 300);

  const inRange: CueWord[] = [];
  for (const word of words) {
    const text = sanitizeCaptionText(word.text ?? '');
    if (!text) continue;
    const midpoint = (word.startMs + word.endMs) / 2;
    if (midpoint < startMs || midpoint > endMs) continue;
    const relativeStart = Math.max(0, word.startMs - startMs);
    const relativeEnd = Math.min(endMs - startMs, Math.max(relativeStart + 60, word.endMs - startMs));
    inRange.push({ text, startMs: relativeStart, endMs: relativeEnd });
  }

  inRange.sort((a, b) => a.startMs - b.startMs);
  const cues = groupIntoCues(inRange, style);
  const events = cues
    .map((cue) =>
      renderCue(cue, style, endMs - startMs, options.highlightKeywords !== false),
    )
    .filter((line): line is string => Boolean(line));

  const header = [
    '[Script Info]',
    '; Generated by AutoClipper',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine(style),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  return {
    ass: `${header.join('\n')}\n${events.join('\n')}${events.length > 0 ? '\n' : ''}`,
    cueCount: events.length,
    wordCount: inRange.length,
  };
}
