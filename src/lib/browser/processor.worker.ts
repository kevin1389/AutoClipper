/// <reference lib="webworker" />
import { buildAssCaptions } from '../captions/ass';
import { buildEditPlan, DEFAULT_EDITS, type EditPlan } from '../edit/plan';
import { buildVerticalFilter } from '../media/crop';
import { planFraming, splitRawFrames } from '../media/framing';
import { selectHighlightsHeuristically } from '../ai/heuristic';
import { finalizeSelection } from '../ai/select-utils';
import type { ClipEdits, ClipEffects, ClipFraming, ClipView, PipelineStage, TimedWord } from '../types';
import { decodeWav, segmentsFromWords, signalsFromSamples, type DecodedAudio } from './audio';
import type { BrowserSignals, RenderClipMessage, StartMessage, WorkerEvent, WorkerRequest } from './protocol';
import { BrowserTranscriber, ModelLoadError } from './transcribe';
import { retrySection } from './section-retry';
import { BrowserFfmpeg } from './ffmpeg-core';
import { buildClipRenderArgs } from './render-command';
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

let ffmpeg: BrowserFfmpeg | null = null;
let transcriber: BrowserTranscriber | null = null;
let session: Session | null = null;
let logs: string[] = [];
let cancelled = false;

function send(event: WorkerEvent) {
  self.postMessage(event);
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

async function report(projectId: string, stage: import('../types').PipelineStage, progress: number, detail: string) {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  send({ type: 'progress', stage: stage as never, progress: clamped, detail });
  try {
    await post(`/api/projects/${projectId}/process`, {
      action: 'progress',
      stage,
      progress: clamped,
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
  send({ type: 'progress', stage: 'probe', progress: 1, detail: 'Loading FFmpeg.wasm' });
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

async function run(args: string[], label: string): Promise<void> {
  if (!ffmpeg) throw new Error('FFmpeg is not loaded.');
  const code = await ffmpeg.exec(['-hide_banner', '-loglevel', 'error', ...args]);
  if (code !== 0) {
    throw new Error(`${label} failed${tailLogs() ? `: ${tailLogs()}` : ` (FFmpeg exit ${code})`}`);
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
}

async function probe(instance: BrowserFfmpeg) {
  await instance.ffprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    SOURCE_PATH,
    '-o',
    'probe.json',
  ]);
  const raw = await instance.readFile('probe.json', 'utf8');
  const parsed = JSON.parse(String(raw)) as {
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  await instance.deleteFile('probe.json').catch(() => undefined);
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
        '-i',
        SOURCE_PATH,
        '-an',
        '-vf',
        "select='gt(scene,0.3)',metadata=print:file=scenes.txt",
        '-fps_mode',
        'vfr',
        '-f',
        'null',
        '-',
      ],
      'Scene detection',
    );
    const text = String(await instance.readFile('scenes.txt', 'utf8'));
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
    await instance.deleteFile('scenes.txt').catch(() => undefined);
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
    const raw = await instance.readFile(output);
    if (typeof raw === 'string' || raw.byteLength === 0) return null;
    return planFraming(splitRawFrames(new Uint8Array(raw)));
  } catch {
    // Framing is an enhancement. A failed sample must never fail the render.
    return null;
  } finally {
    await instance.deleteFile(output).catch(() => undefined);
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

async function renderClip(plan: EditPlan, width: number, height: number, clipNumber: number, progress: (fraction: number) => void) {
  const instance = await loadFfmpeg();
  const output = `clip-${String(clipNumber).padStart(2, '0')}.mp4`;
  const captionFile = `captions-${clipNumber}.ass`;
  const captions = buildAssCaptions(plan.captionWords, {
    startMs: 0,
    endMs: plan.outputDurationMs,
    highlightKeywords: true,
  });
  const hasCaptions = captions.cueCount > 0;
  if (hasCaptions) await instance.writeFile(captionFile, captions.ass);

  const args = buildClipRenderArgs({
    plan,
    sourceWidth: width,
    sourceHeight: height,
    source: SOURCE_PATH,
    output,
    captionFile: hasCaptions ? `/${captionFile}` : null,
  });

  activeProgress = progress;
  try {
    await run(args, `Render of clip ${clipNumber}`);
    const raw = await instance.readFile(output);
    if (typeof raw === 'string' || raw.byteLength < 1024) throw new Error('The browser renderer produced an empty clip.');
    const video = new Uint8Array(raw);

    await run(['-ss', '1', '-i', output, '-frames:v', '1', '-q:v', '4', '-y', `poster-${clipNumber}.jpg`], 'Poster render');
    const posterRaw = await instance.readFile(`poster-${clipNumber}.jpg`);
    const poster = typeof posterRaw === 'string' ? null : new Uint8Array(posterRaw);

    await instance.deleteFile(output);
    await instance.deleteFile(`poster-${clipNumber}.jpg`).catch(() => undefined);
    await instance.deleteFile(captionFile).catch(() => undefined);

    return { video, poster, hasCaptions, captionCount: captions.cueCount };
  } finally {
    activeProgress = null;
  }
}

async function uploadClip(projectId: string, clipId: string, index: number, video: Uint8Array, poster: Uint8Array | null, meta: {
  width: number;
  height: number;
  durationMs: number;
  captionMode: string;
  cropStrategy: string;
  edits: ClipEdits;
  effects: ClipEffects;
}) {
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
  if (poster) {
    const posterResponse = await fetch(`/api/clips/${clipId}/upload?asset=poster`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'image/jpeg', 'x-file-size': String(poster.byteLength) },
      body: poster as BodyInit,
    });
    if (!posterResponse.ok) {
      const data = (await posterResponse.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `Poster upload failed (HTTP ${posterResponse.status}).`);
    }
  }
  const finalized = await fetch(`/api/clips/${clipId}/finalize`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...meta,
      bytes: video.byteLength,
      posterBytes: poster?.byteLength ?? null,
      hasPoster: Boolean(poster),
      index,
    }),
  });
  const data = (await finalized.json().catch(() => ({}))) as { clip?: ClipView; error?: string };
  if (!finalized.ok || !data.clip) {
    throw new Error(data.error ?? `Could not save the rendered clip (HTTP ${finalized.status}).`);
  }
  return data.clip;
}

async function finishClip(projectId: string, clip: { id: string; index: number }, edits: ClipEdits, plan: EditPlan, rendered: Awaited<ReturnType<typeof renderClip>>) {
  const effects = effectsFor(plan, edits);
  return uploadClip(projectId, clip.id, clip.index, rendered.video, rendered.poster, {
    width: 1080,
    height: 1920,
    durationMs: plan.outputDurationMs,
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
    const chunkSignals = signalsFromSamples(audio, [], segmentStart);
    levels.push(...chunkSignals.audio);
    peaks.push(...chunkSignals.peaksMs);

    if (activeTranscriber) {
      const active = activeTranscriber;
      const sectionAudio = audio;
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

async function runStart(message: StartMessage) {
  cancelled = false;
  const projectId = message.projectId;
  let currentStage: PipelineStage = 'probe';
  try {
    send({ type: 'progress', stage: 'probe', progress: 1, detail: 'Preparing browser processor' });
    const data = (await (await fetch(`/api/projects/${projectId}/processor`, { credentials: 'same-origin' })).json()) as {
      sourceMode?: 'local' | 'remote' | 'none';
      sourceUrl: string | null;
      sourceBytes: number | null;
      transcript?: import('./protocol').BrowserTranscript | null;
      error?: string;
    };
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
      2,
      message.sourceFile ? 'Opening the local source in this tab' : 'Downloading the source into this tab',
    );
    const instance = await ensureFfmpegFiles();
    await attachSource(instance, message.sourceFile, data.sourceUrl, data.sourceBytes, (fraction) =>
      void report(projectId, 'probe', 2 + fraction * 8, `Preparing source ${Math.round(fraction * 100)}%`),
    );
    await report(projectId, 'probe', 15, 'Reading video metadata');
    const meta = await probe(instance);
    if (!meta.hasAudio) {
      throw new Error('This video has no audio track. AutoClipper needs speech to transcribe and find highlights.');
    }
    send({ type: 'meta', ...meta });
    await report(projectId, 'probe', 100, `${meta.width}×${meta.height}, ${Math.round(meta.durationMs / 1000)}s`);

    currentStage = 'audio';
    await report(projectId, 'audio', 1, 'Measuring and transcribing audio in bounded sections');
    const analysis = await analyzeAudioSegments(
      instance,
      meta,
      data.transcript,
      message.engine,
      (fraction, detail) => void report(projectId, 'transcribe', Math.max(1, fraction * 100), detail),
      (detail, fraction) => {
        send({ type: 'model', detail, progress: Math.round(fraction * 100) });
        void report(projectId, 'transcribe', 1 + fraction * 24, detail);
      },
      (engine, detail) => send({ type: 'engine', engine, detail }),
    );
    currentStage = 'transcribe';
    const signals = analysis.signals;
    const transcript = analysis.transcript;
    send({ type: 'transcript', wordCount: transcript.words.length, language: transcript.language });
    await report(projectId, 'transcribe', 100, `${transcript.words.length} words ready`);
    session = hydrateSession(projectId, meta, signals, transcript);
    await post(`/api/projects/${projectId}/process`, {
      action: 'transcript',
      transcript,
      meta,
      signals,
    });

    currentStage = 'select';
    await report(projectId, 'select', 10, 'Scoring hooks, context, payoff, substance, pacing and energy');
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
    })) as { clips?: { id: string; index: number; startMs: number; endMs: number; title: string }[] };
    const savedClips = selectionData.clips ?? [];
    if (savedClips.length === 0) throw new Error('The server did not save the selected clips.');
    send({ type: 'selection', count: savedClips.length });
    await report(projectId, 'select', 100, `${savedClips.length} highlights selected`);

    currentStage = 'render';
    for (let index = 0; index < savedClips.length; index += 1) {
      if (cancelled) throw new Error('Processing was cancelled.');
      const saved = savedClips[index];
      const sourceClip = selected[index] ?? selected[0];
      const edits: ClipEdits = {
        ...DEFAULT_EDITS,
        startMs: saved.startMs,
        endMs: saved.endMs,
      };
      const clipSignals = signals.sceneChangesMs.length > 0
        ? signals
        : {
            ...signals,
            sceneChangesMs: await detectScenes(instance, { startMs: saved.startMs, endMs: saved.endMs }),
          };
      await report(
        projectId,
        'render',
        (index / savedClips.length) * 100,
        `Framing clip ${index + 1} of ${savedClips.length}`,
      );
      const framing = await analyzeClipFraming(
        instance,
        meta.width,
        meta.height,
        saved.startMs,
        saved.endMs,
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
        (index / savedClips.length) * 100,
        `Rendering clip ${index + 1} of ${savedClips.length}`,
      );
      const rendered = await renderClip(plan, meta.width, meta.height, index + 1, (fraction) => {
        const overall = ((index + fraction) / savedClips.length) * 100;
        void report(projectId, 'render', overall, `Encoding clip ${index + 1} of ${savedClips.length} · ${Math.round(fraction * 100)}%`);
      });
      const clip = await finishClip(projectId, saved, edits, plan, rendered);
      send({ type: 'clip', clip });
      void sourceClip;
    }
    await report(projectId, 'render', 100, 'All clips rendered');
    const completed = (await post(`/api/projects/${projectId}/process`, { action: 'complete' })) as { project?: import('../types').Project };
    send({ type: 'done', project: completed.project as import('../types').Project });
  } catch (error) {
    const failureStage = error instanceof ModelLoadError ? 'transcribe' : currentStage;
    try {
      await post(`/api/projects/${projectId}/process`, {
        action: 'fail',
        error: (error as Error).message.slice(0, 1500),
        stage: failureStage,
      });
    } catch {
      // If the failure report itself cannot be stored, the error is still sent
      // to the open tab so the user is not left with a silent failure.
    }
    fail(error);
  }
}

async function ensureSession(
  projectId: string,
  sourceFile: File | null | undefined,
): Promise<Session> {
  if (session?.projectId === projectId) return session;
  const data = (await (await fetch(`/api/projects/${projectId}/processor`, { credentials: 'same-origin' })).json()) as {
    sourceMode?: 'local' | 'remote' | 'none';
    sourceUrl: string | null;
    sourceBytes: number | null;
    transcript?: import('./protocol').BrowserTranscript | null;
    error?: string;
  };
  if (data.sourceMode === 'local' && !sourceFile) {
    throw new Error('This source is kept in your browser. Attach the original video to render a clip.');
  }
  if (!sourceFile && !data.sourceUrl) throw new Error(data.error ?? 'This project has no source video.');
  const instance = await ensureFfmpegFiles();
  await attachSource(instance, sourceFile, data.sourceUrl, data.sourceBytes, () => undefined);
  const meta = await probe(instance);
  if (!meta.hasAudio) throw new Error('This video has no audio track.');
  const analysis = await analyzeAudioSegments(
    instance,
    meta,
    data.transcript,
    'auto',
    () => undefined,
    () => undefined,
    () => undefined,
  );
  session = hydrateSession(projectId, meta, analysis.signals, data.transcript ?? analysis.transcript);
  return session;
}

async function runRenderClip(message: RenderClipMessage) {
  try {
    const active = await ensureSession(message.projectId, message.sourceFile);
    if (!active.transcript) throw new Error('The transcript for this project is missing. Re-run processing first.');
    const edits = { ...DEFAULT_EDITS, ...message.edits, startMs: message.startMs, endMs: message.endMs };
    let signals = active.signals;
    if (signals && signals.sceneChangesMs.length === 0) {
      const instance = await loadFfmpeg();
      signals = {
        ...signals,
        sceneChangesMs: await detectScenes(instance, { startMs: message.startMs, endMs: message.endMs }),
      };
    }
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
    fail(error);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'start') {
    void runStart(message);
  } else if (message.type === 'render-clip') {
    void runRenderClip(message);
  }
};
