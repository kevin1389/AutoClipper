'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '@/lib/format';

interface FailedFile {
  path: string;
  error: string;
}

interface DeleteResponse {
  error?: string;
  failedFiles?: unknown;
  filesDeleted?: boolean;
  databaseDeleted?: boolean;
  bytesFreed?: number;
  detail?: string;
}

export function DeleteProjectDialog({
  project,
  onCancel,
  onDeleted,
}: {
  project: { id: string; title: string };
  onCancel: () => void;
  onDeleted: (result: { deletedFiles: number; bytesFreed: number }) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [failedFiles, setFailedFiles] = useState<FailedFile[]>([]);
  const [filesDeleted, setFilesDeleted] = useState(false);
  const [bytesFreed, setBytesFreed] = useState(0);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  const remove = async () => {
    setBusy(true);
    setAttempted(true);
    setError(null);
    setDetail(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'DELETE',
      });
      const data = (await response.json().catch(() => ({}))) as DeleteResponse;
      if (!response.ok) {
        const rawFiles = Array.isArray(data.failedFiles) ? data.failedFiles : [];
        setFailedFiles(
          rawFiles
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
            .map((entry) => ({
              path: String(entry.path ?? 'project files'),
              error: String(entry.error ?? 'Deletion failed.'),
            })),
        );
        setFilesDeleted(Boolean(data.filesDeleted));
        setBytesFreed(Number(data.bytesFreed) || 0);
        setDetail(typeof data.detail === 'string' ? data.detail : null);
        setError(data.error ?? `Could not delete this project (HTTP ${response.status}).`);
        setBusy(false);
        return;
      }
      await onDeleted({
        deletedFiles: Number((data as { deletedFiles?: unknown }).deletedFiles) || 0,
        bytesFreed: Number((data as { bytesFreed?: unknown }).bytesFreed) || 0,
      });
    } catch (caught) {
      setError((caught as Error).message || 'Could not reach the server. Nothing was deleted.');
      setBusy(false);
    }
  };

  const retry = attempted && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
        aria-describedby="delete-project-description"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl"
      >
        <div className="border-b border-ink-700 p-5">
          <p className="label">Permanent deletion</p>
          <h2 id="delete-project-title" className="mt-1 text-lg font-semibold text-white">
            Delete “{project.title}”?
          </h2>
        </div>

        <div className="space-y-4 p-5">
          <p id="delete-project-description" className="text-sm leading-relaxed text-mist-300">
            This permanently deletes the original uploaded video, every generated and edited clip, posters and
            thumbnails, temporary files, and this project&apos;s database records. Other projects are not touched.
            This cannot be undone.
          </p>

          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-100/80">
            Nothing is deleted automatically. The project is only removed after its files are confirmed gone.
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.07] p-3">
              <p className="text-xs font-semibold text-rose-100">{error}</p>
              {detail ? (
                <p className="mt-1 font-mono text-[11px] leading-relaxed text-rose-100/60">{detail}</p>
              ) : null}
              {filesDeleted ? (
                <p className="mt-2 text-[11px] leading-relaxed text-rose-100/70">
                  The files were removed, but the project record remains. Retry to finish deleting it.
                  {bytesFreed > 0 ? ` Confirmed freed: ${formatBytes(bytesFreed)}.` : ''}
                </p>
              ) : (
                <p className="mt-2 text-[11px] leading-relaxed text-rose-100/70">
                  The project and its database records were kept. Nothing is reported as freed until the
                  storage backend confirms it.
                </p>
              )}
              {failedFiles.length > 0 && (
                <div className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-rose-400/20 bg-black/20 p-2.5">
                  <p className="text-[11px] font-semibold text-rose-100/80">
                    {failedFiles.length} file{failedFiles.length === 1 ? '' : 's'} still need attention
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {failedFiles.map((file) => (
                      <li key={file.path} className="text-[11px] leading-relaxed text-rose-100/60">
                        <code className="break-all font-mono text-rose-100/80">{file.path}</code>
                        <span className="block">{file.error}</span>
                      </li>
                    ))}
                  </ul>
                </div>
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
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl border border-rose-400/40 bg-rose-500/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? 'Deleting…' : retry ? 'Retry deletion' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  );
}
