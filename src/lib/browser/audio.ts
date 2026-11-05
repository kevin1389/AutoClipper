import type { BrowserSignals } from './protocol';

export interface DecodedAudio {
  sampleRate: number;
  samples: Float32Array;
  durationMs: number;
}

/** Parses the PCM WAV that the browser FFmpeg write produces. */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error('FFmpeg produced an invalid WAV audio track.');
  }
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || dataLength <= 0) throw new Error('The extracted audio track is empty.');
  if (bits !== 16) throw new Error(`Unsupported extracted audio depth (${bits}-bit).`);

  const frames = Math.floor(dataLength / (2 * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      mixed += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
    }
    samples[frame] = mixed / channels;
  }

  return { sampleRate, samples, durationMs: Math.round((frames / sampleRate) * 1000) };
}

function detectPeaks(levels: { tMs: number; rms: number }[]): number[] {
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

/** One RMS dBFS reading per second, matching the previous server analysis. */
export function signalsFromSamples(
  audio: DecodedAudio,
  sceneChangesMs: number[] = [],
  offsetMs = 0,
): BrowserSignals {
  const { samples, sampleRate } = audio;
  const perWindow = Math.max(1, Math.round(sampleRate));
  const audioLevels: { tMs: number; rms: number }[] = [];
  for (let start = 0; start < samples.length; start += perWindow) {
    const end = Math.min(samples.length, start + perWindow);
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    audioLevels.push({
      tMs: offsetMs + Math.round((start / sampleRate) * 1000),
      rms: rms > 0.000003 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -91,
    });
  }
  return {
    audio: audioLevels,
    peaksMs: detectPeaks(audioLevels).map((peak) => peak + offsetMs),
    sceneChangesMs,
    source: { audio: audioLevels.length > 0, visual: sceneChangesMs.length > 0 },
  };
}

/** Groups word timings into sentence-like segments for the transcript record. */
export function segmentsFromWords(words: { text: string; startMs: number; endMs: number }[]) {
  const segments: { text: string; startMs: number; endMs: number }[] = [];
  let current: typeof words = [];
  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      text: current.map((word) => word.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim(),
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
    });
    current = [];
  };
  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous && word.startMs - previous.endMs > 650) flush();
    current.push(word);
    if (/[.!?]["')\]]?$/.test(word.text)) flush();
    if (current.length >= 30) flush();
  }
  flush();
  return segments.filter((segment) => segment.text.length > 0);
}
