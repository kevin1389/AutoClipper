import type { ProjectStatus } from '@/lib/types';

const STATUS_META: Record<ProjectStatus, { label: string; dot: string; tone: string }> = {
  draft: { label: 'Draft', dot: 'bg-mist-500', tone: 'text-mist-300 border-ink-600 bg-ink-850' },
  ready: { label: 'Ready to process', dot: 'bg-mist-300', tone: 'text-mist-200 border-ink-600 bg-ink-850' },
  queued: { label: 'Queued', dot: 'bg-amber-400', tone: 'text-amber-200 border-amber-500/30 bg-amber-500/10' },
  processing: {
    label: 'Processing',
    dot: 'bg-sky-400 animate-pulse-soft',
    tone: 'text-sky-200 border-sky-500/30 bg-sky-500/10',
  },
  completed: {
    label: 'Completed',
    dot: 'bg-emerald-400',
    tone: 'text-emerald-200 border-emerald-500/30 bg-emerald-500/10',
  },
  failed: { label: 'Failed', dot: 'bg-rose-400', tone: 'text-rose-200 border-rose-500/30 bg-rose-500/10' },
};

export function StatusPill({ status, label }: { status: ProjectStatus; label?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${meta.tone}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {label ?? meta.label}
    </span>
  );
}

export function statusLabel(status: ProjectStatus): string {
  return STATUS_META[status]?.label ?? status;
}
