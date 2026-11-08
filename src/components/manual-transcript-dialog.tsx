'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatDuration } from '@/lib/format';
import {
  formatFromFilename,
  MAX_MANUAL_TRANSCRIPT_BYTES,
  MANUAL_TRANSCRIPT_ACCEPT,
  ManualTranscriptError,
  parseManualTranscript,
  type ManualTranscriptResult,
} from '@/lib/manual-transcript';
import type { Transcript } from '@/lib/types';

export function ManualTranscriptDialog({
  durationMs,
  sourceProbeState,
  sourceProbeError,
  renderedClipCount,
  busy,
  onRetrySourceProbe,
  onCancel,
  onStart,
}: {
  durationMs: number | null;
  sourceProbeState: 'idle' | 'probing' | 'ready' | 'error';
  sourceProbeError: string | null;
  renderedClipCount: number;
  busy: boolean;
  onRetrySourceProbe: () => void;
  onCancel: () => void;
  onStart: (transcript: Transcript) => void;
}) {
  const [filename, setFilename] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ManualTranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !parsing) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, parsing, onCancel]);

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    setParsed(null);
    setError(null);
    setParsing(false);
    setFilename(file.name);
    setSelectedFile(null);
    const format = formatFromFilename(file.name);
    if (!format) {
      setError('Choose a .srt, .vtt, or .txt transcript.');
      return;
    }
    if (file.size <= 0) {
      setError('That transcript file is empty.');
      return;
    }
    if (file.size > MAX_MANUAL_TRANSCRIPT_BYTES) {
      setError(`The transcript limit is ${formatBytes(MAX_MANUAL_TRANSCRIPT_BYTES)}.`);
      return;
    }
    setSelectedFile(file);
  };

  // Keep the chosen file in state and parse it as soon as the parent has a
  // verified duration. A user never has to pick the same file again just
  // because the source probe was still running.
  useEffect(() => {
    if (!selectedFile) return;
    const format = formatFromFilename(selectedFile.name);
    if (!format || !durationMs || durationMs <= 0) {
      setParsed(null);
      setParsing(false);
      return;
    }
    let cancelled = false;
    setParsing(true);
    setError(null);
    selectedFile
      .text()
      .then((text) => {
        if (cancelled) return;
        setParsed(parseManualTranscript({ text, filename: selectedFile.name, format, durationMs }));
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setParsed(null);
        setError(
          caught instanceof ManualTranscriptError
            ? caught.message
            : `Could not read that transcript: ${(caught as Error).message}`,
        );
      })
      .finally(() => {
        if (!cancelled) setParsing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [durationMs, selectedFile]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && !parsing) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-transcript-title"
        aria-describedby="manual-transcript-description"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl"
      >
        <div className="border-b border-ink-700 p-5">
          <p className="label">Manual transcript</p>
          <h2 id="manual-transcript-title" className="mt-1 text-lg font-semibold text-white">
            Skip Whisper with your own transcript
          </h2>
          <p id="manual-transcript-description" className="mt-2 text-xs leading-relaxed text-mist-400">
            Upload an SRT or VTT for cue-level timing. TXT is accepted, but without timestamps the
            video&apos;s word timing is estimated and clip accuracy may be lower.
          </p>
        </div>

        <div className="space-y-4 p-5">
          <div className="rounded-xl border border-ink-700 bg-ink-950/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-mist-200">
                  {filename ?? 'SRT, VTT, or TXT'}
                </p>
                <p className="mt-1 text-[11px] text-mist-500">
                  Up to {formatBytes(MAX_MANUAL_TRANSCRIPT_BYTES)} · timestamps are checked against{' '}
                  {durationMs
                    ? formatDuration(durationMs)
                    : sourceProbeState === 'error'
                      ? 'the video duration (unavailable)'
                      : 'the video duration (checking…)'}
                </p>
              </div>
              <input
                ref={inputRef}
                type="file"
                accept={MANUAL_TRANSCRIPT_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  chooseFile(file);
                }}
              />
              <button
                type="button"
                className="btn-secondary shrink-0 text-xs"
                onClick={() => inputRef.current?.click()}
                disabled={busy || parsing}
              >
                {parsing ? 'Reading…' : parsed ? 'Choose another file' : 'Choose transcript'}
              </button>
            </div>
          </div>

          {!durationMs && sourceProbeState !== 'error' && (
            <div
              className="rounded-xl border border-ink-700 bg-ink-950/60 p-3 text-xs leading-relaxed text-mist-300"
              role="status"
              aria-live="polite"
            >
              <p className="font-medium text-mist-200">Checking the source video…</p>
              <p className="mt-1 text-[11px] leading-relaxed text-mist-500">
                Reading its metadata so transcript timestamps can be validated. If you choose a file
                now, it will be parsed automatically when the duration is ready.
              </p>
            </div>
          )}

          {sourceProbeState === 'error' && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] p-3 text-xs leading-relaxed text-rose-100">
              <p className="font-semibold">Could not inspect the source video</p>
              <p className="mt-1 text-[11px] text-rose-100/80">
                {sourceProbeError ?? 'The video duration could not be read.'}
              </p>
              <button
                type="button"
                className="btn-secondary mt-3 text-xs"
                onClick={onRetrySourceProbe}
                disabled={busy || parsing}
              >
                Retry source check
              </button>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] p-3 text-xs leading-relaxed text-rose-100">
              {error}
            </div>
          )}

          {parsed && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip">{parsed.format.toUpperCase()}</span>
                <span className="chip">{parsed.wordCount.toLocaleString()} words</span>
                <span className="chip">{parsed.cueCount.toLocaleString()} cues</span>
                <span className="chip">
                  {formatDuration(parsed.startMs)}–{formatDuration(parsed.endMs)}
                </span>
              </div>
              {parsed.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
                  <p className="text-xs font-semibold text-amber-100">Timing warnings</p>
                  <ul className="mt-2 space-y-1.5">
                    {parsed.warnings.map((warning) => (
                      <li key={warning} className="text-[11px] leading-relaxed text-amber-100/75">
                        · {warning}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="rounded-xl border border-ink-700 bg-ink-950 p-3">
                <p className="label">First cues</p>
                <div className="mt-2 space-y-2">
                  {parsed.preview.map((cue) => (
                    <div key={`${cue.startMs}-${cue.text}`} className="text-[11px] leading-relaxed">
                      <span className="font-mono text-mist-500">
                        {formatDuration(cue.startMs)}–{formatDuration(cue.endMs)}
                      </span>
                      <span className="ml-2 text-mist-300">{cue.text}</span>
                    </div>
                  ))}
                </div>
              </div>
              {renderedClipCount > 0 && (
                <p className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-100/75">
                  Processing with this transcript replaces the {renderedClipCount} existing rendered
                  clip{renderedClipCount === 1 ? '' : 's'} with a fresh selection and render.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-ink-700 p-4 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost"
            onClick={onCancel}
            disabled={busy || parsing}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (parsed) onStart(parsed.transcript);
            }}
            disabled={!parsed || !durationMs || busy || parsing || sourceProbeState === 'error'}
          >
            {busy
              ? 'Starting…'
              : parsing
                ? 'Reading…'
                : !durationMs && sourceProbeState !== 'error'
                  ? 'Checking video…'
                  : 'Process with transcript'}
          </button>
        </div>
      </div>
    </div>
  );
}
