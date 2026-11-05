import type { ClipFraming } from '../types';

/**
 * 9:16 vertical framing.
 *
 * With no subject estimate this keeps the deterministic center crop. When the
 * frame analyser supplies a confident subject centre, the crop follows that
 * subject; if the centre moves during the clip, the camera eases between the
 * start and end positions instead of snapping. This is visual saliency + skin-
 * tone tracking, not face recognition, so it degrades to centre framing whenever
 * the evidence is weak.
 */

export interface SourceDimensions {
  width: number;
  height: number;
}

export interface CropPlan {
  filter: string;
  strategy: 'crop-center' | 'crop-top' | 'crop-subject' | 'scale';
  cropWidth: number;
  cropHeight: number;
  offsetX: number;
  offsetY: number;
  /** True when the crop filter eases between two subject positions. */
  animated: boolean;
}

export const TARGET_WIDTH = 1080;
export const TARGET_HEIGHT = 1920;

function even(value: number): number {
  const rounded = Math.floor(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildVerticalFilter(
  source: SourceDimensions,
  options: {
    focus?: 'center' | 'top';
    framing?: ClipFraming | null;
    targetWidth?: number;
    targetHeight?: number;
    /** Edited output duration; required for a smooth subject pan. */
    durationMs?: number;
  } = {},
): CropPlan {
  const targetWidth = options.targetWidth ?? TARGET_WIDTH;
  const targetHeight = options.targetHeight ?? TARGET_HEIGHT;
  const width = Math.max(2, Math.round(source.width));
  const height = Math.max(2, Math.round(source.height));
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = width / height;

  let cropWidth = width;
  let cropHeight = height;
  let offsetX = 0;
  let offsetY = 0;
  let strategy: CropPlan['strategy'] = 'scale';
  let animated = false;

  if (sourceAspect > targetAspect + 0.001) {
    // Wider than 9:16 (landscape, square, 4:5): keep full height, crop the sides.
    cropWidth = Math.min(width, even((height * targetWidth) / targetHeight));
    const maxShift = Math.max(0, width - cropWidth);
    const halfWidth = width / 2;
    const framing = options.framing;
    const confident =
      framing &&
      framing.confidence >= 0.15 &&
      framing.strategy === 'subject-following';
    const startX = confident ? clamp(framing.startX, -1, 1) : 0;
    const endX = confident ? clamp(framing.endX, -1, 1) : startX;
    const canPan =
      confident &&
      Math.abs(endX - startX) > 0.04 &&
      (options.durationMs ?? 0) >= 500 &&
      maxShift > 0.5;

    if (canPan) {
      const base = even((width - cropWidth) / 2);
      const seconds = Math.max(0.5, (options.durationMs ?? 0) / 1000);
      const progress = `clip(t/${seconds.toFixed(3)},0,1)`;
      const eased = `${progress}*${progress}*(3-2*${progress})`;
      const raw = `${base.toFixed(2)}+${halfWidth.toFixed(2)}*(${startX.toFixed(
        3,
      )}+(${endX.toFixed(3)}-${startX.toFixed(3)})*(${eased}))`;
      const expression = `clip(${raw},0,${maxShift.toFixed(2)})`;
      offsetX = base;
      animated = true;
      strategy = 'crop-subject';
      // The quoted expression is evaluated per frame. Crop supports `t` and
      // clamps the resulting position inside the source frame.
      return finalizePlan(
        `crop=${even(cropWidth)}:${even(cropHeight)}:'${expression}':${even(offsetY)}`,
        strategy,
        cropWidth,
        cropHeight,
        offsetX,
        offsetY,
        animated,
        targetWidth,
        targetHeight,
      );
    }

    offsetX = even((width - cropWidth) / 2 + startX * halfWidth);
    offsetX = Math.round(clamp(offsetX, 0, maxShift));
    strategy = Math.abs(startX) > 0.025 ? 'crop-subject' : 'crop-center';
  } else if (sourceAspect < targetAspect - 0.001) {
    // Taller than 9:16 (rare): keep full width, crop equal top/bottom.
    cropHeight = Math.min(height, even((width * targetHeight) / targetWidth));
    offsetY = options.focus === 'top' ? 0 : even((height - cropHeight) / 2);
    strategy = options.focus === 'top' ? 'crop-top' : 'crop-center';
  }

  return finalizePlan(
    cropWidth !== width || cropHeight !== height
      ? `crop=${even(cropWidth)}:${even(cropHeight)}:${Math.max(0, even(offsetX))}:${Math.max(0, even(offsetY))}`
      : '',
    strategy,
    cropWidth,
    cropHeight,
    offsetX,
    offsetY,
    animated,
    targetWidth,
    targetHeight,
  );
}

function finalizePlan(
  cropFilter: string,
  strategy: CropPlan['strategy'],
  cropWidth: number,
  cropHeight: number,
  offsetX: number,
  offsetY: number,
  animated: boolean,
  targetWidth: number,
  targetHeight: number,
): CropPlan {
  const filters: string[] = [];
  if (cropFilter) filters.push(cropFilter);
  filters.push(`scale=${targetWidth}:${targetHeight}:flags=lanczos`);
  filters.push('setsar=1');
  filters.push('format=yuv420p');
  return {
    filter: filters.join(','),
    strategy,
    cropWidth,
    cropHeight,
    offsetX,
    offsetY,
    animated,
  };
}
