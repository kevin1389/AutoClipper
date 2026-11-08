/**
 * Splits decoded mono audio into overlapping 28-second Whisper windows.
 *
 * Whisper's encoder pads its input to 30 seconds. Keeping each source window at
 * 28 seconds leaves that padding intact and matches the context size used by
 * the quality baseline. A 1.5-second overlap makes sure a word sitting on a
 * boundary is fully decoded by the next window; the duplicated leading second
 * and a half is discarded with `skipBeforeMs` instead of being emitted twice.
 *
 * Every sample is covered by at least one window, and each output region is
 * owned by exactly one window (except for the discarded overlap).
 */
export interface TranscriptionWindow {
  index: number;
  /** Inclusive first sample in the source buffer. */
  startSample: number;
  /** Exclusive last sample in the source buffer. */
  endSample: number;
  /** Window start relative to the source buffer, in milliseconds. */
  startMs: number;
  /** Window end relative to the source buffer, in milliseconds. */
  endMs: number;
  /**
   * Words starting before this relative time are duplicates from the previous
   * window. -1 for the first window, which has no predecessor.
   */
  skipBeforeMs: number;
}

export const WHISPER_CHUNK_SECONDS = 28;
export const WHISPER_OVERLAP_SECONDS = 1.5;

export function transcriptionWindows(
  totalSamples: number,
  sampleRate: number,
  chunkSeconds = WHISPER_CHUNK_SECONDS,
  overlapSeconds = WHISPER_OVERLAP_SECONDS,
): TranscriptionWindow[] {
  const samples = Math.floor(Number(totalSamples));
  const rate = Math.floor(Number(sampleRate));
  if (!Number.isFinite(samples) || samples <= 0 || !Number.isFinite(rate) || rate <= 0) {
    return [];
  }

  const chunkSamples = Math.max(1, Math.round(chunkSeconds * rate));
  const overlapSamples = Math.max(0, Math.min(chunkSamples - 1, Math.round(overlapSeconds * rate)));
  // Advance by the non-overlapping part, not by the full window. The next
  // window re-decodes the overlap so a boundary word is never skipped.
  const stepSamples = Math.max(1, chunkSamples - overlapSamples);
  const windows: TranscriptionWindow[] = [];

  for (let index = 0, start = 0; start < samples; index += 1, start += stepSamples) {
    const end = Math.min(samples, start + chunkSamples);
    if (end <= start) break;
    windows.push({
      index,
      startSample: start,
      endSample: end,
      startMs: Math.round((start / rate) * 1000),
      endMs: Math.round((end / rate) * 1000),
      // Keep the previous window's tail and discard this window's duplicate
      // head. For the first window there is no predecessor to defer to.
      skipBeforeMs: index === 0 ? -1 : Math.round(((start + overlapSamples) / rate) * 1000),
    });
    if (end >= samples) break;
  }

  return windows;
}
