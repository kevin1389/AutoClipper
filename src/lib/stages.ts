import type { PipelineStage } from './types';

/**
 * Pipeline stages and their share of the overall progress bar.
 * Kept free of server-only imports so the UI can render the same timeline.
 */
export const PIPELINE_STAGES: ReadonlyArray<{
  key: Exclude<PipelineStage, 'queued' | 'done'>;
  label: string;
  description: string;
  weight: number;
}> = [
  {
    key: 'probe',
    label: 'Inspect source',
    description: 'Reading duration, resolution and audio tracks',
    weight: 5,
  },
  {
    key: 'audio',
    label: 'Extract audio',
    description: 'Preparing a 16 kHz mono track for transcription',
    weight: 10,
  },
  {
    key: 'transcribe',
    label: 'Transcribe',
    description: 'Generating a timestamped transcript',
    weight: 35,
  },
  {
    key: 'select',
    label: 'Find highlights',
    description: 'Scoring hooks, context, payoff, audio peaks and visual changes',
    weight: 15,
  },
  {
    key: 'render',
    label: 'Render clips',
    description: 'Cutting 9:16 video with zooms, slow motion and synced captions',
    weight: 35,
  },
];

/** Overall progress (0-100) for a stage and the fraction completed within it. */
export function progressFor(
  stage: Exclude<PipelineStage, 'queued' | 'done'>,
  fractionWithinStage = 0,
): number {
  let done = 0;
  for (const entry of PIPELINE_STAGES) {
    if (entry.key === stage) {
      const bounded = Math.min(1, Math.max(0, fractionWithinStage));
      return Math.round(done + entry.weight * bounded);
    }
    done += entry.weight;
  }
  return 100;
}

export function stageIndex(stage: PipelineStage): number {
  if (stage === 'queued') return -1;
  if (stage === 'done') return PIPELINE_STAGES.length;
  return PIPELINE_STAGES.findIndex((entry) => entry.key === stage);
}
