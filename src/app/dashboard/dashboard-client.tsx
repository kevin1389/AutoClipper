'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeleteProjectDialog } from '@/components/delete-project-dialog';
import { Logo } from '@/components/logo';
import { StatusPill } from '@/components/status-pill';
import { formatBytes, formatDuration, formatStorageBytes } from '@/lib/format';
import type { StorageUsage } from '@/lib/storage-types';
import type { PublicConfig } from '@/lib/public-config';
import { ACCEPT_ATTRIBUTE, isAllowedExtension } from '@/lib/upload-limits';
import { saveLocalSource } from '@/lib/local-source-store';
import type { Project } from '@/lib/types';

export type ProjectListItem = Project & { renderedClips: number };

interface YoutubeMetadata {
  videoId: string;
  title: string;
  watchUrl: string;
  authorName: string | null;
  thumbnailUrl: string | null;
  contentAccess: { available: boolean; provider: string; reason: string };
}

type Tab = 'upload' | 'youtube';

function humanTitleFromFile(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') || name;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error ?? `Request failed (HTTP ${response.status})`;
  } catch {
    return `Request failed (HTTP ${response.status})`;
  }
}

export function DashboardClient({
  initialProjects,
  initialConfig,
  initialStorage,
  account,
}: {
  initialProjects: ProjectListItem[];
  initialConfig: PublicConfig;
  initialStorage: StorageUsage;
  account: { label: string } | null;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectListItem[]>(initialProjects);
  const [config, setConfig] = useState<PublicConfig>(initialConfig);
  const [storage, setStorage] = useState<StorageUsage>(initialStorage);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(null);
  const [tab, setTab] = useState<Tab>('upload');

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);
  const [youtubeMeta, setYoutubeMeta] = useState<YoutubeMetadata | null>(null);
  const [youtubeAuto, setYoutubeAuto] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  const youtubeInputRef = useRef<HTMLInputElement>(null);

  const maxMb = Math.round(config.uploads.maxBytes / 1024 / 1024);
  const storagePercent =
    storage.limitBytes > 0 ? Math.min(100, Math.round((storage.usedBytes / storage.limitBytes) * 100)) : 0;
  const allProvidersVerified = storage.backend !== 'pool' || storage.targetVerified;
  const activeProjects = useMemo(
    () => projects.filter((project) => project.status === 'queued' || project.status === 'processing'),
    [projects],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      if (!response.ok) return;
      const data = (await response.json()) as {
        projects: ProjectListItem[];
        workerOnline: boolean;
        config: PublicConfig;
      };
      setProjects(data.projects);
      setConfig(data.config);
    } catch {
      // keep the last good state; the page still works offline
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    try {
      const response = await fetch('/api/storage?refresh=1', { cache: 'no-store' });
      const data = (await response.json().catch(() => ({}))) as Partial<StorageUsage> & {
        error?: string;
      };
      if (!response.ok) {
        const message = data.error ?? `Could not read storage (HTTP ${response.status}).`;
        setStorageError(message);
        setStorage((previous) => ({ ...previous, available: false, error: message }));
        return;
      }
      setStorage(data as StorageUsage);
      setStorageError(null);
    } catch (error) {
      const message = (error as Error).message || 'Could not read storage usage.';
      setStorageError(message);
      setStorage((previous) => ({ ...previous, available: false, error: message }));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshStorage()]);
  }, [refresh, refreshStorage]);

  useEffect(() => {
    if (activeProjects.length === 0) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [activeProjects.length, refresh]);

  const acceptFile = (candidate: File | null | undefined) => {
    setFormError(null);
    if (!candidate) return;
    const extension = candidate.name.includes('.') ? `.${candidate.name.split('.').pop()}` : '';
    if (!isAllowedExtension(extension)) {
      setFile(null);
      setFormError(`Unsupported file type. Use ${config.uploads.extensions.join(', ')}.`);
      return;
    }
    if (candidate.size > config.uploads.maxBytes) {
      setFile(null);
      setFormError(`That file is ${formatBytes(candidate.size)}; the limit is ${maxMb} MB.`);
      return;
    }
    if (candidate.size === 0) {
      setFile(null);
      setFormError('That file is empty.');
      return;
    }
    setFile(candidate);
    setProgress(0);
  };

  const startProject = async (request: Record<string, unknown>) => {
    if (!file || uploading) return;
    setUploading(true);
    setFormError(null);
    setProgress(0);
    setPhase('Creating project');

    try {
      const createResponse = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!createResponse.ok) throw new Error(await readError(createResponse));
      const created = (await createResponse.json()) as {
        project: Project;
        localSource?: boolean;
      };

      if (created.localSource) {
        setPhase(`Saving ${formatBytes(file.size)} on this device — no network upload`);
        setProgress(0);
        // This is the important storage boundary: the original stays in the
        // browser. Only rendered clips are uploaded to remote storage later.
        // Wait for the IndexedDB transaction to commit before navigating away.
        await saveLocalSource(created.project.id, file);
        setProgress(100);
      } else {
        throw new Error('The server did not open a local-first project. Reload and try again.');
      }

      setPhase('Ready — opening the project to process in this browser');
      router.push(`/projects/${created.project.id}`);
    } catch (error) {
      setFormError((error as Error).message);
      setUploading(false);
      setPhase(null);
    }
  };

  const startUpload = () =>
    startProject({ kind: 'upload', local: true, fileName: file?.name, size: file?.size });

  // The link supplies the metadata; the file the user is authorized to use
  // supplies the media. Both end up in the same validated upload + pipeline path.
  const startYoutubeUpload = () => {
    if (!youtubeMeta) return;
    void startProject({
      kind: 'youtube',
      local: true,
      url: youtubeMeta.watchUrl,
      fileName: file?.name,
      size: file?.size,
    });
  };

  const generateFromYoutube = async () => {
    const raw = youtubeUrl.trim();
    if (!raw || youtubeAuto.loading) return;
    setYoutubeAuto({ loading: true, error: null });
    setFormError(null);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'youtube', url: raw, auto: true }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        project?: Project;
        metadata?: YoutubeMetadata;
        error?: string;
      };

      if (response.ok && data.project) {
        router.push(`/projects/${data.project.id}`);
        return;
      }

      // A refusal keeps the metadata the server already read, so the file
      // fallback can be offered without another round trip.
      if (data.metadata) setYoutubeMeta(data.metadata);
      setYoutubeAuto({
        loading: false,
        error: data.error ?? `Could not start this project (HTTP ${response.status}).`,
      });
    } catch (error) {
      setYoutubeAuto({ loading: false, error: (error as Error).message });
    }
  };

  const checkYoutube = async () => {
    if (!youtubeUrl.trim() || youtubeLoading) return;
    setYoutubeLoading(true);
    setYoutubeError(null);
    setYoutubeMeta(null);
    try {
      const response = await fetch('/api/youtube/metadata', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: youtubeUrl.trim() }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { metadata: YoutubeMetadata };
      setYoutubeMeta(data.metadata);
    } catch (error) {
      setYoutubeError((error as Error).message);
    } finally {
      setYoutubeLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-ink-700/70 bg-ink-950">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
          <Logo />
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 text-xs text-mist-400 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              In-browser processing
            </span>
            {account ? (
              <form method="post" action="/api/auth/sign-out" className="flex items-center gap-2">
                <span className="hidden max-w-[14rem] truncate text-xs text-mist-300 sm:inline">
                  {account.label}
                </span>
                <button type="submit" className="btn-ghost text-xs">
                  Sign out
                </button>
              </form>
            ) : null}
            <Link href="/" className="btn-ghost text-xs">
              Home
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8 sm:py-12">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Dashboard</h1>
          <p className="mt-2 text-sm leading-relaxed text-mist-400">
            Start a new clipping project or pick up where you left off. Transcription and rendering run
            in your browser, so no processing server or paid API is involved.
          </p>
        </div>

        {config.blocker && (
          <div className="mt-6 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
            <p className="text-sm font-semibold text-amber-100">Configuration required</p>
            <p className="mt-1.5 text-sm leading-relaxed text-amber-100/80">{config.blocker.message}</p>
            <p className="mt-2 text-xs leading-relaxed text-amber-100/60">
              Uploads still work. The browser processor downloads a small quantized Whisper model once
              and caches it on this device; no API key or paid service is used.
            </p>
          </div>
        )}

        {/* New project */}
        <section className="panel mt-8 overflow-hidden">
          <div className="flex items-center gap-1 border-b border-ink-700 p-2">
            {(
              [
                ['upload', 'Upload a video'],
                ['youtube', 'YouTube URL'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
                  tab === value ? 'bg-ink-750 text-white' : 'text-mist-400 hover:text-mist-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'upload' ? (
            <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[1.2fr_0.8fr]">
              <div>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => inputRef.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    acceptFile(event.dataTransfer.files?.[0]);
                  }}
                  className={`flex min-h-[190px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-8 text-center transition-colors ${
                    dragging
                      ? 'border-white/50 bg-white/[0.04]'
                      : 'border-ink-600 bg-ink-950/60 hover:border-ink-500'
                  }`}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border border-ink-600 bg-ink-850">
                    <svg viewBox="0 0 16 16" className="h-4 w-4 text-mist-300" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <path d="M8 10.5V3m0 0L5.2 5.8M8 3l2.8 2.8M3 11.5v1h10v-1" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">
                      {file ? file.name : 'Drop a video here, or click to browse'}
                    </p>
                    <p className="mt-1 text-xs text-mist-500">
                      {file
                        ? `${formatBytes(file.size)} · kept on this device`
                        : `${config.uploads.extensions.join(', ')} · up to 1 GB · the original stays on this device`}
                    </p>
                  </div>
                  <input
                    ref={inputRef}
                    type="file"
                    accept={ACCEPT_ATTRIBUTE}
                    className="hidden"
                    onChange={(event) => acceptFile(event.target.files?.[0])}
                  />
                </div>

                {formError && (
                  <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200">
                    {formError}
                  </p>
                )}

                {uploading && (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between text-xs text-mist-400">
                      <span>{phase ?? 'Preparing'}</span>
                      <span className="font-mono tabular-nums">{progress}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                      <div
                        className="h-full rounded-full bg-white transition-[width] duration-300"
                        style={{ width: `${Math.max(2, progress)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-col justify-between gap-4 rounded-2xl border border-ink-700/60 bg-ink-850/60 p-4">
                <div>
                  <p className="label">What happens next</p>
                  <ul className="mt-3 space-y-2 text-xs leading-relaxed text-mist-400">
                    <li>1. The original stays in this browser; it is not uploaded to remote storage.</li>
                    <li>2. The browser mounts the local file and transcribes it in 5-minute sections.</li>
                    <li>3. The browser scores the transcript; FFmpeg.wasm renders the 9:16 clips.</li>
                    <li>4. Finished MP4s upload to the configured object storage and can be downloaded or ZIPPED.</li>
                  </ul>
                </div>
                <div className="space-y-2">
                  <button
                    type="button"
                    className="btn-primary w-full"
                    disabled={!file || uploading}
                    onClick={() => void startUpload()}
                  >
                    {uploading ? 'Preparing…' : 'Open project and process'}
                  </button>
                  <p className="text-center text-[11px] leading-relaxed text-mist-500">
                    The original stays on this device. Processing starts automatically when the project
                    opens in this browser tab.
                  </p>
                  {file && !uploading && (
                    <button
                      type="button"
                      className="btn-ghost w-full text-xs"
                      onClick={() => {
                        setFile(null);
                        setProgress(0);
                        if (inputRef.current) inputRef.current.value = '';
                      }}
                    >
                      Choose a different file
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[1.2fr_0.8fr]">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="youtube-url" className="label">
                    Step 1 · YouTube video URL
                  </label>
                  <span className="chip border-ink-600 bg-ink-850 text-mist-300">
                    {config.youtube.autoAccess.available
                      ? 'Automatic access configured'
                      : 'Link + an authorized file'}
                  </span>
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    id="youtube-url"
                    className="input font-mono text-[13px]"
                    placeholder="https://www.youtube.com/watch?v=…"
                    value={youtubeUrl}
                    onChange={(event) => setYoutubeUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void checkYoutube();
                    }}
                  />
                  <button
                    type="button"
                    className="btn-secondary shrink-0"
                    disabled={!youtubeUrl.trim() || youtubeLoading}
                    onClick={() => void checkYoutube()}
                  >
                    {youtubeLoading ? 'Checking…' : 'Check link'}
                  </button>
                </div>
                <button
                  type="button"
                  className="btn-primary mt-2 w-full"
                  disabled={!youtubeUrl.trim() || youtubeAuto.loading || uploading}
                  onClick={() => void generateFromYoutube()}
                >
                  {youtubeAuto.loading ? 'Retrieving the video…' : 'Generate clips'}
                </button>
                <p className="field-hint mt-2">
                  {config.youtube.autoAccess.available                      ? 'One step: the authorized provider supplies the video, then your browser transcribes and renders the clips.'
                    : 'One step works once an authorized provider is configured. Otherwise check the link, then attach the video you own or have permission to use.'}
                </p>

                {youtubeAuto.error && (
                  <div className="mt-3 rounded-xl border border-ink-600 bg-ink-850 p-3">
                    <p className="text-xs font-semibold text-white">
                      Automatic access is not available for this link
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-mist-400">{youtubeAuto.error}</p>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-mist-500">
                      YouTube returns no video file to applications and AutoClipper will not use an extractor, so the
                      source comes from you or from an authorized provider the operator has provisioned.
                    </p>
                  </div>
                )}

                {youtubeError && (
                  <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-200">
                    {youtubeError}
                  </p>
                )}

                {youtubeMeta && (
                  <div className="mt-4 space-y-3 rounded-2xl border border-ink-700 bg-ink-850 p-3">
                    <div className="flex gap-3">
                      {youtubeMeta.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={youtubeMeta.thumbnailUrl}
                          alt=""
                          className="h-16 w-28 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="h-16 w-28 shrink-0 rounded-lg bg-ink-700" />
                      )}
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-sm font-medium text-white">{youtubeMeta.title}</p>
                        <p className="mt-1 text-xs text-mist-400">
                          {youtubeMeta.authorName ?? 'Unknown channel'} ·{' '}
                          <span className="font-mono">{youtubeMeta.videoId}</span>
                        </p>
                      </div>
                    </div>
                    <p className="text-[11px] leading-relaxed text-mist-500">
                      Step 1 done: the title, channel and thumbnail came from the link. The video file
                      itself has to come from you, and nothing has been queued yet.
                    </p>
                    <div className="rounded-xl border border-ink-600 bg-ink-900 p-3">
                      <p className="text-xs font-semibold text-white">
                        The video file is not something the server can fetch
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-mist-400">
                        {youtubeMeta.contentAccess.reason}
                      </p>

                      <div className="mt-3 space-y-2">
                        <input
                          ref={youtubeInputRef}
                          type="file"
                          accept={ACCEPT_ATTRIBUTE}
                          className="hidden"
                          onChange={(event) => acceptFile(event.target.files?.[0])}
                        />
                        <button
                          type="button"
                          className="btn-secondary w-full text-xs"
                          disabled={uploading}
                          onClick={() => youtubeInputRef.current?.click()}
                        >
                          {file
                            ? `${file.name} · ${formatBytes(file.size)}`
                            : 'Step 2 · Choose the video file you are authorized to use'}
                        </button>
                        <button
                          type="button"
                          className="btn-primary w-full text-xs"
                          disabled={!file || uploading}
                          onClick={() => void startYoutubeUpload()}
                        >
                          {uploading ? 'Preparing…' : 'Use this file and generate clips'}
                        </button>
                        <p className="text-[11px] leading-relaxed text-mist-500">
                          Your own upload: YouTube Studio → Content → the video → Download gives you an
                          MP4. Someone else’s video: you need prior written permission from the rights
                          holder. The link stays attached to the project either way.
                        </p>
                        {formError && (
                          <p className="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-2.5 py-1.5 text-[11px] text-rose-200">
                            {formError}
                          </p>
                        )}
                        {uploading && (
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-[11px] text-mist-400">
                              <span>{phase ?? 'Preparing'}</span>
                              <span className="font-mono tabular-nums">{progress}%</span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                              <div
                                className="h-full rounded-full bg-white transition-[width] duration-300"
                                style={{ width: `${Math.max(2, progress)}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-ink-700/60 bg-ink-850/60 p-4">
                <p className="label">Why not direct download?</p>
                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-mist-400">
                  <li>
                    <span className="text-mist-200">The API returns no file.</span> YouTube Data API v3
                    exposes metadata, upload operations and player embeds; there is no download endpoint,
                    so a link can give this server the title and channel but never the bytes.
                  </li>
                  <li>
                    <span className="text-mist-200">Downloading needs permission.</span> YouTube’s Terms
                    of Service allow access and copying only as expressly authorized, so pasting a URL
                    is not authorization — not even for a public or Creative Commons video.
                  </li>
                  <li>
                    <span className="text-mist-200">Extractors are not an option.</span> yt-dlp-style tools
                    reverse-engineer the player and bypass those restrictions, so AutoClipper does not
                    use them and will not be pointed at one.
                  </li>
                  <li>
                    <span className="text-mist-200">So the file comes from you.</span> Attach the copy you
                    are entitled to have and the same transcription, selection and 9:16 render pipeline
                    runs — the YouTube link stays recorded on the project.
                  </li>
                </ul>
                <p className="mt-3 text-xs leading-relaxed text-mist-500">
                  Supported shapes: youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…,
                  /embed/…, /live/…
                </p>
              </div>
            </div>
          )}
        </section>

        <section className="panel mt-8 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">Storage</h2>
                <span className="chip border-ink-600 bg-ink-850 text-mist-300">
                  {storage.backend === 'pool'
                    ? 'Provider pool · actual'
                    : storage.backend === 'r2'
                      ? 'R2 · actual'
                      : 'Local · actual'}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-mist-500">
                Actual object bytes from each reachable provider, with the application reserve kept below the
                free-tier limit. A failed measurement is shown as unavailable, never as zero.
              </p>
            </div>
            <button type="button" className="btn-ghost text-xs" onClick={() => void refreshAll()}>
              Refresh storage
            </button>
          </div>

          {storage.available ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-xl border border-ink-700/70 bg-ink-950/50 p-3">
                <p className="label">Verified capacity</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-white">
                  {formatStorageBytes(storage.verifiedCapacityBytes)}
                </p>
              </div>
              <div className="rounded-xl border border-ink-700/70 bg-ink-950/50 p-3">
                <p className="label">Used</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-white">
                  {allProvidersVerified ? formatStorageBytes(storage.usedBytes) : 'Partial'}
                </p>
              </div>
              <div className="rounded-xl border border-ink-700/70 bg-ink-950/50 p-3">
                <p className="label">Reserved</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-white">
                  {formatStorageBytes(storage.reservedBytes)}
                </p>
                <p className="mt-1 text-[10px] text-mist-500">
                  {storage.pendingUploads} pending upload{storage.pendingUploads === 1 ? '' : 's'}
                </p>
              </div>
              <div className="rounded-xl border border-ink-700/70 bg-ink-950/50 p-3">
                <p className="label">Available</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-white">
                  {allProvidersVerified ? formatStorageBytes(storage.availableBytes) : 'Partial'}
                </p>
              </div>
              <div className="rounded-xl border border-ink-700/70 bg-ink-950/50 p-3">
                <p className="label">Application target</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-white">
                  {formatStorageBytes(storage.limitBytes)}
                </p>
                <p className="mt-1 text-[10px] text-mist-500">
                  {storage.targetVerified ? 'verified for all providers' : 'configured, not fully verified'}
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-100/80">
              {storage.backend === 'pool'
                ? 'No configured provider could be measured. Provider cards below show the real failure; no zero usage is being invented.'
                : `Storage usage could not be read: ${storage.error ?? 'the storage listing failed.'} No deletion was attempted.`}
            </p>
          )}

          {storage.available ? (
            <>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-white/80 transition-[width] duration-500"
                  style={{ width: `${Math.max(storage.usedBytes > 0 ? 2 : 0, storagePercent)}%` }}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mist-500">
                <span>{formatStorageBytes(storage.sourceBytes)} source copies</span>
                <span>{formatStorageBytes(storage.clipBytes)} clips and posters</span>
                <span>{storage.fileCount} tracked file{storage.fileCount === 1 ? '' : 's'}</span>
                <span>
                  Last successful measurement:{' '}
                  {storage.lastSuccessfulMeasurement
                    ? `${storage.lastSuccessfulMeasurement.slice(0, 16).replace('T', ' ')} UTC`
                    : 'not available'}
                </span>
              </div>
            </>
          ) : null}

          {storage.backend === 'pool' && (storage.pendingUploads > 0 || storage.reservedBytes > 0) ? (
            <p className="mt-3 rounded-xl border border-ink-700/60 bg-ink-950/40 px-3 py-2 text-[11px] leading-relaxed text-mist-400">
              {storage.pendingUploads} pending upload{storage.pendingUploads === 1 ? '' : 's'} currently reserve{' '}
              {formatStorageBytes(storage.reservedBytes)}. Pending parts and multipart sessions count against the
              same provider and aggregate caps as completed objects.
            </p>
          ) : null}

          {storage.providers.length > 0 ? (
            <div className="mt-5 grid gap-3 lg:grid-cols-3">
              {storage.providers.map((provider) => {
                const percent =
                  provider.usedBytes !== null && provider.safeLimitBytes > 0
                    ? Math.min(100, Math.round((provider.usedBytes / provider.safeLimitBytes) * 100))
                    : 0;
                return (
                  <div key={provider.id} className="rounded-xl border border-ink-700/70 bg-ink-950/50 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-white">{provider.label}</p>
                        <p className="mt-0.5 text-[10px] uppercase tracking-wide text-mist-500">
                          {provider.role === 'hot' ? 'Hot clips' : provider.role === 'overflow' ? 'Overflow' : 'Cold / overflow'}
                        </p>
                      </div>
                      <span
                        className={`chip ${
                          provider.verified
                            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                            : 'border-amber-400/30 bg-amber-400/10 text-amber-200'
                        }`}
                      >
                        {!provider.configured ? 'Not configured' : provider.verified ? 'Connected' : 'Unavailable'}
                      </span>
                    </div>
                    <div className="mt-4 flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums">
                      <span className="text-white">
                        {provider.usedBytes === null ? 'Usage unavailable' : formatStorageBytes(provider.usedBytes)}
                      </span>
                      <span className="text-mist-500">of {formatStorageBytes(provider.safeLimitBytes)}</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-mist-500">
                      AutoClipper objects {formatStorageBytes(provider.appBytes)}
                      {provider.externalBytes !== null
                        ? ` · ${formatStorageBytes(provider.externalBytes)} other bucket usage`
                        : ''}
                    </p>
                    <p className="mt-1 text-[10px] leading-relaxed text-mist-500">
                      Reserved {formatStorageBytes(provider.reservedBytes)} across {provider.pendingUploads} pending upload
                      {provider.pendingUploads === 1 ? '' : 's'}.
                      {provider.availableBytes !== null
                        ? ` ${formatStorageBytes(provider.availableBytes)} allocatable.`
                        : ''}
                    </p>
                    {provider.usedBytes !== null ? (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
                        <div
                          className="h-full rounded-full bg-white/70"
                          style={{ width: `${Math.max(provider.usedBytes > 0 ? 2 : 0, percent)}%` }}
                        />
                      </div>
                    ) : null}
                    <p className="mt-2 text-[10px] leading-relaxed text-mist-500">
                      {provider.configured
                        ? `${formatStorageBytes(provider.reserveBytes)} reserve kept below the ${formatStorageBytes(provider.limitBytes)} allowance. Last successful measurement: ${provider.measuredAt ? `${provider.measuredAt.slice(0, 16).replace('T', ' ')} UTC` : 'never'}.`
                        : `Not configured. Add server-side secrets ${provider.id === 'b2' ? 'AC_B2' : provider.id === 'tigris' ? 'AC_TIGRIS' : 'AC_FILEBASE'}_ACCESS_KEY_ID, _SECRET_ACCESS_KEY, _BUCKET and (if needed) _ENDPOINT/_REGION. Never use NEXT_PUBLIC_* variables or client code. The 18 GB target is not available until all three providers verify.`}
                    </p>
                    {provider.error ? (
                      <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-2 py-1.5 text-[10px] leading-relaxed text-amber-100/75">
                        {provider.error}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-[11px] leading-relaxed text-mist-500">
              No multi-provider pool is active. The existing {storage.backend === 'r2' ? 'R2' : 'local'} storage remains in use.
            </p>
          )}

          {storage.failedUploads > 0 || storage.failedDeletions > 0 ? (
            <p className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-100/80">
              {storage.failedUploads} failed upload{storage.failedUploads === 1 ? '' : 's'} and{' '}
              {storage.failedDeletions} failed deletion{storage.failedDeletions === 1 ? '' : 's'} are tracked. Retrying the same
              upload or project deletion is safe and does not create a second attached object.
            </p>
          ) : null}
          {storage.error ? (
            <p className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-100/80">
              {storage.error}
            </p>
          ) : null}
          {storageError ? (
            <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-200">
              {storageError}
            </p>
          ) : null}
          <p className="mt-2 text-[11px] leading-relaxed text-mist-500">
            {storage.backend === 'pool'
              ? 'Provider bytes come from each bucket’s actual object listing. Failed uploads and deletions remain in the ledger for retry.'
              : 'Measured from actual R2 object metadata or local project files. The managed R2 allowance is shared with the deployment’s framework cache.'}
            {storage.backend === 'pool'
              ? ' S3 listings cover the dedicated bucket; they cannot expose the provider’s account-wide billable usage across other buckets or services.'
              : ''}
          </p>
        </section>

        {/* Projects */}
        <section className="mt-10">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">Projects</h2>
              <p className="mt-1 text-xs text-mist-500">
                {projects.length === 0
                  ? 'No projects yet'
                  : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <button type="button" className="btn-ghost text-xs" onClick={() => void refreshAll()}>
              Refresh
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="panel mt-4 flex flex-col items-center gap-2 px-6 py-14 text-center">
              <p className="text-sm font-medium text-mist-200">Your first project starts above</p>                <p className="max-w-sm text-xs leading-relaxed text-mist-500">
                Choose a video and AutoClipper will transcribe it, find the highlights and render the
                clips in your browser. The original stays on your device; projects stay in your account.
              </p>
            </div>
          ) : (
            <ul className="mt-4 space-y-2.5">
              {projects.map((project) => {
                const active = project.status === 'queued' || project.status === 'processing';
                return (
                  <li
                    key={project.id}
                    className="panel flex flex-col gap-3 p-4 transition-colors hover:border-ink-600 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <Link href={`/projects/${project.id}`} className="min-w-0 flex-1">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-white">{project.title}</p>
                          <StatusPill status={project.status} />
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-mist-500">
                          <span>{project.sourceKind === 'youtube' ? 'YouTube' : 'Upload'}</span>
                          {project.durationMs ? (
                            <>
                              <span className="text-ink-600">·</span>
                              <span>{formatDuration(project.durationMs)}</span>
                            </>
                          ) : null}
                          {project.sourceBytes ? (
                            <>
                              <span className="text-ink-600">·</span>
                              <span>{formatBytes(project.sourceBytes)}</span>
                            </>
                          ) : null}
                          <span className="text-ink-600">·</span>
                          <span>{new Date(project.createdAt).toLocaleString()}</span>
                        </div>
                        {active && (
                          <div className="mt-2.5 max-w-md">
                            <div className="h-1 overflow-hidden rounded-full bg-ink-700">
                              <div
                                className="h-full rounded-full bg-white/80 transition-[width] duration-700"
                                style={{ width: `${Math.max(2, project.progress)}%` }}
                              />
                            </div>
                            <p className="mt-1 text-[11px] text-mist-500">
                              {project.statusDetail ?? 'Working'} · {project.progress}%
                            </p>
                          </div>
                        )}
                        {project.status === 'failed' && project.error && (
                          <p className="mt-2 line-clamp-1 text-[11px] text-rose-300/80">{project.error}</p>
                        )}
                      </div>
                    </Link>
                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                      {project.status === 'completed' && (
                        <span className="font-mono text-[11px] text-mist-400">
                          {project.renderedClips} clip{project.renderedClips === 1 ? '' : 's'}
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn-ghost px-2.5 py-1.5 text-[11px] text-rose-200/70 hover:text-rose-100"
                        onClick={() => setDeleteTarget(project)}
                        aria-label={`Delete ${project.title}`}
                        title={`Delete ${project.title}`}
                      >
                        Delete
                      </button>
                      <Link
                        href={`/projects/${project.id}`}
                        aria-label={`Open ${project.title}`}
                        className="rounded-lg p-1.5 text-mist-500 transition-colors hover:bg-ink-800 hover:text-mist-200"
                      >
                        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <path d="M6 3.5L10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="mt-6 text-xs leading-relaxed text-mist-500">
          Processing uses FFmpeg.wasm and a quantized Whisper model in this tab. The model downloads
          once and is cached by the browser; a ready project processes automatically when opened,
          closing the tab pauses work, and the project page can resume it. No separate processing
          server is required.
        </p>
      </main>

      {deleteTarget ? (
        <DeleteProjectDialog
          project={{ id: deleteTarget.id, title: deleteTarget.title }}
          onCancel={() => setDeleteTarget(null)}
          onDeleted={async () => {
            const deletedId = deleteTarget.id;
            setDeleteTarget(null);
            setProjects((previous) => previous.filter((project) => project.id !== deletedId));
            await Promise.all([refresh(), refreshStorage()]);
          }}
        />
      ) : null}
    </div>
  );
}
