import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../env';
import { buildVerticalFilter } from './crop';
import { buildZoomExpression, type EditPlan } from '../edit/plan';
import type { TimedWord } from '../types';

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 15 * 60_000;
const FFPROBE_TIMEOUT_MS = 60_000;

export class MediaToolMissingError extends Error {
  constructor(tool: 'ffmpeg' | 'ffprobe') {
    super(`${tool} is not available on this machine`);
    this.name = 'MediaToolMissingError';
  }
}

export class MediaCommandError extends Error {
  readonly tool: string;
  readonly stderrTail: string;
  constructor(tool: string, message: string, stderrTail: string) {
    super(message);
    this.name = 'MediaCommandError';
    this.tool = tool;
    this.stderrTail = stderrTail;
  }
}

function tail(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

async function run(
  tool: 'ffmpeg' | 'ffprobe',
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const binary = tool === 'ffmpeg' ? config().ffmpegPath : config().ffprobePath;
  if (!binary) throw new MediaToolMissingError(tool);

  try {
    const { stderr, stdout } = await execFileAsync(binary, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? FFMPEG_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return tool === 'ffprobe' ? stdout : stderr;
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
    if (failure.killed) {
      throw new MediaCommandError(tool, `${tool} timed out`, '');
    }
    throw new MediaCommandError(tool, failure.message ?? `${tool} failed`, tail(failure.stderr ?? ''));
  }
}

export interface MediaProbe {
  durationMs: number;
  /** Duration of the video track itself, which can be shorter than the container. */
  videoDurationMs: number;
  width: number;
  height: number;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  rotation: number;
  bitrate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const output = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
    { timeoutMs: FFPROBE_TIMEOUT_MS },
  );

  let parsed: { streams?: FfprobeStream[]; format?: { duration?: string; bit_rate?: string } };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    throw new MediaCommandError('ffprobe', 'Could not read media metadata', '');
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video) {
    throw new MediaCommandError('ffprobe', 'This file has no video stream', '');
  }

  const rotationTag = video.tags?.rotate ? Number.parseInt(video.tags.rotate, 10) : 0;
  const rotation =
    video.side_data_list?.find((entry) => typeof entry.rotation === 'number')?.rotation ??
    (Number.isFinite(rotationTag) ? rotationTag : 0);
  const swapped = Math.abs(rotation) % 180 === 90;

  const fpsSource = video.avg_frame_rate || video.r_frame_rate || '';
  const [num, den] = fpsSource.split('/').map((value) => Number.parseFloat(value));
  const fps = num && den ? Math.round((num / den) * 100) / 100 : null;

  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? video.duration ?? '0');
  const videoDurationSeconds = Number.parseFloat(video.duration ?? '0');

  return {
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : 0,
    videoDurationMs: Number.isFinite(videoDurationSeconds) ? Math.round(videoDurationSeconds * 1000) : 0,
    width: swapped ? (video.height ?? 0) : (video.width ?? 0),
    height: swapped ? (video.width ?? 0) : (video.height ?? 0),
    fps,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    rotation: Number.isFinite(rotation) ? rotation : 0,
    bitrate: parsed.format?.bit_rate ? Number.parseInt(parsed.format.bit_rate, 10) : null,
  };
}

/**
 * Extracts a small mono 16 kHz audio track. mp3 is preferred (widely accepted by
 * transcription APIs); AAC in an m4a container is used when libmp3lame is absent.
 */
export async function extractAudio(sourcePath: string, outputPath: string): Promise<string> {
  try {
    await run('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourcePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      outputPath,
    ]);
  } catch (error) {
    if (!(error instanceof MediaCommandError) || !/libmp3lame|Encoder .* not found/i.test(error.stderrTail + error.message)) {
      throw error;
    }
    await fs.rm(outputPath, { force: true });
    const aacPath = outputPath.replace(/\.[a-z0-9]+$/i, '.m4a');
    await run('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourcePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      aacPath,
    ]);
    const fallbackStat = await fs.stat(aacPath);
    if (fallbackStat.size === 0) {
      throw new MediaCommandError('ffmpeg', 'Audio extraction produced an empty file', '');
    }
    return aacPath;
  }

  const stat = await fs.stat(outputPath);
  if (stat.size === 0) throw new MediaCommandError('ffmpeg', 'Audio extraction produced an empty file', '');
  return outputPath;
}

/** Splits a long audio track into fixed-length chunks so each fits a provider limit. */
export async function segmentAudio(
  audioPath: string,
  outputPattern: string,
  segmentSeconds: number,
): Promise<string[]> {
  const directory = path.dirname(outputPattern);
  const base = path.basename(outputPattern);
  await fs.mkdir(directory, { recursive: true });

  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    audioPath,
    '-f',
    'segment',
    '-segment_time',
    String(segmentSeconds),
    '-reset_timestamps',
    '1',
    '-c',
    'copy',
    outputPattern,
  ]);

  const entries = await fs.readdir(directory);
  return entries
    .filter((entry) => entry.startsWith(base.split('%')[0]))
    .sort()
    .map((entry) => path.join(directory, entry));
}

export interface RenderClipInput {
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  words: TimedWord[];
  sourceWidth: number;
  sourceHeight: number;
  hasAudio: boolean;
  workDir: string;
  captureFps?: number;
}

export interface RenderClipResult {
  width: number;
  height: number;
  durationMs: number;
  bytes: number;
  posterPath: string | null;
  captionMode: 'burned-in' | 'none';
  cropStrategy: string;
}

/**
 * Cuts one clip, reframes it to 9:16 and burns synchronized captions in a single
 * encode pass. Runs with cwd = the clip's work directory so the subtitle filter
 * can reference files by plain relative names (no filter-path escaping).
 */
export async function renderVerticalClip(
  input: RenderClipInput,
  assFileName: string | null,
): Promise<RenderClipResult> {
  const durationMs = Math.max(500, input.endMs - input.startMs);
  const crop = buildVerticalFilter({ width: input.sourceWidth, height: input.sourceHeight });

  const filters = [crop.filter];
  if (assFileName) {
    const fontsRelative = path.relative(input.workDir, config().fontsDir).split(path.sep).join('/');
    filters.push(`subtitles=${assFileName}:fontsdir=${fontsRelative}`);
  }
  filters.push('fps=30');

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    (input.startMs / 1000).toFixed(3),
    '-t',
    (durationMs / 1000).toFixed(3),
    '-i',
    path.resolve(input.sourcePath),
    '-map',
    '0:v:0',
  ];
  if (input.hasAudio) args.push('-map', '0:a:0?');

  args.push(
    '-vf',
    filters.join(','),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-movflags',
    '+faststart',
  );

  if (input.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  } else {
    args.push('-an');
  }
  args.push('-t', (durationMs / 1000).toFixed(3), path.resolve(input.outputPath));

  await run('ffmpeg', args, { cwd: input.workDir });

  const stat = await fs.stat(input.outputPath);
  if (stat.size < 1024) {
    throw new MediaCommandError('ffmpeg', 'Rendered clip is empty', '');
  }

  const posterPath = path.join(path.dirname(input.outputPath), `${path.basename(input.outputPath, '.mp4')}.jpg`);
  let poster: string | null = null;
  try {
    const posterAt = Math.min(durationMs / 2000, 2);
    await run('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      posterAt.toFixed(2),
      '-i',
      path.resolve(input.outputPath),
      '-frames:v',
      '1',
      '-q:v',
      '4',
      posterPath,
    ]);
    poster = posterPath;
  } catch {
    poster = null;
  }

  return {
    width: 1080,
    height: 1920,
    durationMs: Math.round(durationMs),
    bytes: stat.size,
    posterPath: poster,
    captionMode: assFileName ? 'burned-in' : 'none',
    cropStrategy: crop.strategy,
  };
}

export interface RenderEditedClipInput {
  sourcePath: string;
  outputPath: string;
  plan: EditPlan;
  sourceWidth: number;
  sourceHeight: number;
  hasAudio: boolean;
  workDir: string;
}

/**
 * Renders the edited clip described by an EditPlan in one encode pass:
 *
 *   source → trim pieces (pauses removed, slow-motion stretches) → concat
 *          → 9:16 reframe → punch-in zoom (time-driven) → burned captions
 *
 * Because the plan owns the source→output time mapping, audio, captions and
 * zoom windows all share the same clock after pause removal.
 */
export async function renderEditedClip(
  input: RenderEditedClipInput,
  assFileName: string | null,
): Promise<RenderClipResult> {
  const pieces = input.plan.pieces.filter((piece) => piece.srcEndMs - piece.srcStartMs >= 40);
  if (pieces.length === 0) {
    throw new MediaCommandError('ffmpeg', 'The edit plan contained no usable video segments', '');
  }

  const crop = buildVerticalFilter(
    { width: input.sourceWidth, height: input.sourceHeight },
    { framing: input.plan.framing, durationMs: input.plan.outputDurationMs },
  );
  const filters: string[] = [];
  const concatInputs: string[] = [];

  pieces.forEach((piece, index) => {
    const start = (piece.srcStartMs / 1000).toFixed(3);
    const end = (piece.srcEndMs / 1000).toFixed(3);
    const speed = piece.speed !== 1 ? piece.speed.toFixed(3) : '1';
    filters.push(
      `[0:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${speed},setpts=PTS-STARTPTS[v${index}]`,
    );
    if (input.hasAudio) {
      const tempo = piece.speed !== 1 ? `,atempo=${speed}` : '';
      filters.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${tempo}[a${index}]`);
      concatInputs.push(`[v${index}][a${index}]`);
    } else {
      concatInputs.push(`[v${index}]`);
    }
  });

  filters.push(
    `${concatInputs.join('')}concat=n=${pieces.length}:v=1:a=${input.hasAudio ? 1 : 0}[vcat]${
      input.hasAudio ? '[acat]' : ''
    }`,
  );

  // Resample before zoompan. zoompan emits one frame per input frame at its
  // output timebase; feeding it 23.976 fps directly would shorten the video
  // track by 20% relative to the audio.
  let chain = `[vcat]${crop.filter},fps=30`;
  if (input.plan.zooms.length > 0) {
    const zoomExpression = buildZoomExpression(input.plan.zooms);
    chain += `,zoompan=z='${zoomExpression}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`;
  }
  if (assFileName) {
    const fontsRelative = path.relative(input.workDir, config().fontsDir).split(path.sep).join('/');
    chain += `,subtitles=${assFileName}:fontsdir=${fontsRelative}`;
  }
  filters.push(`${chain}[vout]`);

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path.resolve(input.sourcePath),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
  ];
  if (input.hasAudio) args.push('-map', '[acat]');

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-movflags',
    '+faststart',
  );
  if (input.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  } else {
    args.push('-an');
  }
  args.push('-t', (input.plan.outputDurationMs / 1000).toFixed(3), path.resolve(input.outputPath));

  await run('ffmpeg', args, { cwd: input.workDir });

  const stat = await fs.stat(input.outputPath);
  if (stat.size < 1024) {
    throw new MediaCommandError('ffmpeg', 'Rendered clip is empty', '');
  }

  const posterPath = path.join(path.dirname(input.outputPath), `${path.basename(input.outputPath, '.mp4')}.jpg`);
  let poster: string | null = null;
  try {
    const posterAt = Math.min(input.plan.outputDurationMs / 2000, 2);
    await run('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      posterAt.toFixed(2),
      '-i',
      path.resolve(input.outputPath),
      '-frames:v',
      '1',
      '-q:v',
      '4',
      posterPath,
    ]);
    poster = posterPath;
  } catch {
    poster = null;
  }

  return {
    width: 1080,
    height: 1920,
    durationMs: input.plan.outputDurationMs,
    bytes: stat.size,
    posterPath: poster,
    captionMode: assFileName ? 'burned-in' : 'none',
    cropStrategy: crop.strategy,
  };
}
