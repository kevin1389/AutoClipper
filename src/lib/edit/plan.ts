import type {
  ClipEdits,
  ClipFraming,
  ClipSlowMotionWindow,
  ClipZoomWindow,
  TimedWord,
} from '../types';
import type { MediaSignals } from '../media/signals';

/**
 * Content-driven edit planning.
 *
 * Every decision here is derived from real data: word timestamps, word emphasis,
 * measured audio peaks and detected visual scene changes. Nothing is placed on a
 * fixed interval, and slow motion only exists when a visual change plus a strong
 * audio/emphasis signal coincide inside the clip's payoff region.
 *
 * The plan also owns the source→output time mapping, so captions, zoom windows
 * and slow motion all stay synchronized after pauses are removed.
 */

export interface EditPiece {
  srcStartMs: number;
  srcEndMs: number;
  /** 1 = normal speed, <1 = slow motion. */
  speed: number;
  outStartMs: number;
}

export interface EditPlan {
  sourceStartMs: number;
  sourceEndMs: number;
  outputDurationMs: number;
  pieces: EditPiece[];
  removedPauses: { startMs: number; endMs: number }[];
  /** Output-relative. */
  zooms: ClipZoomWindow[];
  /** Output-relative. */
  slowMotion: ClipSlowMotionWindow[];
  /** Output-relative caption words. */
  captionWords: TimedWord[];
  /** Subject-aware camera framing, or null for a safe centre crop. */
  framing: ClipFraming | null;
  effectsSummary: string[];
}

export const DEFAULT_EDITS: ClipEdits = {
  startMs: 0,
  endMs: 0,
  captionText: null,
  zoomEnabled: true,
  zoomIntensity: 1,
  // Slow motion is an opt-in accent, never a default edit. Most talking-head
  // moments read as more natural at their original speed.
  slowMotionEnabled: false,
};

const MIN_PAUSE_MS = 900;
const KEPT_PAUSE_MS = 300;
const EDGE_PAD_START_MS = 220;
const EDGE_PAD_END_MS = 380;
const SLOW_SPEED = 0.55;
const SLOW_MAX_MS = 1_800;
export const MIN_ZOOM_SCALE = 1.03;
export const MAX_ZOOM_SCALE = 1.1;

const EMPHASIS_WORDS = new Set([
  'crazy', 'insane', 'wild', 'unbelievable', 'shocking', 'shocked', 'hilarious', 'funny',
  'terrible', 'awful', 'amazing', 'incredible', 'huge', 'massive', 'never', 'always',
  'everyone', 'everything', 'nobody', 'nothing', 'biggest', 'worst', 'best', 'hardest',
  'literally', 'actually', 'honestly', 'exactly', 'wow', 'whoa', 'oh', 'no', 'wait',
  'stop', 'look', 'listen', 'remember', 'secret', 'truth', 'mistake', 'important',
  'laugh', 'laughing', 'crying', 'screaming', 'shocked', 'surprised', 'unexpected',
  'plot', 'twist', 'terrified', 'furious', 'proud', 'heartbroken', 'grateful',
  'insane', 'wild',
]);

const SUPERLATIVE_RE = /\b(biggest|worst|best|hardest|fastest|easiest|most)\b/i;

/**
 * How much a single word deserves emphasis. Deterministic and explainable: it is
 * lexical emphasis only, not a semantic judgement.
 */
export function emphasisScore(text: string): number {
  const clean = text.replace(/[^\w'%-]/g, '');
  if (!clean) return 0;
  const lower = clean.toLowerCase();
  let score = 0;
  if (/\d/.test(clean)) score += 0.8;
  if (EMPHASIS_WORDS.has(lower)) score += 0.8;
  if (SUPERLATIVE_RE.test(clean)) score += 0.6;
  if (clean.length > 2 && clean === clean.toUpperCase() && /[A-Z]/.test(clean)) score += 0.6;
  if (/[!?]$/.test(text)) score += 0.3;
  if (clean.length >= 11) score += 0.2;
  return Math.min(1, score);
}

export function isEmphasisWord(text: string): boolean {
  return emphasisScore(text) >= 0.6;
}

/** Splits replacement caption text into word-timed entries across the clip. */
export function distributeCaptionText(text: string, durationMs: number): TimedWord[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 160);
  if (words.length === 0 || durationMs <= 0) return [];
  const step = durationMs / words.length;
  return words.map((word, index) => ({
    text: word,
    startMs: Math.round(index * step),
    endMs: Math.round((index + 1) * step),
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nearestSceneChange(signals: MediaSignals | null | undefined, atMs: number, windowMs: number): number | null {
  if (!signals || signals.sceneChangesMs.length === 0) return null;
  let best: number | null = null;
  for (const t of signals.sceneChangesMs) {
    const distance = Math.abs(t - atMs);
    if (distance <= windowMs && (best === null || distance < Math.abs(best - atMs))) best = t;
  }
  return best;
}

function nearestPeak(signals: MediaSignals | null | undefined, atMs: number, windowMs: number): number | null {
  if (!signals || signals.peaksMs.length === 0) return null;
  let best: number | null = null;
  for (const t of signals.peaksMs) {
    const distance = Math.abs(t - atMs);
    if (distance <= windowMs && (best === null || distance < Math.abs(best - atMs))) best = t;
  }
  return best;
}

export function buildEditPlan(input: {
  words: TimedWord[];
  startMs: number;
  endMs: number;
  options?: Partial<ClipEdits>;
  signals?: MediaSignals | null;
  framing?: ClipFraming | null;
}): EditPlan {
  const options: ClipEdits = { ...DEFAULT_EDITS, ...input.options };
  const startMs = Math.max(0, Math.round(options.startMs || input.startMs));
  const endMs = Math.max(startMs + 3_000, Math.round(options.endMs || input.endMs));
  const intensity = clamp(Number.isFinite(options.zoomIntensity) ? options.zoomIntensity : 1, 0.4, 2);

  const words = input.words
    .filter((word) => {
      const mid = (word.startMs + word.endMs) / 2;
      return mid >= startMs && mid <= endMs && word.text.trim().length > 0;
    })
    .sort((a, b) => a.startMs - b.startMs);

  // 1. Trim dead air at the edges, keeping a little natural lead-in/out.
  const first = words[0];
  const last = words[words.length - 1];
  const trimStart = first ? clamp(first.startMs - EDGE_PAD_START_MS, startMs, endMs - 1_000) : startMs;
  const trimEnd = last ? clamp(last.endMs + EDGE_PAD_END_MS, trimStart + 1_000, endMs) : endMs;
  const durationMs = trimEnd - trimStart;

  // 2. Remove long internal pauses so the clip keeps its pace.
  const removedPauses: { startMs: number; endMs: number }[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const gap = words[index].startMs - words[index - 1].endMs;
    if (gap < MIN_PAUSE_MS) continue;
    const removeStart = Math.round(words[index - 1].endMs + KEPT_PAUSE_MS / 2);
    const removeEnd = Math.round(words[index].startMs - KEPT_PAUSE_MS / 2);
    if (removeEnd > removeStart) removedPauses.push({ startMs: removeStart, endMs: removeEnd });
  }

  const keptRanges: { startMs: number; endMs: number }[] = [];
  let cursor = trimStart;
  for (const pause of removedPauses) {
    if (pause.startMs > cursor) keptRanges.push({ startMs: cursor, endMs: Math.min(pause.startMs, trimEnd) });
    cursor = Math.max(cursor, pause.endMs);
  }
  if (cursor < trimEnd) keptRanges.push({ startMs: cursor, endMs: trimEnd });
  const ranges = keptRanges.filter((range) => range.endMs - range.startMs >= 120);
  if (ranges.length === 0) ranges.push({ startMs: trimStart, endMs: trimEnd });

  // 3. Slow motion: only in the payoff region, only with real visual + audio evidence.
  // Payoff region: the back half of the clip the user asked for, not of the
  // already-trimmed range, so short but strong clips still qualify.
  const payoffStart = startMs + Math.max(2_000, (endMs - startMs) * 0.5);
  const slowCandidates: { atMs: number; score: number; reason: string }[] = [];
  if (options.slowMotionEnabled) {
    for (const word of words) {
      if (word.startMs < payoffStart || word.endMs > trimEnd - 300) continue;
      const emphasis = emphasisScore(word.text);
      if (emphasis < 0.6) continue;
      const scene = nearestSceneChange(input.signals, word.startMs, 1_500);
      const peak = nearestPeak(input.signals, word.startMs, 1_200);
      if (scene === null) continue;
      const loud = averageLoudnessSafe(input.signals, word.startMs - 600, word.startMs + 900);
      const score = emphasis * 2 + (peak !== null ? 1.2 : 0) + (loud !== null && loud > -30 ? 0.6 : 0);
      slowCandidates.push({
        atMs: word.startMs,
        score,
        reason: `“${word.text}” lands with a visual change${peak !== null ? ' and an audio peak' : ''}`,
      });
    }
  }
  slowCandidates.sort((a, b) => b.score - a.score);
  const chosenSlow = slowCandidates[0];
  const slowMotion: { srcStartMs: number; srcEndMs: number; speed: number; reason: string }[] = [];
  if (chosenSlow) {
    const half = SLOW_MAX_MS / 2;
    const srcStart = Math.max(trimStart + 400, chosenSlow.atMs - half * 0.55);
    const srcEnd = Math.min(trimEnd - 200, srcStart + SLOW_MAX_MS);
    if (srcEnd - srcStart >= 900) {
      slowMotion.push({ srcStartMs: Math.round(srcStart), srcEndMs: Math.round(srcEnd), speed: SLOW_SPEED, reason: chosenSlow.reason });
    }
  }

  // 4. Build pieces (pause removal + slow motion), then the output clock.
  const pieces: EditPiece[] = [];
  for (const range of ranges) {
    const overlaps = slowMotion.filter(
      (slow) => slow.srcEndMs > range.startMs && slow.srcStartMs < range.endMs,
    );
    let cursor2 = range.startMs;
    for (const slow of overlaps) {
      const slowStart = Math.max(range.startMs, slow.srcStartMs);
      const slowEnd = Math.min(range.endMs, slow.srcEndMs);
      if (slowStart > cursor2) pieces.push({ srcStartMs: cursor2, srcEndMs: slowStart, speed: 1, outStartMs: 0 });
      pieces.push({ srcStartMs: slowStart, srcEndMs: slowEnd, speed: slow.speed, outStartMs: 0 });
      cursor2 = slowEnd;
    }
    if (cursor2 < range.endMs) pieces.push({ srcStartMs: cursor2, srcEndMs: range.endMs, speed: 1, outStartMs: 0 });
  }

  let outCursor = 0;
  for (const piece of pieces) {
    piece.outStartMs = outCursor;
    outCursor += (piece.srcEndMs - piece.srcStartMs) / piece.speed;
  }
  const outputDurationMs = Math.max(500, Math.round(outCursor));

  const mapSourceTime = (ms: number): number => {
    if (ms <= pieces[0].srcStartMs) return 0;
    for (const piece of pieces) {
      if (ms >= piece.srcStartMs && ms <= piece.srcEndMs) {
        return piece.outStartMs + (ms - piece.srcStartMs) / piece.speed;
      }
    }
    return outputDurationMs;
  };

  // 5. Smooth camera moves on emphasis anchors, spaced out and never on top of each other.
  const zooms: ClipZoomWindow[] = [];
  if (options.zoomEnabled) {
    // A short clip gets at most two moves; only a longer clip can earn three.
    const maxZooms = outputDurationMs >= 30_000 ? 3 : 2;
    const anchors: { atMs: number; score: number; reason: string }[] = [];
    for (const word of words) {
      const score = emphasisScore(word.text);
      if (score < 0.6) continue;
      anchors.push({ atMs: word.startMs, score, reason: `emphasis on “${word.text}”` });
    }
    if (input.signals?.peaksMs.length) {
      for (const peak of input.signals.peaksMs) {
        if (peak < trimStart || peak > trimEnd) continue;
        anchors.push({ atMs: peak, score: 0.7, reason: 'audio peak' });
      }
    }
    // A real visual cut is often a reaction or a new beat. It is a weaker
    // anchor than an emphatic word, but it can earn one of the three moves.
    for (const scene of input.signals?.sceneChangesMs ?? []) {
      if (scene < trimStart || scene > trimEnd) continue;
      anchors.push({ atMs: scene, score: 0.55, reason: 'visual change' });
    }
    anchors.sort((a, b) => b.score - a.score);

    for (const anchor of anchors) {
      if (zooms.length >= maxZooms) break;
      // A visual cut by itself is not enough reason to move the frame. Keep the
      // camera still unless an emphatic line or an audio peak supports the move.
      if (anchor.score < 0.6) continue;
      const outMs = mapSourceTime(anchor.atMs);
      if (outMs < 650 || outMs > outputDurationMs - 1_100) continue;
      const windowStart = Math.round(clamp(outMs - 450, 0, outputDurationMs - 1_100));
      const windowEnd = Math.round(clamp(windowStart + 2_000, windowStart + 1_000, outputDurationMs));
      // Leave breathing room between moves so the frame never feels busy.
      if (zooms.some((zoom) => windowStart < zoom.endMs + 2_600 && windowEnd > zoom.startMs - 2_600)) continue;
      zooms.push({
        startMs: windowStart,
        endMs: windowEnd,
        // Keep punch-ins barely perceptible but still visible. Intensity 0.4–2
        // maps to 1.03×–1.10×; the renderer enforces the same ceiling.
        scale: Math.round(clamp(1 + 0.05 * intensity, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE) * 1000) / 1000,
        reason: anchor.reason,
      });
    }
    zooms.sort((a, b) => a.startMs - b.startMs);
  }

  // 6. Captions in the edited timeline (pause removal and slow motion applied).
  let captionWords: TimedWord[];
  if (options.captionText && options.captionText.trim()) {
    captionWords = distributeCaptionText(options.captionText, outputDurationMs);
  } else {
    captionWords = words
      .map((word) => {
        const startOut = clamp(mapSourceTime(word.startMs), 0, outputDurationMs);
        const endOut = clamp(mapSourceTime(word.endMs), startOut + 60, outputDurationMs);
        return { text: word.text, startMs: Math.round(startOut), endMs: Math.round(endOut) };
      })
      .filter((word) => word.startMs < outputDurationMs);
  }

  const effectsSummary: string[] = [];
  effectsSummary.push(`${(outputDurationMs / 1000).toFixed(1)}s edited from ${((trimEnd - trimStart) / 1000).toFixed(1)}s`);
  const removedMs = removedPauses.reduce((sum, pause) => sum + (pause.endMs - pause.startMs), 0);
  if (removedMs > 0) effectsSummary.push(`${(removedMs / 1000).toFixed(1)}s of pauses removed`);
  if (zooms.length > 0) {
    const maxScale = Math.max(...zooms.map((zoom) => zoom.scale));
    effectsSummary.push(`${zooms.length} punch-in${zooms.length === 1 ? '' : 's'} to ${maxScale.toFixed(2)}×`);
  }
  if (slowMotion.length > 0) {
    effectsSummary.push(`slow motion ${SLOW_SPEED}× for ${(SLOW_MAX_MS / 1000).toFixed(1)}s`);
  }
  if (input.framing?.strategy === 'subject-following') {
    effectsSummary.push('subject-aware framing');
  }
  if (options.captionText && options.captionText.trim()) effectsSummary.push('custom caption text');

  return {
    sourceStartMs: trimStart,
    sourceEndMs: trimEnd,
    outputDurationMs,
    pieces,
    removedPauses,
    zooms,
    slowMotion: slowMotion.map((slow) => ({
      startMs: Math.round(mapSourceTime(slow.srcStartMs)),
      endMs: Math.round(mapSourceTime(slow.srcEndMs)),
      speed: slow.speed,
      reason: slow.reason,
    })),
    captionWords,
    framing: input.framing ?? null,
    effectsSummary,
  };
}

function averageLoudnessSafe(signals: MediaSignals | null | undefined, startMs: number, endMs: number): number | null {
  if (!signals || signals.audio.length === 0) return null;
  const inRange = signals.audio.filter((level) => level.tMs >= startMs && level.tMs <= endMs);
  if (inRange.length === 0) return null;
  return inRange.reduce((sum, level) => sum + level.rms, 0) / inRange.length;
}

/** Builds the FFmpeg zoompan expression for the planned punch-in windows. */
export function buildZoomExpression(zooms: ClipZoomWindow[], _intensity = 1): string {
  if (zooms.length === 0) return '1';
  const rampIn = 0.5;
  const rampOut = 0.42;
  const parts = zooms.map((zoom) => {
    const amplitude = Math.max(0, zoom.scale - 1);
    const start = (zoom.startMs / 1000).toFixed(3);
    const end = (zoom.endMs / 1000).toFixed(3);
    const entering = `clip((it-${start})/${rampIn},0,1)`;
    const leaving = `clip((${end}-it)/${rampOut},0,1)`;
    // Smoothstep in and out: no sudden snap at either end of the move.
    const easeIn = `(${entering}*${entering}*(3-2*${entering}))`;
    const easeOut = `(${leaving}*${leaving}*(3-2*${leaving}))`;
    return `${amplitude.toFixed(4)}*${easeIn}*${easeOut}`;
  });
  return `min(${MAX_ZOOM_SCALE.toFixed(2)},1+${parts.join('+')})`;
}
