import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../env';

/**
 * Real audio/visual signals from the source file.
 *
 * - `audio`: one RMS reading per second (FFmpeg `astats` over 1 s windows).
 * - `peaks`: locally loud moments (speech emphasis, reactions, laughter).
 * - `sceneChanges`: frames where FFmpeg's scene detector fired, i.e. a real
 *   visual cut or major on-screen change. This is frame-difference analysis,
 *   not semantic understanding: it cannot tell a face from a wall.
 *
 * Everything degrades to empty arrays when FFmpeg cannot analyse the file, so a
 * selection or render never fails just because these signals are unavailable.
 */

const execFileAsync = promisify(execFile);
const ANALYSIS_TIMEOUT_MS = 10 * 60_000;

export interface AudioLevel {
  tMs: number;
  /** RMS in dBFS (negative; -91 means silence). */
  rms: number;
}

export interface MediaSignals {
  audio: AudioLevel[];
  peaksMs: number[];
  sceneChangesMs: number[];
  /** How the signals were produced, for the UI/report to stay honest. */
  source: { audio: boolean; visual: boolean };
}

export const EMPTY_SIGNALS: MediaSignals = {
  audio: [],
  peaksMs: [],
  sceneChangesMs: [],
  source: { audio: false, visual: false },
};

async function ffmpegCapture(args: string[]): Promise<string> {
  const binary = config().ffmpegPath;
  if (!binary) return '';
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: ANALYSIS_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return '';
  }
}

function parsePtsTime(chunk: string): number | null {
  const match = /pts_time:(-?\d+(?:\.\d+)?)/.exec(chunk);
  if (!match) return null;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function parseAudioLevels(output: string): AudioLevel[] {
  const levels: AudioLevel[] = [];
  for (const block of output.split(/\n(?=frame:)/)) {
    const time = parsePtsTime(block);
    const rmsMatch = /lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?)/.exec(block);
    if (time === null || !rmsMatch) continue;
    const rms = Number.parseFloat(rmsMatch[1]);
    if (!Number.isFinite(rms)) continue;
    levels.push({ tMs: Math.round(time * 1000), rms });
  }
  return levels;
}

export function detectPeaks(levels: AudioLevel[]): number[] {
  if (levels.length < 3) return [];
  const values = levels.map((level) => level.rms).filter((value) => value > -70);
  if (values.length === 0) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const threshold = Math.max(mean + Math.sqrt(variance) * 0.9, mean + 3.5);

  const peaks: number[] = [];
  for (let index = 1; index < levels.length - 1; index += 1) {
    const level = levels[index];
    if (level.rms < threshold) continue;
    if (level.rms < levels[index - 1].rms || level.rms < levels[index + 1].rms) continue;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && level.tMs - last < 2_500) continue;
    peaks.push(level.tMs);
  }
  return peaks;
}

export function parseSceneChanges(output: string): number[] {
  const times = new Set<number>();
  for (const block of output.split(/\n(?=frame:)/)) {
    if (!/lavfi\.scene_score=/.test(block)) continue;
    const time = parsePtsTime(block);
    if (time !== null) times.add(Math.round(time * 1000));
  }
  return [...times].sort((a, b) => a - b);
}

export async function analyzeMediaSignals(sourcePath: string): Promise<MediaSignals> {
  const audioOutput = await ffmpegCapture([
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    sourcePath,
    '-vn',
    '-af',
    'aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:file=-',
    '-f',
    'null',
    '-',
  ]);
  const audio = parseAudioLevels(audioOutput);
  const peaksMs = detectPeaks(audio);

  const sceneOutput = await ffmpegCapture([
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    sourcePath,
    '-an',
    '-vf',
    "select='gt(scene,0.3)',metadata=print:file=-",
    '-fps_mode',
    'vfr',
    '-f',
    'null',
    '-',
  ]);
  const sceneChangesMs = parseSceneChanges(sceneOutput);

  return {
    audio,
    peaksMs,
    sceneChangesMs,
    source: { audio: audio.length > 0, visual: sceneChangesMs.length > 0 },
  };
}

/** Mean RMS (dBFS) between two source timestamps, or null when unknown. */
export function averageLoudness(signals: MediaSignals, startMs: number, endMs: number): number | null {
  const inRange = signals.audio.filter((level) => level.tMs >= startMs && level.tMs <= endMs);
  if (inRange.length === 0) return null;
  return inRange.reduce((sum, level) => sum + level.rms, 0) / inRange.length;
}
