import { buildZoomExpression, type EditPlan } from '../edit/plan';
import { buildVerticalFilter } from '../media/crop';

export interface ClipRenderInput {
  plan: EditPlan;
  sourceWidth: number;
  sourceHeight: number;
  /** Path inside the FFmpeg virtual filesystem. */
  source: string;
  output: string;
  /** ASS caption path inside the virtual filesystem, or null for no captions. */
  captionFile: string | null;
  fontDir?: string;
}

/**
 * Builds the FFmpeg.wasm arguments for a final 9:16 clip.
 *
 * Every edit piece gets its own input with `-ss`/`-t`. FFmpeg then decodes only
 * the seconds around that piece instead of decoding from 00:00 to the end of a
 * full-length recording for every clip. Input-level seeking is frame-accurate
 * when the output is transcoded, so captions, zooms and slow motion still line
 * up with the planner's source-to-output clock.
 */
export function buildClipRenderArgs(input: ClipRenderInput): string[] {
  const pieces = input.plan.pieces.filter((piece) => piece.srcEndMs - piece.srcStartMs >= 40);
  if (pieces.length === 0) throw new Error('The edit plan contained no usable video segments.');

  const crop = buildVerticalFilter(
    { width: input.sourceWidth, height: input.sourceHeight },
    { framing: input.plan.framing, durationMs: input.plan.outputDurationMs },
  );
  const inputs: string[] = [];
  const filters: string[] = [];
  const concatInputs: string[] = [];

  pieces.forEach((piece, index) => {
    const pieceMs = piece.srcEndMs - piece.srcStartMs;
    inputs.push(
      '-ss',
      (piece.srcStartMs / 1000).toFixed(3),
      '-t',
      (pieceMs / 1000).toFixed(3),
      '-i',
      input.source,
    );
    const speed = piece.speed !== 1 ? piece.speed.toFixed(3) : '1';
    filters.push(`[${index}:v]setpts=(PTS-STARTPTS)/${speed},settb=AVTB[v${index}]`);
    filters.push(
      `[${index}:a]asetpts=PTS-STARTPTS${piece.speed !== 1 ? `,atempo=${speed}` : ''}[a${index}]`,
    );
    concatInputs.push(`[v${index}][a${index}]`);
  });

  filters.push(`${concatInputs.join('')}concat=n=${pieces.length}:v=1:a=1[vcat][acat]`);
  // `zoompan` assigns one output frame per input frame at the requested
  // timebase. A 23.976 fps source must be resampled to 30 fps *before* it,
  // otherwise its 322 frames are stamped at 1/30s and the video track ends
  // 20% early while the audio keeps the full duration.
  let chain = `[vcat]${crop.filter},fps=30`;
  if (input.plan.zooms.length > 0) {
    const zoom = buildZoomExpression(input.plan.zooms);
    chain += `,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`;
  }
  if (input.captionFile) {
    chain += `,subtitles=${input.captionFile}:fontsdir=${input.fontDir ?? '/fonts'}`;
  }
  filters.push(`${chain}[vout]`);

  return [
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[acat]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    (input.plan.outputDurationMs / 1000).toFixed(3),
    '-y',
    input.output,
  ];
}
