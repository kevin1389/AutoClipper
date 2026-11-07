'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatDuration } from '@/lib/format';
import type { ClipEdits, ClipScoreBreakdown, ClipView } from '@/lib/types';

interface ClipCardProps {
  clip: ClipView;
  onUpdated?: (clip: ClipView) => void;
  /** Runs FFmpeg.wasm in the project's processing Web Worker. */
  onRerender?: (clip: ClipView, edits: ClipEdits) => Promise<ClipView>;
}

const SCORE_FIELDS = [
  { key: 'hook', label: 'Hook' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'clarity', label: 'Clarity' },
  { key: 'substance', label: 'Substance' },
  { key: 'context', label: 'Context' },
  { key: 'payoff', label: 'Payoff' },
  { key: 'pacing', label: 'Pacing' },
] as const;

type ScoreFieldKey = (typeof SCORE_FIELDS)[number]['key'];

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function scoreValue(breakdown: ClipScoreBreakdown | null | undefined, key: ScoreFieldKey): number {
  if (!breakdown) return 0;
  // Older persisted clips used "entertainment"; keep them readable after the
  // score was renamed to engagement.
  if (key === 'engagement') return breakdown.engagement ?? breakdown.entertainment ?? 0;
  const value = breakdown[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function ClipCard({ clip, onUpdated, onRerender }: ClipCardProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [startSec, setStartSec] = useState(seconds(clip.edits?.startMs ?? clip.startMs));
  const [endSec, setEndSec] = useState(seconds(clip.edits?.endMs ?? clip.endMs));
  const [captionText, setCaptionText] = useState(clip.edits?.captionText ?? '');
  const [zoomEnabled, setZoomEnabled] = useState(clip.edits?.zoomEnabled ?? true);
  const [zoomIntensity, setZoomIntensity] = useState(clip.edits?.zoomIntensity ?? 1);
  const [slowMotionEnabled, setSlowMotionEnabled] = useState(clip.edits?.slowMotionEnabled ?? false);
  const [revision, setRevision] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [preloadVideo, setPreloadVideo] = useState(false);
  const ready = clip.status === 'rendered';

  // Loading every clip's metadata at once saturates the provider connection
  // pool, so the first clip can take minutes to start. Start a clip's request
  // only when its card is near the viewport.
  useEffect(() => {
    setPreloadVideo(false);
    if (!ready) return;
    const video = videoRef.current;
    if (!video) return;
    if (typeof IntersectionObserver === 'undefined') {
      setPreloadVideo(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setPreloadVideo(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [clip.id, ready, revision]);

  useEffect(() => {
    setStartSec(seconds(clip.edits?.startMs ?? clip.startMs));
    setEndSec(seconds(clip.edits?.endMs ?? clip.endMs));
    setCaptionText(clip.edits?.captionText ?? '');
    setZoomEnabled(clip.edits?.zoomEnabled ?? true);
    setZoomIntensity(clip.edits?.zoomIntensity ?? 1);
    setSlowMotionEnabled(clip.edits?.slowMotionEnabled ?? false);
  }, [clip.id, clip.edits, clip.startMs, clip.endMs]);

  const zoomCount = clip.effects?.zoomWindows.length ?? 0;
  const slowCount = clip.effects?.slowMotion.length ?? 0;
  const removedSeconds = clip.effects ? clip.effects.removedPausesMs / 1000 : 0;

  const applyResult = (payload: { clip?: ClipView }) => {
    if (!payload.clip) throw new Error('The server did not return the updated clip.');
    setRevision((value) => value + 1);
    setEditing(false);
    setNotice('Re-rendered with your settings.');
    onUpdated?.({
      ...clip,
      ...payload.clip,
      videoUrl: `${clip.videoUrl.split('?')[0]}?v=${Date.now()}`,
      posterUrl: clip.posterUrl ? `${clip.posterUrl.split('?')[0]}?v=${Date.now()}` : null,
    });
  };

  const send = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(path, {
        method: path.endsWith('/regenerate') ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await response.json().catch(() => ({}))) as { clip?: ClipView; error?: string };
      if (!response.ok) throw new Error(data.error ?? `Request failed (HTTP ${response.status})`);
      if (!data.clip) throw new Error('The server did not return the edited clip.');
      if (!onRerender) throw new Error('The browser renderer is not available on this page.');
      const edits: ClipEdits = data.clip.edits ?? {
        ...(clip.edits ?? {
          startMs: clip.startMs,
          endMs: clip.endMs,
          captionText: null,
          zoomEnabled: zoomEnabled,
          zoomIntensity: zoomIntensity,
          slowMotionEnabled: slowMotionEnabled,
        }),
      };
      const rendered = await onRerender(data.clip, edits);
      applyResult({ clip: rendered });
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    send(`/api/clips/${clip.id}`, {
      startMs: Math.round(Number(startSec) * 1000),
      endMs: Math.round(Number(endSec) * 1000),
      captionText: captionText.trim() ? captionText : null,
      zoomEnabled,
      zoomIntensity,
      slowMotionEnabled,
    });

  const regenerate = () => send(`/api/clips/${clip.id}/regenerate`);

  return (
    <article className="group panel-soft overflow-hidden">
      <div className="relative aspect-[9/16] w-full bg-black">
        {ready ? (
          <video
            key={`${clip.id}-${revision}-${clip.bytes ?? 0}`}
            ref={videoRef}
            className="h-full w-full object-cover"
            controls
            playsInline
            preload={preloadVideo ? 'metadata' : 'none'}
            poster={clip.posterUrl ?? undefined}
          >
            <source src={clip.videoUrl} type="video/mp4" />
          </video>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span className="chip border-ink-600 text-mist-400">
              {clip.status === 'failed' ? 'Render failed' : busy ? 'Re-rendering' : 'Queued for render'}
            </span>
            <p className="text-xs text-mist-500">
              {clip.error ? clip.error.slice(0, 160) : 'This clip will appear here once FFmpeg finishes.'}
            </p>
          </div>
        )}

        <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5">
          <span
            className="rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white/90 backdrop-blur"
            title="Estimated rank by potential"
          >
            {String(clip.index + 1).padStart(2, '0')}
          </span>
          {ready && clip.captionMode && clip.captionMode !== 'none' && (
            <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur">
              CC
            </span>
          )}
          {clip.scoreBreakdown ? (
            <span
              className="rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white/80 backdrop-blur"
              title="Estimated potential — not a guarantee of views"
            >
              {(clip.scoreBreakdown.total * 100).toFixed(0)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold leading-snug text-white">{clip.title}</h3>
          {clip.reason && <p className="line-clamp-3 text-xs leading-relaxed text-mist-500">{clip.reason}</p>}
          {clip.evidence.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {clip.evidence.slice(0, 4).map((item) => (
                <span
                  key={item}
                  className="rounded bg-ink-800/80 px-1.5 py-0.5 text-[10px] leading-tight text-mist-400"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>

        {clip.scoreBreakdown && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wide text-mist-500">Estimated potential</span>
              <span className="font-mono text-[11px] text-mist-300">
                {(clip.scoreBreakdown.total * 100).toFixed(0)}/100
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {SCORE_FIELDS.map((field) => (
                <div key={field.key} className="flex items-center gap-1.5">
                  <span className="w-[74px] shrink-0 text-[10px] text-mist-500">{field.label}</span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-ink-700">
                    <span
                      className="block h-full rounded-full bg-white/70"
                      style={{ width: `${Math.round(scoreValue(clip.scoreBreakdown, field.key) * 100)}%` }}
                    />
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[10px] leading-relaxed text-mist-500">
              Estimated potential ranks moments for review. It is not a guarantee of views.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-mist-400">
          <span>
            {formatDuration(clip.edits?.startMs ?? clip.startMs)}–{formatDuration(clip.edits?.endMs ?? clip.endMs)}
          </span>
          <span className="text-ink-500">·</span>
          <span>{formatDuration(clip.durationMs ?? clip.endMs - clip.startMs)}</span>
          {clip.bytes ? (
            <>
              <span className="text-ink-500">·</span>
              <span>{formatBytes(clip.bytes)}</span>
            </>
          ) : null}
          {clip.width && clip.height ? (
            <>
              <span className="text-ink-500">·</span>
              <span>
                {clip.width}×{clip.height}
              </span>
            </>
          ) : null}
        </div>

        {(zoomCount > 0 || slowCount > 0 || removedSeconds > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {zoomCount > 0 && (
              <span className="chip text-[10px]">
                {zoomCount} camera move{zoomCount === 1 ? '' : 's'}
              </span>
            )}
            {slowCount > 0 && <span className="chip text-[10px]">slow motion</span>}
            {clip.cropStrategy === 'crop-subject' && (
              <span className="chip text-[10px]">subject framing</span>
            )}
            {removedSeconds > 0.05 && (
              <span className="chip text-[10px]">{removedSeconds.toFixed(1)}s pauses cut</span>
            )}
          </div>
        )}

        {clip.transcriptText && (
          <p className="line-clamp-3 rounded-lg border border-ink-800 bg-ink-950/60 p-2 text-[11px] leading-relaxed text-mist-500">
            {clip.transcriptText}
          </p>
        )}

        {notice && (
          <p className="rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-[11px] text-mist-200">
            {notice}
          </p>
        )}
        {error && (
          <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-2.5 py-1.5 text-[11px] text-rose-200">
            {error}
          </p>
        )}

        {editing ? (
          <div className="space-y-3 rounded-xl border border-ink-700 bg-ink-950/60 p-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-mist-500">Start (s)</span>
                <input
                  className="input py-1.5 font-mono text-xs"
                  inputMode="decimal"
                  value={startSec}
                  onChange={(event) => setStartSec(event.target.value)}
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-mist-500">End (s)</span>
                <input
                  className="input py-1.5 font-mono text-xs"
                  inputMode="decimal"
                  value={endSec}
                  onChange={(event) => setEndSec(event.target.value)}
                />
              </label>
            </div>

            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-mist-500">Caption text</span>
              <textarea
                className="input min-h-[64px] py-1.5 text-xs"
                placeholder="Leave empty to use the transcript with word-synced timing"
                value={captionText}
                onChange={(event) => setCaptionText(event.target.value)}
              />
            </label>

            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-xs text-mist-300">
                <input
                  type="checkbox"
                  checked={zoomEnabled}
                  onChange={(event) => setZoomEnabled(event.target.checked)}
                  className="h-3.5 w-3.5 accent-white"
                />
                Camera moves
              </label>
              <input
                type="range"
                min={0.4}
                max={2}
                step={0.1}
                value={zoomIntensity}
                disabled={!zoomEnabled}
                onChange={(event) => setZoomIntensity(Number(event.target.value))}
                className="w-24 accent-white disabled:opacity-40"
                aria-label="Zoom intensity"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-mist-300">
              <input
                type="checkbox"
                checked={slowMotionEnabled}
                onChange={(event) => setSlowMotionEnabled(event.target.checked)}
                className="h-3.5 w-3.5 accent-white"
              />
              Slow motion (optional)
            </label>

            <p className="text-[10px] leading-relaxed text-mist-500">
              Saving runs FFmpeg.wasm in this tab and replaces this clip&apos;s MP4. Camera moves and
              slow motion are only placed where the transcript, audio peaks and visual changes support
              them; subject framing follows the dominant person or detail.
            </p>

            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary flex-1 text-xs" onClick={() => void save()} disabled={busy}>
                {busy ? 'Rendering in browser…' : 'Save & re-render'}
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ready ? (
              <a href={clip.downloadUrl} className="btn-secondary flex-1 text-xs" download>
                Download MP4
              </a>
            ) : (
              <button type="button" className="btn-secondary flex-1 text-xs" disabled>
                Download unavailable
              </button>
            )}
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                setEditing(true);
                setNotice(null);
              }}
              disabled={busy}
            >
              Edit
            </button>
            <button type="button" className="btn-ghost text-xs" onClick={() => void regenerate()} disabled={busy}>
              {busy ? 'Working…' : 'Regenerate'}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
