'use client';

import { PIPELINE_STAGES } from '@/lib/stages';
import type { PipelineStage, ProjectStatus } from '@/lib/types';

function StageIcon({
  state,
}: {
  state: 'done' | 'active' | 'pending' | 'failed';
}) {
  if (state === 'done') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
        <svg viewBox="0 0 16 16" className="h-3 w-3 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/25 bg-white/10">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white" />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-rose-500/30 bg-rose-500/10 text-xs text-rose-300">
        !
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-ink-600 bg-ink-850">
      <span className="h-1.5 w-1.5 rounded-full bg-ink-500" />
    </span>
  );
}

export function ProgressTimeline({
  stage,
  status,
  progress,
  detail,
}: {
  stage: PipelineStage;
  status: ProjectStatus;
  progress: number;
  detail: string | null;
}) {
  const currentIndex = PIPELINE_STAGES.findIndex((entry) => entry.key === stage);
  const failed = status === 'failed';

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-white">
            {status === 'queued'
              ? 'Queued for processing'
              : failed
                ? 'Processing stopped'
                : status === 'completed'
                  ? 'Finished'
                  : (PIPELINE_STAGES[Math.max(0, currentIndex)]?.label ?? 'Working')}
          </p>
          <p className="mt-0.5 text-xs text-mist-400">
            {detail ?? (status === 'queued' ? 'Waiting for a worker to pick this up' : 'Working through the pipeline')}
          </p>
        </div>
        <span className="font-mono text-sm tabular-nums text-mist-300">{Math.round(progress)}%</span>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out ${
            failed ? 'bg-rose-500/70' : 'bg-white'
          }`}
          style={{ width: `${Math.max(2, Math.min(100, progress))}%` }}
        />
      </div>

      <ol className="space-y-3">
        {PIPELINE_STAGES.map((entry, index) => {
          const isCurrent = entry.key === stage && !failed && status !== 'completed';
          const isDone = status === 'completed' || currentIndex > index;
          const state = failed && currentIndex === index
            ? 'failed'
            : isDone
              ? 'done'
              : isCurrent
                ? 'active'
                : 'pending';
          return (
            <li key={entry.key} className="flex items-start gap-3">
              <StageIcon state={state} />
              <div className="min-w-0">
                <p
                  className={`text-sm leading-6 ${
                    state === 'pending' ? 'text-mist-500' : 'text-mist-200'
                  }`}
                >
                  {entry.label}
                </p>
                <p className="text-xs leading-5 text-mist-500">{entry.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
