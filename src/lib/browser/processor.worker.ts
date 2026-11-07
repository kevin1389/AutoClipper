/// <reference lib="webworker" />
import { buildAssCaptions } from '../captions/ass';
import { buildEditPlan, DEFAULT_EDITS, type EditPlan } from '../edit/plan';
import { buildVerticalFilter } from '../media/crop';
import { planFraming, splitRawFrames } from '../media/framing';
import { selectHighlightsHeuristically } from '../ai/heuristic';
import { finalizeSelection } from '../ai/select-utils';
import type { ClipEdits, ClipEffects, ClipFraming, ClipView, PipelineStage, TimedWord } from '../types';
import { decodeWav, segmentsFromWords, signalsFromSamples, type DecodedAudio } from './audio';
import type { BrowserSignals, PosterResponse, RenderClipMessage, StartMessage, WorkerEvent, WorkerRequest } from './protocol';
import { BrowserTranscriber, ModelLoadError } from './transcribe';
import { retrySection } from './section-retry';
import { BrowserFfmpeg, isFfmpegCoreError } from './ffmpeg-core';
import { buildClipRenderArgs } from './render-command';
import { isJpeg } from '../poster';
import { progressFor } from '../stages';
import { MAX_SOURCE_BYTES } from '../upload-limits';

const SOURCE_PATH = '/source/input.mp4';
/** Audio is extracted and transcribed in bounded sections for long sources. */
const AUDIO_SEGMENT_MS = 5 * 60_000;
const AUDIO_SEGMENT_OVERLAP_MS = 2_000;
const TARGET_CLIP_COUNT = 8;
const FONT_PATH = '/fonts/DejaVuSans-Bold.ttf';
const MAX_RENDER_LOGS = 80;

interface Session {
  projectId: string;
  sourceName: string;
  signals: BrowserSignals | null;
  transcript: import('./protocol').BrowserTranscript | null;
  durationMs: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
}

interface ProcessorClip {
  id: string;
  index: number;
  title: string;
  startMs: number;
  endMs: number;
  status: 'pending' | 'rendered' | 'failed';
  edits?: ClipEdits | null;
}

let ffmpeg: BrowserFfmpeg | null = null;
let transcriber: BrowserTranscriber | null = null;
let session: Session | null = null;
let logs: string[] = [];
let cancelled = false;
let sourceBlob: Blob | File | null = null;
let lastProgress = 0;
let runStartedAt = 0;
let markAt = 0;
let currentClipNumber: number | null = null;

function mark(label: string): void {
  const now = performance.now();
  console.info(`[ac-timing] ${label} ${Math.round(now - markAt)}ms (total ${Math.round(now - runStartedAt)}ms)`);
  markAt = now;
}

function send(event: WorkerEvent) {
  self.postMessage(event);
}

interface PosterWaiter {
  resolve: (poster: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const posterWaiters = new Map<string, PosterWaiter>();

/**
 * The page owns the browser's native video decoder. FFmpeg.wasm can render a
 * clip and then trap while decoding that same MP4 for a poster, so the exact
 * rendered bytes are copied to the main thread for a canvas capture.
 */
function requestPosterFromMainThread(video: Uint8Array, clipNumber: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const copy = video.slice();
    const buffer = copy.buffer as ArrayBuffer;
    const timer = setTimeout(() => {
      posterWaiters.delete(requestId);
      reject(new Error(`The browser did not return a poster for clip ${clipNumber} within 30 seconds.`));
    }, 30_000);
    posterWaiters.set(requestId, { resolve, reject, timer });
    self.postMessage(
      { type: 'poster-request', requestId, clipNumber, video: buffer } satisfies WorkerEvent,
      [buffer],
    );
  });
}

function resolvePosterResponse(response: PosterResponse): void {
  const waiter = posterWaiters.get(response.requestId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  posterWaiters.delete(response.requestId);
  if (response.error) {
    waiter.reject(new Error(response.error));
    return;
  }
  if (!response.poster || response.poster.byteLength === 0) {
    waiter.reject(new Error('The browser returned no poster image.'));
    return;
  }
  const poster = new Uint8Array(response.poster);
  if (!isJpeg(poster)) {
    waiter.reject(new Error('The browser returned a poster that was not a JPEG.'));
    return;
  }
  waiter.resolve(poster);
}

function fail(error: unknown, fallback = 'Browser processing failed.'): never {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code: string }).code)
      : 'browser_processing_failed';
  send({ type: 'error', code, message: message.slice(0, 1500) || fallback });
  throw error instanceof Error ? error : new Error(message);
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `Request failed (HTTP ${response.status})`);
  }
  return data;
}

/**
 * Reports one stage fraction using the same weighted timeline the UI renders.
 * Callers pass 0–1 within a stage; the project always receives 0–100 overall.
 * Progress is monotonic so a late request cannot move the bar backwards.
 */
async function report(
  projectId: string,
  stage: Exclude<import('../types').PipelineStage, 'queued' | 'done'>,
  fraction: number,
  detail: string,
) {
  const bounded = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const overall = Math.max(lastProgress, progressFor(stage, bounded));
  lastProgress = overall;
  send({ type: 'progress', stage, progress: overall, detail });
  try {
    await post(`/api/projects/${projectId}/process`, {
      action: 'progress',
      stage,
      progress: overall,
      detail,
    });
  } catch {
    // Progress persistence is best-effort; a transient network failure must not
    // kill a long render. Completion/failure are still authoritative.
  }
}

function tailLogs(): string {
  return logs.slice(-6).join('\n').slice(-1200);
}

async function loadFfmpeg() {
  if (ffmpeg?.loaded) return ffmpeg;
  const instance = new BrowserFfmpeg();
  instance.on('log', ({ message }) => {
    logs.push(message);
    if (logs.length > MAX_RENDER_LOGS) logs = logs.slice(-MAX_RENDER_LOGS);
  });
  instance.onProgress(({ progress }) => {
    if (activeProgress) {
      const value = Math.max(0, Math.min(1, Number(progress) || 0));
      activeProgress(value);
    }
  });
  await instance.load();
  ffmpeg = instance;
  return instance;
}

let activeProgress: ((fraction: number) => void) | null = null;

/** Command arguments can include long filter graphs; keep errors readable. */
function summarizeArgs(args: string[]): string {
  return args
    .map((arg) => (arg.length > 180 ? `${arg.slice(0, 180)}…(${arg.length} chars)` : arg))
    .join(' ');
}

/**
 * Recreates the wasm core and remounts the original source. This is used after
 * a wasm trap and between clips, not as error suppression: if the retry fails,
 * the real command and stage are reported.
 */
async function restartWithBlob(blob: Blob, name: string): Promise<BrowserFfmpeg> {
  const previous = ffmpeg;
  previous?.dispose();
  ffmpeg = null;
  const instance = await ensureFfmpegFiles();
  await instance.mountSource(blob, name);
  return instance;
}

async function restartFfmpeg(): Promise<BrowserFfmpeg> {
  if (!sourceBlob) throw new Error('The source is not mounted, so FFmpeg cannot be restarted.');
  const instance = await restartWithBlob(sourceBlob, 'input.mp4');
  logs.push(`FFmpeg.wasm core generation ${instance.generation} mounted the source`);
  return instance;
}

async function run(args: string[], label: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const instance = await loadFfmpeg();
    try {
      const code = await instance.exec(['-hide_banner', '-loglevel', 'error', ...args]);
      if (code !== 0) {
        throw new Error(`${label} failed${tailLogs() ? `: ${tailLogs()}` : ` (FFmpeg exit ${code})`}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (isFfmpegCoreError(error) && attempt === 0) {
        logs.push(
          `${label}: FFmpeg core generation ${error.generation} trapped; restarting on a fresh core`,
        );
        await restartFfmpeg();
        continue;
      }
      break;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `${label} failed after ${isFfmpegCoreError(lastError) ? 'restarting FFmpeg.wasm' : 'one attempt'}: ${detail}. ` +
      `Command: ${summarizeArgs(args).slice(0, 500)}${tailLogs() ? `\n${tailLogs()}` : ''}`,
    { cause: lastError },
  );
}

/** A probe does not produce media, but it still needs the same core recovery. */
async function runProbe(args: string[], label: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const instance = await loadFfmpeg();
    try {
      await instance.ffprobe(['-hide_banner', '-loglevel', 'error', ...args]);
      // @ffmpeg/core 0.12.x's ffprobe entry point returns -1 even when it
      // successfully writes its report. The caller validates the report file;
      // treating this status as an exit code rejects every valid probe.
      return;
    } catch (error) {
      lastError = error;
      if (isFfmpegCoreError(error) && attempt === 0) {
        logs.push(`${label}: FFprobe core trapped; restarting on a fresh core`);
        await restartFfmpeg();
        continue;
      }
      break;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed: ${detail}`, { cause: lastError });
}

/** Reads a probe report and turns a missing/invalid report into a real error. */
async function readProbeJson(path: string, label: string): Promise<Record<string, unknown>> {
  const active = await loadFfmpeg();
  try {
    const raw = await active.readFile(path, 'utf8');
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} produced no readable JSON report: ${detail}${tailLogs() ? `\n${tailLogs()}` : ''}`,
    );
  }
}

async function fetchSourceBlob(
  url: string,
  totalHint: number | null,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not download the project source (HTTP ${response.status}).`);
  const declared = Number(response.headers.get('content-length') ?? totalHint ?? 0);
  if (declared > MAX_SOURCE_BYTES) {
    throw new Error(`This source is ${(declared / 1024 / 1024).toFixed(0)} MB; the limit is 1 GB.`);
  }
  // A Blob is browser-managed and can be disk-backed; the worker mounts it
  // with WORKERFS instead of copying it into a Uint8Array.
  onProgress(0);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('The source download was empty.');
  if (blob.size > MAX_SOURCE_BYTES) throw new Error('This source exceeds the 1 GB processing limit.');
  onProgress(1);
  return blob;
}

const volatileFiles = new Map<string, string | Uint8Array>();

async function writeVolatileFile(
  instance: BrowserFfmpeg,
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  volatileFiles.set(path, data);
  await instance.writeFile(path, data);
}

async function ensureFfmpegFiles() {
  const instance = await loadFfmpeg();
  try {
    await instance.createDir('/fonts');
  } catch {
    // already exists
  }
  const font = await fetch(`${self.location.origin}/fonts/DejaVuSans-Bold.ttf`);
  if (!font.ok) throw new Error('The caption font could not be loaded.');
  await instance.writeFile(FONT_PATH, new Uint8Array(await font.arrayBuffer()));
  // Caption ASS files are written just before a render. Restore them if a
  // wasm trap forces the retry onto a fresh core.
  for (const [path, data] of volatileFiles) {
    await instance.writeFile(path, data);
  }
  return instance;
}

async function attachSource(
  instance: BrowserFfmpeg,
  sourceFile: File | null | undefined,
  sourceUrl: string | null | undefined,
  sourceBytes: number | null,
  onProgress: (fraction: number) => void,
) {
  if (sourceFile) {
    if (sourceFile.size > MAX_SOURCE_BYTES) {
      throw new Error(`This source is ${(sourceFile.size / 1024 / 1024).toFixed(0)} MB; the limit is 1 GB.`);
    }
    await instance.mountSource(sourceFile, 'input.mp4');
    sourceBlob = sourceFile;
    onProgress(1);
    return;
  }
  if (!sourceUrl) {
    throw new Error(
      'This project has no source in this browser. Attach the original video on this device before processing.',
    );
  }
  const blob = await fetchSourceBlob(sourceUrl, sourceBytes, onProgress);
  await instance.mountSource(blob, 'input.mp4');
  sourceBlob = blob;
}

async function probe(_instance: BrowserFfmpeg) {
  await runProbe(
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      SOURCE_PATH,
      '-o',
      'probe.json',
    ],
    'Source probe',
  );
  const parsed = (await readProbeJson('probe.json', 'Source probe')) as {
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  await (await loadFfmpeg()).deleteFile('probe.json').catch(() => undefined);
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  if (!video) throw new Error('This file has no video stream.');
  const rate = (video.avg_frame_rate || video.r_frame_rate || '').split('/').map(Number);
  const fps = rate[0] && rate[1] ? Math.round((rate[0] / rate[1]) * 100) / 100 : null;
  const durationSeconds = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('The video duration could not be read.');
  }
  return {
    durationMs: Math.round(durationSeconds * 1000),
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps,
    hasAudio: Boolean(audio),
  };
}

async function extractAudioSegment(
  instance: BrowserFfmpeg,
  startMs: number,
  endMs: number,
): Promise<DecodedAudio> {
  const durationMs = Math.max(1, endMs - startMs);
  await run(
    [
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      SOURCE_PATH,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-y',
      'audio.wav',
    ],
    'Audio extraction',
  );
  const wav = await instance.readFile('audio.wav');
  if (typeof wav === 'string') throw new Error('Audio extraction returned text instead of audio.');
  try {
    return decodeWav(wav as Uint8Array);
  } finally {
    // Release the WAV before the next section. It is not kept alongside the
    // full source or the previous section's decoded samples.
    await instance.deleteFile('audio.wav').catch(() => undefined);
  }
}

/**
 * Detects hard cuts. A range keeps this cheap for long recordings: only the
 * selected clips are decoded instead of the whole source.
 */
async function detectScenes(
  instance: BrowserFfmpeg,
  range?: { startMs: number; endMs: number },
): Promise<number[]> {
  try {
    const seek = range && range.endMs > range.startMs
      ? ['-ss', (range.startMs / 1000).toFixed(3), '-t', ((range.endMs - range.startMs) / 1000).toFixed(3)]
      : [];
    await run(
      [
        ...seek,
        '-skip_frame',
        'nokey',
        '-i',
        SOURCE_PATH,
        '-an',
        '-vf',
        "scale=320:-2:flags=fast_bilinear,fps=2,select='gt(scene,0.3)',metadata=print:file=scenes.txt",
        '-fps_mode',
        'vfr',
        '-f',
        'null',
        '-',
      ],
      'Scene detection',
    );
    const text = String(await (await loadFfmpeg()).readFile('scenes.txt', 'utf8'));
    const offsetMs = range?.startMs ?? 0;
    const times = new Set<number>();
    for (const block of text.split(/\n(?=frame:)/)) {
      if (!/lavfi\.scene_score=/.test(block)) continue;
      const match = /pts_time:(-?\d+(?:\.\d+)?)/.exec(block);
      if (!match) continue;
      const seconds = Number.parseFloat(match[1]);
      if (Number.isFinite(seconds) && seconds >= 0) times.add(Math.round(seconds * 1000) + offsetMs);
    }
    return [...times].sort((a, b) => a - b);
  } catch {
    return [];
  } finally {
    if (ffmpeg?.loaded) await ffmpeg.deleteFile('scenes.txt').catch(() => undefined);
  }
}

async function analyzeClipFraming(
  instance: BrowserFfmpeg,
  width: number,
  height: number,
  startMs: number,
  endMs: number,
): Promise<ClipFraming | null> {
  if (width <= height * 1.05) return null;
  const durationMs = Math.max(1, endMs - startMs);
  const fps = durationMs >= 18_000 ? 0.25 : 0.5;
  const output = 'framing.raw';
  try {
    await run(
      [
        '-ss',
        (startMs / 1000).toFixed(3),
        '-t',
        (durationMs / 1000).toFixed(3),
        '-skip_frame',
        'nokey',
        '-i',
        SOURCE_PATH,
        '-an',
        '-vf',
        `fps=${fps},scale=96:54:flags=fast_bilinear,format=rgb24`,
        '-f',
        'rawvideo',
        '-y',
        output,
      ],
      'Framing analysis',
    );
    const active = await loadFfmpeg();
    const raw = await active.readFile(output);
    if (typeof raw === 'string' || raw.byteLength === 0) return null;
    return planFraming(splitRawFrames(new Uint8Array(raw)));
  } catch (error) {
    // Framing is an enhancement. A failed sample must never fail the render,
    // but the run wrapper has already replaced a trapped core before we get
    // here, so the next required command is never sent to corrupt state.
    logs.push(`Framing analysis skipped: ${(error as Error).message.slice(0, 240)}`);
    return null;
  } finally {
    if (ffmpeg?.loaded) await ffmpeg.deleteFile(output).catch(() => undefined);
  }
}

function hydrateSession(
  projectId: string,
  meta: Awaited<ReturnType<typeof probe>>,
  signals: BrowserSignals,
  transcript: Session['transcript'],
) {
  session = {
    projectId,
    sourceName: 'input.mp4',
    signals,
    transcript,
    ...meta,
  };
  return session;
}

function effectsFor(plan: EditPlan, edits: ClipEdits): ClipEffects {
  return {
    zoomWindows: plan.zooms,
    slowMotion: plan.slowMotion,
    removedPausesMs: plan.removedPauses.reduce((sum, pause) => sum + (pause.endMs - pause.startMs), 0),
    outputDurationMs: plan.outputDurationMs,
    captionsEdited: Boolean(edits.captionText?.trim()),
    framing: plan.framing,
  };
}

interface VerifiedClip {
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

/**
 * Verifies the exact bytes that will be uploaded. The bytes are mounted on a
 * fresh core so a prior render cannot leave a stale or corrupt decoder state
 * that makes a broken file look valid. If FFprobe traps, the volatile copy is
 * restored and the probe is retried on another fresh core.
 */
async function verifyRenderedClip(
  video: Uint8Array,
  expectedDurationMs: number,
  clipNumber: number,
): Promise<VerifiedClip> {
  const reportPath = '/verify.json';
  try {
    const instance = await restartFfmpeg();
    // The rendered file can be tens of megabytes. Copying it into MEMFS on top
    // of a decoder's frame buffers exhausted the wasm heap and caused an
    // out-of-bounds trap. Mount it through WORKERFS instead so FFprobe and the
    // optional poster frame read the bytes on demand. This replaces the
    // temporary source mount; the next clip starts with restartFfmpeg(), which
    // remounts the original source.
    await instance.mountSource(new Blob([new Uint8Array(video)], { type: 'video/mp4' }), 'verify.mp4');
    const verifyPath = '/source/verify.mp4';
    await runProbe(
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        verifyPath,
        '-o',
        reportPath,
      ],
      `Verification of clip ${clipNumber}`,
    );
    const parsed = (await readProbeJson(reportPath, `Verification of clip ${clipNumber}`)) as {
      streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        duration?: string;
      }[];
      format?: { duration?: string; size?: string };
    };
    const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio');
    const width = Number(videoStream?.width ?? 0);
    const height = Number(videoStream?.height ?? 0);
    const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
    const videoDurationMs = Math.round(Number(videoStream?.duration ?? 0) * 1000);
    if (videoStream?.codec_name !== 'h264') {
      throw new Error(`Clip ${clipNumber} did not contain an H.264 video stream.`);
    }
    if (width !== 1080 || height !== 1920) {
      throw new Error(`Clip ${clipNumber} was ${width}×${height}, not 1080×1920.`);
    }
    if (!audioStream) {
      throw new Error(`Clip ${clipNumber} had no audio stream.`);
    }
    if (!Number.isFinite(durationMs) || Math.abs(durationMs - expectedDurationMs) > 1_500) {
      throw new Error(
        `Clip ${clipNumber} duration was ${durationMs}ms; expected ${expectedDurationMs}ms.`,
      );
    }
    if (!Number.isFinite(videoDurationMs) || Math.abs(videoDurationMs - expectedDurationMs) > 1_000) {
      throw new Error(
        `Clip ${clipNumber} video track was ${videoDurationMs}ms; expected ${expectedDurationMs}ms. Facts and audio may be longer, but this MP4 would go black before the clip ends.`,
      );
    }
    return { width, height, durationMs, hasAudio: true };
  } finally {
    if (ffmpeg?.loaded) {
      await ffmpeg.deleteFile(reportPath).catch(() => undefined);
    }
  }
}

/**
 * Poster capture is required. The exact rendered bytes are sent to the page,
 * which decodes them with an HTMLVideoElement and captures a canvas JPEG. A
 * failure throws, so a clip cannot be finalized without a poster.
 */
async function generatePoster(video: Uint8Array, clipNumber: number): Promise<Uint8Array> {
  mark(`clip-${clipNumber}-poster-start`);
  const poster = await requestPosterFromMainThread(video, clipNumber);
  mark(`clip-${clipNumber}-poster`);
  return poster;
}

async function renderClip(plan: EditPlan, width: number, height: number, clipNumber: number, progress: (fraction: number) => void) {
  const instance = await loadFfmpeg();
  const output = `clip-${String(clipNumber).padStart(2, '0')}.mp4`;
  const captionFile = `/captions-${clipNumber}.ass`;
  const captions = buildAssCaptions(plan.captionWords, {
    startMs: 0,
    endMs: plan.outputDurationMs,
    highlightKeywords: true,
  });
  const hasCaptions = captions.cueCount > 0;
  if (hasCaptions) await writeVolatileFile(instance, captionFile, captions.ass);

  const args = buildClipRenderArgs({
    plan,
    sourceWidth: width,
    sourceHeight: height,
    source: SOURCE_PATH,
    output,
    captionFile: hasCaptions ? captionFile : null,
  });

  activeProgress = progress;
  try {
    await run(args, `Render of clip ${clipNumber}`);
    mark(`clip-${clipNumber}-encoded`);
    const rendered = await loadFfmpeg();
    const raw = await rendered.readFile(output);
    if (typeof raw === 'string' || raw.byteLength < 1024) throw new Error('The browser renderer produced an empty clip.');
    const video = new Uint8Array(raw);
    mark(`clip-${clipNumber}-output-read`);

    progress(0.97);
    const verified = await verifyRenderedClip(video, plan.outputDurationMs, clipNumber);
    mark(`clip-${clipNumber}-verified`);
    const poster = await generatePoster(video, clipNumber);
    progress(1);

    return {
      video,
      poster,
      hasCaptions,
      captionCount: captions.cueCount,
      verified,
    };
  } finally {
    activeProgress = null;
    volatileFiles.delete(captionFile);
    if (ffmpeg?.loaded) {
      await ffmpeg.deleteFile(output).catch(() => undefined);
      await ffmpeg.deleteFile(captionFile).catch(() => undefined);
    }
  }
}

async function uploadClip(projectId: string, clipId: string, index: number, video: Uint8Array, poster: Uint8Array, meta: {
  width: number;
  height: number;
  durationMs: number;
  captionMode: string;
  cropStrategy: string;
  edits: ClipEdits;
  effects: ClipEffects;
}) {
  mark(`clip-${index + 1}-video-upload-start`);
  const videoResponse = await fetch(`/api/clips/${clipId}/upload?asset=video`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'video/mp4', 'x-file-size': String(video.byteLength) },
    body: video as BodyInit,
  });
  if (!videoResponse.ok) {
    const data = (await videoResponse.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Clip upload failed (HTTP ${videoResponse.status}).`);
  }
  mark(`clip-${index + 1}-video-uploaded`);
  const posterResponse = await fetch(`/api/clips/${clipId}/upload?asset=poster`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'image/jpeg', 'x-file-size': String(poster.byteLength) },
    body: poster as BodyInit,
  });
  const posterData = (await posterResponse.json().catch(() => ({}))) as { error?: string; key?: string };
  if (!posterResponse.ok) {
    throw new Error(posterData.error ?? `Poster upload failed (HTTP ${posterResponse.status}).`);
  }
  mark(`clip-${index + 1}-poster-uploaded`);
  const finalized = await fetch(`/api/clips/${clipId}/finalize`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...meta,
      bytes: video.byteLength,
      posterBytes: poster.byteLength,
      hasPoster: true,
      posterKey: posterData.key ?? null,
      index,
    }),
  });
  const data = (await finalized.json().catch(() => ({}))) as { clip?: ClipView; error?: string };
  if (!finalized.ok || !data.clip) {
    throw new Error(data.error ?? `Could not save the rendered clip (HTTP ${finalized.status}).`);
  }
  mark(`clip-${index + 1}-finalized`);
  return data.clip;
}

async function finishClip(projectId: string, clip: { id: string; index: number }, edits: ClipEdits, plan: EditPlan, rendered: Awaited<ReturnType<typeof renderClip>>) {
  const effects = effectsFor(plan, edits);
  return uploadClip(projectId, clip.id, clip.index, rendered.video, rendered.poster, {
    width: rendered.verified.width,
    height: rendered.verified.height,
    durationMs: rendered.verified.durationMs,
    captionMode: rendered.hasCaptions ? `burned-in (${rendered.captionCount} cues)` : 'none',
    cropStrategy: buildVerticalFilter(
      { width: session?.width ?? 1080, height: session?.height ?? 1920 },
      { framing: plan.framing, durationMs: plan.outputDurationMs },
    ).strategy,
    edits,
    effects,
  });
}

interface AudioAnalysis {
  signals: BrowserSignals;
  transcript: import('./protocol').BrowserTranscript;
}

async function analyzeAudioSegments(
  instance: BrowserFfmpeg,
  meta: Awaited<ReturnType<typeof probe>>,
  savedTranscript: import('./protocol').BrowserTranscript | null | undefined,
  engine: 'auto' | 'wasm',
  onProgress: (progress: number, detail: string) => void,
  onModel: (detail: string, fraction: number) => void,
  onEngine: (engine: 'webgpu' | 'wasm', detail: string) => void,
): Promise<AudioAnalysis> {
  const segmentCount = Math.max(1, Math.ceil(meta.durationMs / AUDIO_SEGMENT_MS));
  const reusable =
    savedTranscript &&
    Array.isArray(savedTranscript.words) &&
    savedTranscript.words.length > 0 &&
    typeof savedTranscript.text === 'string';
  const words: TimedWord[] = [];
  const textParts: string[] = [];
  const levels: BrowserSignals['audio'] = [];
  const peaks: number[] = [];
  let language = savedTranscript?.language ?? 'en';
  let provider = savedTranscript?.provider ?? 'browser-whisper';
  let activeTranscriber: BrowserTranscriber | null = null;

  if (!reusable) {
    activeTranscriber = transcriber ?? new BrowserTranscriber();
    transcriber = activeTranscriber;
    const hooks = {
      onModelProgress: onModel,
      onEngine,
      onProgress: (fraction: number, detail: string) => onProgress(fraction, detail),
    };
    await activeTranscriber.load(hooks, engine === 'wasm');
  }

  for (let index = 0; index < segmentCount; index += 1) {
    const segmentStart = index * AUDIO_SEGMENT_MS;
    const segmentEnd = Math.min(
      meta.durationMs,
      segmentStart + AUDIO_SEGMENT_MS + (index < segmentCount - 1 ? AUDIO_SEGMENT_OVERLAP_MS : 0),
    );
    if (segmentEnd <= segmentStart) continue;
    onProgress(
      index / segmentCount,
      reusable
        ? `Measuring audio section ${index + 1} of ${segmentCount}`
        : `Transcribing audio section ${index + 1} of ${segmentCount}`,
    );
    const extractStartedAt = performance.now();
    let audio: DecodedAudio | null = await retrySection(
      () => extractAudioSegment(instance, segmentStart, segmentEnd),
      {
        label: `audio section ${index + 1}`,
        onRetry: (_attempt, error) =>
          onProgress(
            index / segmentCount,
            `Audio section ${index + 1} failed (${error.message.slice(0, 120)}); retrying once`,
          ),
      },
    );
    console.info(
      `[ac-timing] audio-section-${index + 1} extract ${Math.round(performance.now() - extractStartedAt)}ms`,
    );
    const chunkSignals = signalsFromSamples(audio, [], segmentStart);
    levels.push(...chunkSignals.audio);
    peaks.push(...chunkSignals.peaksMs);

    if (activeTranscriber) {
      const active = activeTranscriber;
      const sectionAudio = audio;
      const transcribeStartedAt = performance.now();
      const part = await retrySection(
        () =>
          active.transcribe(
            sectionAudio,
            {
              onModelProgress: onModel,
              onEngine,
              onProgress: (fraction: number, detail: string) =>
                onProgress((index + fraction) / segmentCount, detail),
            },
            segmentStart,
          ),
        {
          label: `transcription section ${index + 1}`,
          onRetry: (_attempt, error) =>
            onProgress(
              index / segmentCount,
              `Transcription section ${index + 1} failed (${error.message.slice(0, 120)}); retrying once`,
            ),
        },
      );
      console.info(
        `[ac-timing] audio-section-${index + 1} transcribe ${Math.round(performance.now() - transcribeStartedAt)}ms`,
      );
      const skipBefore = index === 0 ? -1 : segmentStart + AUDIO_SEGMENT_OVERLAP_MS - 30;
      for (const word of part.words) {
        if (word.startMs < skipBefore) continue;
        if (words.some((existing) => Math.abs(existing.startMs - word.startMs) < 40 && existing.text === word.text)) {
          continue;
        }
        words.push(word);
      }
      if (part.text.trim()) textParts.push(part.text.trim());
      language = part.language ?? language;
      provider = part.provider;
    }
    // Drop this section's PCM before extracting the next one. A full-length
    // source never has all of its decoded audio alive at once.
    audio = null;
    onProgress((index + 1) / segmentCount, `Audio section ${index + 1} of ${segmentCount} complete`);
  }

  if (reusable) {
    words.push(...savedTranscript.words);
    textParts.push(savedTranscript.text);
  }
  if (words.length === 0) {
    throw new Error('No speech was detected in this video. AutoClipper will not invent a transcript.');
  }
  words.sort((a, b) => a.startMs - b.startMs);
  const transcript: import('./protocol').BrowserTranscript = reusable
    ? savedTranscript!
    : {
        provider,
        language,
        timing: 'provider',
        text: textParts.join(' ').trim() || words.map((word) => word.text).join(' '),
        words,
        segments: segmentsFromWords(words),
      };
  peaks.sort((a, b) => a - b);
  return {
    signals: {
      audio: levels,
      peaksMs: peaks,
      sceneChangesMs: [],
      source: { audio: levels.length > 0, visual: false },
    },
    transcript,
  };
}

const EMPTY_SIGNALS: BrowserSignals = {
  audio: [],
  peaksMs: [],
  sceneChangesMs: [],
  source: { audio: false, visual: false },
};

async function runStart(message: StartMessage) {
  cancelled = false;
  const projectId = message.projectId;
  lastProgress = 0;
  runStartedAt = performance.now();
  markAt = runStartedAt;
  currentClipNumber = null;
  let currentStage: PipelineStage = 'probe';
  try {
    await report(projectId, 'probe', 0.02, 'Preparing browser processor');
    const response = await fetch(`/api/projects/${projectId}/processor`, { credentials: 'same-origin' });
    const data = (await response.json().catch(() => ({}))) as {
      sourceMode?: 'local' | 'remote' | 'none';
      sourceUrl: string | null;
      sourceBytes: number | null;
      transcript?: import('./protocol').BrowserTranscript | null;
      clips?: ProcessorClip[];
      error?: string;
    };
    if (!response.ok) throw new Error(data.error ?? `Could not load the project (HTTP ${response.status}).`);
    if (data.sourceMode === 'local' && !message.sourceFile) {
      throw new Error(
        'This source is kept in your browser. Attach the original video on this device before processing.',
      );
    }
    if (!message.sourceFile && !data.sourceUrl) {
      throw new Error(data.error ?? 'This project has no source video.');
    }
    await report(
      projectId,
      'probe',
      0.05,
      message.sourceFile ? 'Opening the local source in this tab' : 'Downloading the source into this tab',
    );
    const instance = await ensureFfmpegFiles();
    await attachSource(instance, message.sourceFile, data.sourceUrl, data.sourceBytes, (fraction) =>
      void report(projectId, 'probe', 0.05 + fraction * 0.1, `Preparing source ${Math.round(fraction * 100)}%`),
    );
    mark('source-mounted');
    await report(projectId, 'probe', 0.2, 'Reading video metadata');
    const meta = await probe(instance);
    if (!meta.hasAudio) {
      throw new Error('This video has no audio track. AutoClipper needs speech to transcribe and find highlights.');
    }
    send({ type: 'meta', ...meta });
    await report(projectId, 'probe', 1, `${meta.width}×${meta.height}, ${Math.round(meta.durationMs / 1000)}s`);
    mark('source-probed');

    const existingClips = Array.isArray(data.clips)
      ? data.clips.filter((clip) => clip && Number.isFinite(clip.startMs) && Number.isFinite(clip.endMs))
      : [];
    const reusableTranscript = Boolean(
      data.transcript && Array.isArray(data.transcript.words) && data.transcript.words.length > 0,
    );
    let transcript: import('./protocol').BrowserTranscript;
    let signals: BrowserSignals;
    let savedClips: ProcessorClip[];

    if (reusableTranscript) {
      // A retry must not re-extract 27 minutes of audio just to recreate the
      // signals. The saved transcript and the existing clip selection are the
      // durable state; resume directly at the first unfinished clip.
      transcript = data.transcript as import('./protocol').BrowserTranscript;
      signals = EMPTY_SIGNALS;
      savedClips = existingClips;
      send({ type: 'transcript', wordCount: transcript.words.length, language: transcript.language });
      await report(
        projectId,
        'transcribe',
        1,
        `Saved transcript reused (${transcript.words.length} words); no audio re-analysis needed`,
      );
      mark('transcript-reused');
    } else {
      currentStage = 'transcribe';
      await report(projectId, 'audio', 1, 'Transcribing audio in bounded sections');
      const analysis = await analyzeAudioSegments(
        instance,
        meta,
        null,
        message.engine,
        (fraction, detail) => void report(projectId, 'transcribe', fraction, detail),
        (detail, fraction) => {
          send({ type: 'model', detail, progress: Math.round(fraction * 100) });
          void report(projectId, 'transcribe', fraction * 0.05, detail);
        },
        (engine, detail) => send({ type: 'engine', engine, detail }),
      );
      transcript = analysis.transcript;
      signals = analysis.signals;
      savedClips = [];
      send({ type: 'transcript', wordCount: transcript.words.length, language: transcript.language });
      await report(projectId, 'transcribe', 1, `${transcript.words.length} words ready`);
      mark('transcribed');
      session = hydrateSession(projectId, meta, signals, transcript);
      await post(`/api/projects/${projectId}/process`, {
        action: 'transcript',
        transcript,
        meta,
        signals,
      });
    }

    if (!reusableTranscript || savedClips.length === 0) {
      currentStage = 'select';
      const selectionStartedAt = performance.now();
      await report(
        projectId,
        'select',
        0.1,
        'Scoring hooks, engagement, clarity, context, payoff, substance and pacing; ranking strongest first',
      );
      const rawSelected = selectHighlightsHeuristically({
        words: transcript.words,
        segments: transcript.segments,
        durationMs: meta.durationMs,
        targetCount: TARGET_CLIP_COUNT,
        signals: signals as never,
      });
      const selected = finalizeSelection(rawSelected, {
        durationMs: meta.durationMs,
        targetCount: TARGET_CLIP_COUNT,
      });
      if (selected.length === 0) {
        throw new Error('No highlight was long enough to make a clip. The source needs at least a few continuous seconds of speech.');
      }
      const selectionData = (await post(`/api/projects/${projectId}/process`, {
        action: 'selection',
        clips: selected,
        selectionEngine: 'browser-multi-signal-heuristic',
      })) as { clips?: ProcessorClip[] };
      savedClips = selectionData.clips ?? [];
      if (savedClips.length === 0) throw new Error('The server did not save the selected clips.');
      console.info(
        `[ac-timing] selection ${Math.round(performance.now() - selectionStartedAt)}ms`,
      );
      await report(projectId, 'select', 1, `${savedClips.length} highlights selected`);
      mark('selection-ready');
    } else {
      await report(
        projectId,
        'select',
        1,
        `${savedClips.filter((clip) => clip.status === 'rendered').length} of ${savedClips.length} clips already rendered`,
      );
    }

    send({ type: 'selection', count: savedClips.length });
    session = hydrateSession(projectId, meta, signals, transcript);
    currentStage = 'render';

    const total = savedClips.length;
    let renderedCount = savedClips.filter((clip) => clip.status === 'rendered').length;
    for (let index = 0; index < total; index += 1) {
      if (cancelled) throw new Error('Processing was cancelled.');
      const saved = savedClips[index];
      if (saved.status === 'rendered') continue;
      currentClipNumber = saved.index + 1;

      // Start every clip from a clean wasm core. A 27-minute source exercises
      // enough decoder/filter state that a single long-lived core can trap
      // midway; the extra reload costs seconds and makes the remaining clips
      // independent of earlier ones.
      await restartFfmpeg();
      mark(`clip-${currentClipNumber}-core-ready`);

      const edits: ClipEdits = {
        ...DEFAULT_EDITS,
        ...(saved.edits ?? {}),
        startMs: saved.startMs,
        endMs: saved.endMs,
      };
      let clipSignals = signals;
      if (edits.slowMotionEnabled) {
        clipSignals = {
          ...signals,
          sceneChangesMs: await detectScenes(await loadFfmpeg(), {
            startMs: saved.startMs,
            endMs: saved.endMs,
          }),
        };
      }
      await report(
        projectId,
        'render',
        index / total,
        `Framing clip ${index + 1} of ${total}`,
      );
      const framingStartedAt = performance.now();
      const framing = await analyzeClipFraming(
        await loadFfmpeg(),
        meta.width,
        meta.height,
        saved.startMs,
        saved.endMs,
      );
      console.info(
        `[ac-timing] clip-${currentClipNumber}-framing ${Math.round(performance.now() - framingStartedAt)}ms`,
      );
      const plan = buildEditPlan({
        words: transcript.words,
        startMs: saved.startMs,
        endMs: saved.endMs,
        options: edits,
        signals: clipSignals as never,
        framing,
      });
      await report(
        projectId,
        'render',
        index / total,
        `Rendering clip ${index + 1} of ${total}`,
      );
      const rendered = await renderClip(plan, meta.width, meta.height, currentClipNumber, (fraction) => {
        const encoded = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 0.9;
        void report(
          projectId,
          'render',
          (index + encoded) / total,
          `Encoding clip ${index + 1} of ${total} · ${Math.round(fraction * 100)}%`,
        );
      });
      const clip = await finishClip(projectId, saved, edits, plan, rendered);
      renderedCount += 1;
      send({ type: 'clip', clip });
      await report(
        projectId,
        'render',
        (index + 1) / total,
        `Clip ${index + 1} of ${total} stored and verified`,
      );
      mark(`clip-${currentClipNumber}-uploaded`);
    }

    if (renderedCount !== total) {
      throw new Error(
        `Only ${renderedCount} of ${total} selected clips have stored rendered files. The project was not marked complete.`,
      );
    }
    await report(projectId, 'render', 1, `All ${total} clips rendered and verified`);
    const completed = (await post(`/api/projects/${projectId}/process`, { action: 'complete' })) as {
      project?: import('../types').Project;
    };
    send({ type: 'done', project: completed.project as import('../types').Project });
    mark('complete');
  } catch (error) {
    const failureStage = error instanceof ModelLoadError ? 'transcribe' : currentStage;
    const elapsed = ((performance.now() - runStartedAt) / 1000).toFixed(1);
    const clip = currentClipNumber ? ` clip ${currentClipNumber}` : '';
    const generation = ffmpeg?.generation ?? 'none';
    const memory = ffmpeg ? ` memory=${Math.round(ffmpeg.memoryBytes / 1024 / 1024)}MB` : '';
    const message = `${(error as Error).message || String(error)} [stage=${failureStage}${clip}; elapsed=${elapsed}s; ffmpeg=${generation}${memory}]`.slice(
      0,
      1500,
    );
    try {
      await post(`/api/projects/${projectId}/process`, {
        action: 'fail',
        error: message,
        stage: failureStage,
      });
    } catch {
      // If the failure report itself cannot be stored, the error is still sent
      // to the open tab so the user is not left with a silent failure.
    }
    fail(new Error(message), 'Browser processing failed.');
  }
}

async function ensureSession(
  projectId: string,
  sourceFile: File | null | undefined,
): Promise<Session> {
  if (session?.projectId === projectId) return session;
  const response = await fetch(`/api/projects/${projectId}/processor`, { credentials: 'same-origin' });
  const data = (await response.json().catch(() => ({}))) as {
    sourceMode?: 'local' | 'remote' | 'none';
    sourceUrl: string | null;
    sourceBytes: number | null;
    transcript?: import('./protocol').BrowserTranscript | null;
    error?: string;
  };
  if (!response.ok) throw new Error(data.error ?? `Could not load the project (HTTP ${response.status}).`);
  if (data.sourceMode === 'local' && !sourceFile) {
    throw new Error('This source is kept in your browser. Attach the original video to render a clip.');
  }
  if (!sourceFile && !data.sourceUrl) throw new Error(data.error ?? 'This project has no source video.');
  const instance = await ensureFfmpegFiles();
  await attachSource(instance, sourceFile, data.sourceUrl, data.sourceBytes, () => undefined);
  const meta = await probe(instance);
  if (!meta.hasAudio) throw new Error('This video has no audio track.');
  if (data.transcript && Array.isArray(data.transcript.words) && data.transcript.words.length > 0) {
    // Editing or regenerating one clip must not re-extract the whole source.
    // The saved transcript is enough to rebuild captions/framing; scene data
    // is computed only when the user explicitly requests slow motion.
    session = hydrateSession(projectId, meta, EMPTY_SIGNALS, data.transcript);
    return session;
  }
  const analysis = await analyzeAudioSegments(
    instance,
    meta,
    null,
    'auto',
    () => undefined,
    () => undefined,
    () => undefined,
  );
  session = hydrateSession(projectId, meta, analysis.signals, analysis.transcript);
  return session;
}

async function runRenderClip(message: RenderClipMessage) {
  try {
    const active = await ensureSession(message.projectId, message.sourceFile);
    if (!active.transcript) throw new Error('The transcript for this project is missing. Re-run processing first.');
    const edits = { ...DEFAULT_EDITS, ...message.edits, startMs: message.startMs, endMs: message.endMs };
    let signals = active.signals;
    if (edits.slowMotionEnabled && signals) {
      const instance = await loadFfmpeg();
      signals = {
        ...signals,
        sceneChangesMs: await detectScenes(instance, { startMs: message.startMs, endMs: message.endMs }),
      };
    }
    await restartFfmpeg();
    const framing = await analyzeClipFraming(
      await loadFfmpeg(),
      active.width,
      active.height,
      message.startMs,
      message.endMs,
    );
    const plan = buildEditPlan({
      words: active.transcript.words,
      startMs: message.startMs,
      endMs: message.endMs,
      options: edits,
      signals: signals as never,
      framing,
    });
    const rendered = await renderClip(plan, active.width, active.height, message.index + 1, () => undefined);
    const clip = await finishClip(
      message.projectId,
      { id: message.clipId, index: message.index },
      edits,
      plan,
      rendered,
    );
    send({ type: 'render-done', clip });
  } catch (error) {
    fail(
      new Error(
        `${(error as Error).message} [stage=re-render; clip ${message.index + 1}; ffmpeg=${ffmpeg?.generation ?? 'none'}]`,
      ),
    );
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'poster-response') {
    resolvePosterResponse(message);
  } else if (message.type === 'start') {
    void runStart(message);
  } else if (message.type === 'render-clip') {
    void runRenderClip(message);
  }
};
