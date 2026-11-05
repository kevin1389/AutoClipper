import type { ClipFraming } from '../types';

/**
 * Lightweight, explainable subject framing.
 *
 * This is not face recognition and it does not claim to identify a speaker. It
 * samples a handful of low-resolution frames and estimates the horizontal centre
 * of visual interest from skin-tone-like pixels and high-contrast detail. On a
 * normal talking-head recording that follows the person's face/body; on a slide
 * or screen recording it follows the densest useful detail. When the evidence is
 * weak it returns a centre crop rather than inventing a pan.
 */

export interface FrameFocus {
  /** -1 = left edge, 0 = centre, +1 = right edge. */
  x: number;
  confidence: number;
  skinRatio: number;
  edgeRatio: number;
}

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 54;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Analyses one tightly packed RGB24 frame. */
export function analyzeFrameFocus(rgb: Uint8Array, width: number, height: number): FrameFocus {
  const pixels = Math.max(1, width * height);
  let weightSum = 0;
  let weightedX = 0;
  let skinPixels = 0;
  let edgePixels = 0;

  const lumaAt = (x: number, y: number): number => {
    const index = (y * width + x) * 3;
    return 0.299 * rgb[index] + 0.587 * rgb[index + 1] + 0.114 * rgb[index + 2];
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const r = rgb[index];
      const g = rgb[index + 1];
      const b = rgb[index + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const skin =
        luma > 40 &&
        luma < 238 &&
        cb >= 77 &&
        cb <= 127 &&
        cr >= 133 &&
        cr <= 173 &&
        r > g &&
        r > b;
      if (skin) skinPixels += 1;

      const lumaX = x + 1 < width ? lumaAt(x + 1, y) : luma;
      const lumaY = y + 1 < height ? lumaAt(x, y + 1) : luma;
      const edge = (Math.abs(lumaX - luma) + Math.abs(lumaY - luma)) / 255;
      if (edge > 0.12) edgePixels += 1;

      // Centre prior stops a bright corner from stealing the frame. The bottom
      // of a source often contains lower-thirds or burned-in UI, so downweight
      // it strongly; the subject's face is normally in the upper-middle.
      const nx = (x / Math.max(1, width - 1) - 0.5) * 2;
      const ny = (y / Math.max(1, height - 1) - 0.5) * 2;
      const centre = Math.max(0.18, 1 - 0.32 * Math.hypot(nx, ny));
      const bottomPenalty = y > height * 0.84 ? 0.18 : 1;
      // Skin pixels are already a strong subject signal; do not pull their
      // centroid toward the middle of the frame or an off-centre person will
      // still be cropped at the edge. The centre prior applies only to generic
      // high-contrast detail when no person is visible.
      const skinWeight = skin ? 6 + Math.min(1.5, edge * 3) : 0;
      // A uniform background should contribute no pull. Otherwise a low floor
      // on every pixel overwhelms one small off-centre subject and drags the
      // crop back toward the middle. Only actual contrast competes with skin.
      const detailWeight = centre * Math.min(2.2, edge * 7) * 0.5;
      const weight = (skinWeight + detailWeight) * bottomPenalty;
      weightSum += weight;
      weightedX += x * weight;
    }
  }

  if (weightSum <= 0) {
    return { x: 0, confidence: 0, skinRatio: 0, edgeRatio: 0 };
  }

  const skinRatio = skinPixels / pixels;
  const edgeRatio = edgePixels / pixels;
  const x = clamp(((weightedX / weightSum) / Math.max(1, width - 1) - 0.5) * 2, -1, 1);
  const confidence = clamp(skinRatio * 6 + edgeRatio * 0.55, 0, 1);
  return { x, confidence, skinRatio, edgeRatio };
}

export function splitRawFrames(bytes: Uint8Array, width = SAMPLE_WIDTH, height = SAMPLE_HEIGHT): Uint8Array[] {
  const frameBytes = width * height * 3;
  if (frameBytes <= 0) return [];
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset + frameBytes <= bytes.byteLength; offset += frameBytes) {
    frames.push(bytes.subarray(offset, offset + frameBytes));
  }
  return frames;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function planFraming(
  frames: Uint8Array[],
  width = SAMPLE_WIDTH,
  height = SAMPLE_HEIGHT,
): ClipFraming {
  const focus = frames
    .map((frame) => analyzeFrameFocus(frame, width, height))
    .filter((sample) => sample.confidence >= 0.1 && Number.isFinite(sample.x));

  if (focus.length === 0) {
    return { startX: 0, endX: 0, confidence: 0, strategy: 'crop-center', samples: frames.length };
  }

  // Use only the most recent samples at each end. Averaging the last three of
  // five samples blends in the subject's old position after a late move, so the
  // crop finishes short of the person even though the analysis found them.
  const edgeWindow = Math.min(3, Math.max(2, Math.floor(focus.length / 3)));
  const start = average(focus.slice(0, edgeWindow).map((sample) => sample.x));
  const end = average(focus.slice(-edgeWindow).map((sample) => sample.x));
  const confidence = clamp(average(focus.map((sample) => sample.confidence)), 0, 1);
  const meaningful = Math.abs(start) > 0.035 || Math.abs(end) > 0.035;
  const moving = Math.abs(end - start) > 0.07;

  if (!meaningful) {
    return { startX: 0, endX: 0, confidence, strategy: 'crop-center', samples: frames.length };
  }

  return {
    startX: clamp(start, -1, 1),
    endX: clamp(moving ? end : start, -1, 1),
    confidence,
    strategy: 'subject-following',
    samples: frames.length,
  };
}
