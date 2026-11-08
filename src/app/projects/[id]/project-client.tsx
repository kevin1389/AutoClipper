'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipCard } from '@/components/clip-card';
import { DeleteProjectDialog } from '@/components/delete-project-dialog';
import { ManualTranscriptDialog } from '@/components/manual-transcript-dialog';
import { ProgressTimeline } from '@/components/progress-timeline';
import { StatusPill } from '@/components/status-pill';
import { Logo } from '@/components/logo';
import { formatBytes, formatDuration } from '@/lib/format';
import { deleteLocalSource, loadLocalSource, saveLocalSource } from '@/lib/local-source-store';
import { ACCEPT_ATTRIBUTE, MAX_SOURCE_BYTES, isAllowedExtension } from '@/lib/upload-limits';
import { BrowserProcessorClient } from '@/lib/browser/client';
import type { WorkerEvent } from '@/lib/browser/protocol';
import type { ClipEdits, ClipView, PipelineStage, ProjectView, Transcript } from '@/lib/types';

type SourceProbeState = 'idle' | 'probing' | 'ready' | 'error';

export function ProjectClient({
  initialView,
  assetBaseUrl,
}: {
  initialView: ProjectView;
  assetBaseUrl: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<ProjectView>(initialView);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [manualTranscriptOpen, setManualTranscriptOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [processingHere, setProcessingHere] = useState(false);
  const [engineDetail, setEngineDetail] = useState<string | null>(null);
  const [modelDetail, setModelDetail] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const [modelFailure, setModelFailure] = useState(false);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [localSourceState, setLocalSourceState] = useState<'remote' | 'loading' | 'ready' | 'missing'>(
    initialView.sourceMode === 'local' ? 'loading' : 'remote',
  );
  const [sourceProbeState, setSourceProbeState] = useState<SourceProbeState>(
    initialView.project.durationMs && initialView.project.durationMs > 0 ? 'ready' : 'idle',
  );
  const [sourceProbeError, setSourceProbeError] = useState<string | null>(null);
  const processorRef = useRef<BrowserProcessorClient | null>(null);
  const sourceProbeClientRef = useRef<BrowserProcessorClient | null>(null);
  const sourceProbeRef = useRef<Promise<number | null> | null>(null);
  const localInputRef = useRef<HTMLInputElement>(null);
  const rerenderRef = useRef(false);

  const { project } = view;
  const active = project.status === 'queued' || project.status === 'processing';
  const isModelFailure =
    modelFailure || (project.status === 'failed' && /whisper model/i.test(project.error ?? ''));

  useEffect(() => {
    if (view.sourceMode !== 'local') {
      setLocalFile(null);
      setLocalSourceState('remote');
      return;
    }
    let cancelled = false;
    setLocalSourceState('loading');
    loadLocalSource(project.id)
      .then((stored) => {
        if (cancelled) return;
        setLocalFile(stored);
        setLocalSourceState(stored ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setLocalSourceState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, view.sourceMode]);
  const renderedClips = view.clips.filter((clip) => clip.status === 'rendered');

  const applyView = useCallback((next: ProjectView) => {
    setView(next);
  }, []);

  const refreshView = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${project.id}`, { cache: 'no-store' });
      if (response.ok) applyView((await response.json()) as ProjectView);
    } catch {
      // The worker already reported the error; keep the last view.
    }
  }, [applyView, project.id]);

  const handleWorkerEvent = useCallback(
    (event: WorkerEvent) => {
      if (event.type === 'progress') {
        if (rerenderRef.current) return;
        setView((previous) => ({
          ...previous,
          project: {
            ...previous.project,
            status: 'processing',
            stage: event.stage as PipelineStage,
            progress: event.progress,
            statusDetail: event.detail,
          },
        }));
      } else if (event.type === 'meta') {
        setView((previous) => ({
          ...previous,
          project: {
            ...previous.project,
            durationMs: event.durationMs,
            width: event.width,
            height: event.height,
            fps: event.fps,
          },
        }));
      } else if (event.type === 'engine') {
        setEngineDetail(event.detail);
      } else if (event.type === 'model') {
        setModelDetail(event.detail);
        setModelProgress(event.progress);
      } else if (event.type === 'clip') {
        setView((previous) => {
          const exists = previous.clips.some((clip) => clip.id === event.clip.id);
          return {
            ...previous,
            clips: exists
              ? previous.clips.map((clip) => (clip.id === event.clip.id ? event.clip : clip))
              : [...previous.clips, event.clip],
          };
        });
      } else if (event.type === 'done') {
        setProcessingHere(false);
        setModelDetail(null);
        setModelProgress(null);
        setModelFailure(false);
        setView((previous) => ({ ...previous, project: event.project }));
        void refreshView();
        router.refresh();
      } else if (event.type === 'error') {
        setProcessingHere(false);
        setActionError(event.message);
        setModelFailure(
          event.code === 'whisper_model_load_failed' || /whisper model/i.test(event.message),
        );
        void refreshView();
      }
    },
    [refreshView, router],
  );

  const ensureProcessor = useCallback(() => {
    if (!processorRef.current) {
      processorRef.current = new BrowserProcessorClient(handleWorkerEvent, assetBaseUrl);
    }
    return processorRef.current;
  }, [assetBaseUrl, handleWorkerEvent]);

  useEffect(() => () => {
    processorRef.current?.cancel();
    sourceProbeClientRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (project.durationMs && project.durationMs > 0) {
      setSourceProbeState('ready');
      setSourceProbeError(null);
    }
  }, [project.durationMs]);

  // Live updates over SSE, with polling as a fallback.
  useEffect(() => {
    const source = new EventSource(`/api/projects/${project.id}/events`);
    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        applyView(JSON.parse(event.data) as ProjectView);
      } catch {
        // ignore malformed frames, polling will catch up
      }
    };
    source.addEventListener('snapshot', onSnapshot as EventListener);
    source.addEventListener('done', () => source.close());
    return () => source.close();
  }, [applyView, project.id]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/projects/${project.id}`, { cache: 'no-store' });
        if (response.ok) applyView((await response.json()) as ProjectView);
      } catch {
        // transient
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [active, applyView, project.id]);

  const startProcessing = async (
    force: boolean,
    restart = false,
    manualTranscript?: Transcript,
  ) => {
    if (view.sourceMode === 'local' && !localFile) {
      setActionError('Attach the original video on this device before processing. The source never left your browser.');
      return;
    }
    setBusy(true);
    setActionError(null);
    setModelDetail(null);
    setModelProgress(null);
    setModelFailure(false);
    try {
      const response = await fetch(`/api/projects/${project.id}/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', force, resume: force, restart }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Could not start processing (HTTP ${response.status})`);
      }
      const data = (await response.json()) as { project: ProjectView['project'] };
      if (manualTranscript) {
        const saved = await fetch(`/api/projects/${project.id}/process`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'transcript',
            transcript: manualTranscript,
            meta: {
              durationMs: data.project.durationMs,
              width: data.project.width,
              height: data.project.height,
              fps: data.project.fps,
            },
          }),
        });
        if (!saved.ok) {
          const saveError = (await saved.json().catch(() => ({}))) as { error?: string };
          await fetch(`/api/projects/${project.id}/process`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'fail',
              stage: 'transcribe',
              error: saveError.error ?? 'The uploaded transcript could not be saved.',
            }),
          }).catch(() => undefined);
          throw new Error(
            saveError.error ?? `The uploaded transcript could not be saved (HTTP ${saved.status}).`,
          );
        }
      }
      setView((previous) => ({
        ...previous,
        project: data.project,
        clips: restart ? [] : previous.clips,
      }));
      setProcessingHere(true);
      setBusy(false);
      processorRef.current?.cancel();
      const processor = new BrowserProcessorClient(handleWorkerEvent, assetBaseUrl);
      processorRef.current = processor;
      processor.start(project.id, 'auto', localFile);
    } catch (error) {
      setActionError((error as Error).message);
      setProcessingHere(false);
      setBusy(false);
    }
  };

  const ensureSourceMetadata = useCallback(async (): Promise<number | null> => {
    if (project.durationMs && project.durationMs > 0) {
      setSourceProbeState('ready');
      setSourceProbeError(null);
      return project.durationMs;
    }
    if (sourceProbeRef.current) return sourceProbeRef.current;
    if (view.sourceMode === 'none') {
      setSourceProbeState('error');
      setSourceProbeError('This project has no source video to inspect.');
      return null;
    }
    if (view.sourceMode === 'local' && localSourceState !== 'ready') {
      setSourceProbeState('error');
      setSourceProbeError(
        localSourceState === 'loading'
          ? 'The local source is still loading in this browser. Try again in a moment.'
          : 'Attach the original video on this device before uploading a transcript.',
      );
      return null;
    }

    setSourceProbeState('probing');
    setSourceProbeError(null);
    const pending = (async () => {
      const client = new BrowserProcessorClient(() => undefined);
      sourceProbeClientRef.current = client;
      try {
        const meta = await client.probeSource(
          project.id,
          view.sourceMode === 'local' ? localFile : null,
        );
        const response = await fetch(`/api/projects/${project.id}/process`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'probe', meta }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          project?: ProjectView['project'];
          error?: string;
        };
        if (!response.ok || !data.project) {
          throw new Error(data.error ?? `Could not save the video duration (HTTP ${response.status}).`);
        }
        setView((previous) => ({ ...previous, project: data.project as ProjectView['project'] }));
        setSourceProbeState('ready');
        return data.project.durationMs ?? meta.durationMs;
      } catch (error) {
        setSourceProbeState('error');
        setSourceProbeError(
          error instanceof Error ? error.message : 'The source video could not be inspected.',
        );
        return null;
      } finally {
        sourceProbeClientRef.current = null;
        client.cancel();
        sourceProbeRef.current = null;
      }
    })();
    sourceProbeRef.current = pending;
    return pending;
  }, [localFile, localSourceState, project.durationMs, project.id, view.sourceMode]);

  const openManualTranscript = () => {
    setActionError(null);
    setManualTranscriptOpen(true);
    void ensureSourceMetadata();
  };

  const startWithManualTranscript = (transcript: Transcript) => {
    setManualTranscriptOpen(false);
    void startProcessing(true, true, transcript);
  };

  const rerenderClip = async (clip: ClipView, edits: ClipEdits): Promise<ClipView> => {
    rerenderRef.current = true;
    setActionError(null);
    try {
      const processor = ensureProcessor();
      const rendered = await processor.renderClip(project.id, clip, edits, localFile);
      setView((previous) => ({
        ...previous,
        clips: previous.clips.map((entry) => (entry.id === rendered.id ? rendered : entry)),
      }));
      return rendered;
    } catch (error) {
      setActionError((error as Error).message);
      await refreshView();
      throw error;
    } finally {
      rerenderRef.current = false;
    }
  };

  const attachLocalSource = async (candidate: File | null | undefined) => {
    if (!candidate) return;
    const extension = candidate.name.includes('.') ? `.${candidate.name.split('.').pop()}` : '';
    if (!isAllowedExtension(extension)) {
      setActionError(`Unsupported file type. Use ${ACCEPT_ATTRIBUTE.split(',').filter((value) => value.startsWith('.')).join(', ')}.`);
      return;
    }
    if (candidate.size <= 0 || candidate.size > MAX_SOURCE_BYTES) {
      setActionError(`The source limit is ${formatBytes(MAX_SOURCE_BYTES)}.`);
      return;
    }
    setActionError(null);
    try {
      await saveLocalSource(project.id, candidate);
      setLocalFile(candidate);
      setLocalSourceState('ready');
    } catch (error) {
      setActionError(`Could not keep the video on this device: ${(error as Error).message}`);
      setLocalSourceState('missing');
    }
  };

  const metadataRows: [string, string][] = [
    ['Source', project.sourceKind === 'youtube' ? 'YouTube link' : (project.sourceFileName ?? 'Upload')],
    [
      'Duration',
      project.durationMs ? formatDuration(project.durationMs) : '—',
    ],
    ['Resolution', project.width && project.height ? `${project.width}×${project.height}` : '—'],
    ['File size', project.sourceBytes ? formatBytes(project.sourceBytes) : '—'],
    ['Transcription', view.transcript?.provider ?? project.transcriptionProvider ?? 'Not run yet'],
    ['Word timing', view.transcript?.timing === 'estimated' ? 'Estimated' : view.transcript ? 'Provider' : '—'],
    ['Selection', project.selectionEngine ?? 'Not run yet'],
    ['Language', view.transcript?.language ?? project.language ?? '—'],
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-ink-700/70 bg-ink-950">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Logo compact />
            <span className="hidden h-4 w-px bg-ink-700 sm:block" />
            <Link href="/dashboard" className="hidden text-xs text-mist-400 transition-colors hover:text-white sm:block">
              ← Dashboard
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-[11px] text-mist-400 sm:flex">
              <span className={`h-1.5 w-1.5 rounded-full ${processingHere ? 'bg-emerald-400' : 'bg-mist-500'}`} />
              {processingHere ? (engineDetail ?? 'Processing in this tab') : 'Browser processor'}
            </span>
            <button type="button" className="btn-ghost text-xs" onClick={() => setDeleteOpen(true)} disabled={busy}>
              Delete
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8 sm:py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Link href="/dashboard" className="text-xs text-mist-500 transition-colors hover:text-mist-200 sm:hidden">
              ← Dashboard
            </Link>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              {project.title}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill status={project.status} />
              {project.durationMs ? <span className="chip">{formatDuration(project.durationMs)}</span> : null}
              {project.width && project.height ? (
                <span className="chip">
                  {project.width}×{project.height}
                </span>
              ) : null}
              {renderedClips.length > 0 ? (
                <span className="chip">
                  {renderedClips.length} clip{renderedClips.length === 1 ? '' : 's'} ready
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">              {!active && (project.status === 'failed' || project.status === 'completed') && (
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={openManualTranscript}
                  disabled={busy || (view.sourceMode === 'local' && localSourceState !== 'ready')}
                >
                  Upload transcript
                </button>
              )}
              {view.downloadAllUrl && (
                <a href={view.downloadAllUrl} className="btn-primary text-xs" download>
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M8 2.5v7m0 0L5 6.6M8 9.5l3-2.9M3 12.5h10" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Download all (ZIP)
              </a>
            )}
            {project.status === 'ready' && (
              <button type="button" className="btn-primary text-xs" onClick={() => void startProcessing(false)} disabled={busy}>
                Start processing
              </button>
            )}
            {(project.status === 'failed' || project.status === 'completed') && (
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => void startProcessing(true, project.status === 'completed')}
                disabled={busy}
              >
                {project.status === 'failed'
                  ? isModelFailure
                    ? 'Retry model download'
                    : 'Retry processing'
                  : 'Re-run'}
              </button>
            )}
          </div>
        </div>

        {actionError && !isModelFailure && (
          <p className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200">
            {actionError}
          </p>
        )}

        {view.sourceMode === 'local' && localSourceState !== 'ready' && (
          <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
            <p className="text-sm font-semibold text-amber-100">
              {localSourceState === 'loading' ? 'Looking for the local source…' : 'Attach the local source video'}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-amber-100/75">
              This project keeps the original video in this browser instead of uploading it to remote storage. Open it on
              the device where you selected the file, or attach the same file again. Finished clips remain
              in your account.
            </p>
            <input
              ref={localInputRef}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={(event) => void attachLocalSource(event.target.files?.[0])}
            />
            <button
              type="button"
              className="btn-secondary mt-3 text-xs"
              disabled={localSourceState === 'loading'}
              onClick={() => localInputRef.current?.click()}
            >
              Choose the original video
            </button>
          </div>
        )}

        {project.status === 'failed' && (
          <div className="mt-6 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] p-5">
            <p className="text-sm font-semibold text-rose-100">
              {isModelFailure ? 'Whisper model download failed' : 'Processing failed'}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-rose-100/80">
              {actionError ?? project.error}
            </p>
            {view.job?.lastError && view.job.lastError !== project.error && (
              <p className="mt-2 font-mono text-[11px] leading-relaxed text-rose-200/60">{view.job.lastError}</p>
            )}
            <p className="mt-3 text-xs leading-relaxed text-rose-100/50">
              {isModelFailure
                ? `The source video${project.sourceBytes ? ` (${formatBytes(project.sourceBytes)})` : ''} and any saved transcript are still in this browser. Retry downloads only the missing model files; no video upload is needed.`
                : 'Nothing was fabricated: this project has no new rendered files. Fix the cause and retry in this tab. The local source and transcript remain saved.'}
            </p>
            {isModelFailure && (
              <button
                type="button"
                className="btn-secondary mt-4 text-xs"
                disabled={busy || (view.sourceMode === 'local' && localSourceState !== 'ready')}
                onClick={() => void startProcessing(true)}
              >
                {busy ? 'Retrying…' : 'Retry model download'}
              </button>
            )}
          </div>
        )}

        {view.blocker && project.status !== 'completed' && project.status !== 'processing' && (
          <div className="mt-6 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
            <p className="text-sm font-semibold text-amber-100">Processing cannot start yet</p>
            <p className="mt-1.5 text-sm leading-relaxed text-amber-100/80">{view.blocker.message}</p>
            <p className="mt-2 text-xs text-amber-100/60">
              The local source and project data are safe. Configure the missing service, restart the server and
              worker, then hit start again.
            </p>
          </div>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.55fr_1fr]">
          <div className="space-y-6">
            {active || project.status === 'failed' ? (
              <section className="panel p-5 sm:p-6">
                <ProgressTimeline
                  stage={project.stage}
                  status={project.status}
                  progress={project.progress}
                  detail={project.statusDetail}
                />
                {(project.status === 'processing' || project.status === 'queued') && !processingHere && (
                  <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3 py-3 text-xs leading-relaxed text-amber-100/80">
                    <p>
                      This project is marked processing, but no processor is running in this tab. Browser
                      work stops when the tab closes. Resume it here — the saved source and transcript are
                      reused, so completed transcription is not repeated.
                    </p>
                    <button
                      type="button"
                      className="btn-secondary mt-2 text-xs"
                      onClick={() => void startProcessing(true)}
                      disabled={busy}
                    >
                      Resume in this browser
                    </button>
                  </div>
                )}
                {processingHere && (
                  <div className="mt-5 rounded-xl border border-ink-700/70 bg-ink-950/50 px-3 py-3">
                    {modelProgress !== null && modelProgress < 100 ? (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <span className="label">Whisper model</span>
                          <span className="font-mono text-[11px] tabular-nums text-mist-300">
                            {modelProgress}%
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
                          <div
                            className="h-full rounded-full bg-white transition-[width] duration-300"
                            style={{ width: `${Math.max(2, modelProgress)}%` }}
                          />
                        </div>
                      </>
                    ) : null}
                    <p className="mt-2 text-[11px] leading-relaxed text-mist-500">
                      {modelDetail ?? (view.transcript?.provider.startsWith('manual-')
                        ? 'Manual transcript loaded. FFmpeg.wasm is extracting audio signals and rendering in a Web Worker; Whisper is skipped.'
                        : 'FFmpeg.wasm and Whisper run in a Web Worker; this tab must stay open.')}
                    </p>
                  </div>
                )}
              </section>
            ) : null}

            {project.status === 'ready' && (
              <section className="panel p-5 sm:p-6">
                <h2 className="text-sm font-semibold text-white">Ready to clip</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-mist-400">
                  Choose automatic transcription with the local Whisper model, or upload an existing
                  SRT, VTT, or TXT transcript to skip transcription. The source stays on this device,
                  and the strongest moments are selected and rendered as 9:16 captioned clips.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    onClick={() => void startProcessing(false)}
                    disabled={busy || (view.sourceMode === 'local' && localSourceState !== 'ready')}
                  >
                    {busy ? 'Starting…' : 'Start automatic transcription'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={openManualTranscript}
                    disabled={busy || (view.sourceMode === 'local' && localSourceState !== 'ready')}
                  >
                    Upload transcript
                  </button>
                </div>
              </section>
            )}

            {renderedClips.length > 0 && (
              <section>
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Clips</h2>
                    <p className="mt-1 text-xs text-mist-500">
                      1080×1920 MP4 · edited and captioned · download individually or as a ZIP
                    </p>
                  </div>
                  {view.downloadAllUrl && (
                    <a href={view.downloadAllUrl} className="btn-secondary text-xs" download>
                      ZIP
                    </a>
                  )}
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {view.clips.map((clip) => (
                    <ClipCard
                      key={clip.id}
                      clip={clip}
                      onRerender={rerenderClip}
                      onUpdated={(updated) =>
                        setView((previous) => ({
                          ...previous,
                          clips: previous.clips.map((entry) =>
                            entry.id === updated.id ? { ...entry, ...updated } : entry,
                          ),
                        }))
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            {project.status === 'completed' && renderedClips.length === 0 && (
              <section className="panel p-6">
                <p className="text-sm text-mist-300">
                  This project reports completed but has no rendered files. Re-run it in this tab; the
                  local source and transcript will be reused.
                </p>
              </section>
            )}

            {view.transcript && (
              <section className="panel p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-white">Transcript</h2>
                    <p className="mt-1 font-mono text-[11px] text-mist-500">
                      {view.transcript.wordCount} words · {view.transcript.provider} ·{' '}
                      {view.transcript.timing === 'estimated' ? 'estimated word timing' : 'word-level timing'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {!active && (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={openManualTranscript}
                        disabled={busy || (view.sourceMode === 'local' && localSourceState !== 'ready')}
                      >
                        Replace transcript
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => setShowTranscript((value) => !value)}
                    >
                      {showTranscript ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                {showTranscript && (
                  <p className="mt-4 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl border border-ink-700 bg-ink-950 p-3 text-[13px] leading-relaxed text-mist-300">
                    {view.transcript.text}
                  </p>
                )}
              </section>
            )}
          </div>

          <aside className="space-y-4">
            <section className="panel p-5">
              <h2 className="text-sm font-semibold text-white">Project details</h2>
              <dl className="mt-4 space-y-3">
                {metadataRows.map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-4 border-b border-ink-800 pb-3 last:border-0 last:pb-0">
                    <dt className="text-xs text-mist-500">{label}</dt>
                    <dd className="max-w-[60%] break-words text-right font-mono text-[11px] text-mist-200">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="panel p-5">
              <h2 className="text-sm font-semibold text-white">Output spec</h2>
              <ul className="mt-3 space-y-2 text-xs leading-relaxed text-mist-400">
                <li>· 1080×1920 (9:16), H.264 + AAC</li>
                <li>· Word-synced captions burned in</li>
                <li>· Mobile-ready MP4 with faststart</li>
                <li>· Individual downloads and ZIP export</li>
              </ul>
              <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
                Framing follows the dominant subject with a smooth pan and falls back to a center crop when the estimate is weak. It is not face recognition or active-speaker tracking.
              </p>
              <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
                Rendering happens in this browser with FFmpeg.wasm. The tab must stay open; a cached
                quantized Whisper model is reused for later projects on this device.
              </p>
            </section>
          </aside>
        </div>
      </main>

      {manualTranscriptOpen && (
        <ManualTranscriptDialog
          durationMs={project.durationMs}
          sourceProbeState={project.durationMs ? 'ready' : sourceProbeState}
          sourceProbeError={sourceProbeError}
          renderedClipCount={renderedClips.length}
          busy={busy}
          onRetrySourceProbe={() => void ensureSourceMetadata()}
          onCancel={() => setManualTranscriptOpen(false)}
          onStart={startWithManualTranscript}
        />
      )}

      {deleteOpen && (
        <DeleteProjectDialog
          project={{ id: project.id, title: project.title }}
          onCancel={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false);
            void deleteLocalSource(project.id);
            router.push('/dashboard');
          }}
        />
      )}
    </div>
  );
}
