import type { TimedWord } from '../types';

/**
 * Transcript cleanup happens after Whisper, not instead of it.
 *
 * whisper-tiny.en emits a standalone dash (and occasionally other punctuation)
 * while it is decoding silence or music. Those tokens have timestamps but no
 * speech, so keeping them makes transcript text, titles and captions look
 * broken. The decoder can also enter an exact phrase loop on a difficult
 * window. We remove only high-confidence artifacts here and keep short,
 * emphatic repetitions such as "no, no, no" or "wait, wait".
 */

export interface TranscriptCleanupStats {
  inputWords: number;
  outputWords: number;
  placeholdersRemoved: number;
  repeatedRuns: number;
  repeatedWordsRemoved: number;
  denseRuns: number;
  denseWordsRemoved: number;
  examples: string[];
}

export interface CleanedTranscript {
  words: TimedWord[];
  text: string;
  stats: TranscriptCleanupStats;
}

const MIN_SINGLE_WORD_REPEATS = 3;
const MIN_PHRASE_REPEATS = 3;
const MAX_REPEAT_UNIT_WORDS = 8;
const MAX_REPEAT_GAP_MS = 500;
const DENSE_WINDOW_MS = 15_000;
const DENSE_MAX_GAP_MS = 2_000;
const DENSE_MIN_ANCHOR_REPEATS = 6;
const DENSE_MIN_WORDS = 12;
const DENSE_MAX_UNIQUE_RATIO = 0.5;
const DENSE_ANCHOR_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'he',
  'her',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your',
]);
/** Keep two repetitions of these instead of flattening emphasis to one. */
const EMPHATIC_WORDS = new Set([
  'no',
  'wait',
  'hey',
  'stop',
  'yeah',
  'what',
  'oh',
  'please',
  'sorry',
  'thanks',
  'thank',
  'hold',
  'come',
  'go',
]);

const NON_SPEECH_MARKER =
  /^(?:\[(?:music|applause|laughter|silence|inaudible|blank[^\]]*)\]|\((?:music|applause|laughter|silence|inaudible|blank[^)]*)\))$/i;

/** A token key used only for comparison; it never changes the stored text. */
export function transcriptTokenKey(text: string): string {
  return String(text)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Standalone hyphens, arrows, music notes and bracketed sound labels are not
 * spoken words. Punctuation attached to a real token ("hello," or "'S") stays.
 */
export function isTranscriptPlaceholder(text: string): boolean {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;
  const core = trimmed.replace(/[^\p{L}\p{N}]/gu, '');
  if (!core) return true;
  // Whisper tokenization can leave a detached clitic or timestamp-like
  // fragment glued to leading punctuation ("'S", "'S...", "'S'm", "-y",
  // ".I"). A real word that starts with punctuation has a longer core;
  // "(beep)" and "'cause" stay. Standalone single letters are fragments too,
  // except the words "a" and "I".
  if (/^[^\p{L}\p{N}]/u.test(trimmed) && core.length <= 2) return true;
  if (core.length === 1 && !/^[ai]$/i.test(core)) return true;
  return NON_SPEECH_MARKER.test(trimmed);
}

export function transcriptWordMidpoint(word: TimedWord): number {
  return (word.startMs + word.endMs) / 2;
}

/** The longest stretch of a source range that has no timed word. */
export interface WordGap {
  startMs: number;
  endMs: number;
  gapMs: number;
}

export function largestWordGap(words: TimedWord[], startMs: number, endMs: number): WordGap {
  const start = Math.max(0, Math.round(startMs));
  const end = Math.max(start, Math.round(endMs));
  let cursor = start;
  let best: WordGap = { startMs: start, endMs: start, gapMs: 0 };
  const ordered = [...words].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (const word of ordered) {
    const wordStart = Math.max(start, word.startMs);
    const wordEnd = Math.min(end, word.endMs);
    if (wordStart >= end || wordEnd <= cursor) continue;
    if (wordStart > cursor) {
      const gapMs = wordStart - cursor;
      if (gapMs > best.gapMs) best = { startMs: cursor, endMs: wordStart, gapMs };
    }
    cursor = Math.max(cursor, wordEnd);
  }
  if (end > cursor) {
    const gapMs = end - cursor;
    if (gapMs > best.gapMs) best = { startMs: cursor, endMs: end, gapMs };
  }
  return best;
}

/**
 * Each source region owns words whose midpoint is inside it. Using the midpoint
 * instead of the start makes an overlapping word belong to exactly one window
 * or section, even when the provider rounds the timestamps slightly.
 */
export function isWordOwnedByRange(word: TimedWord, startMs: number, endMs: number): boolean {
  const midpoint = transcriptWordMidpoint(word);
  return midpoint >= startMs && midpoint < endMs;
}

export function transcriptTextFromWords(words: TimedWord[]): string {
  return words
    .map((word) => word.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

/**
 * A conservative speech-energy gate for the retry path. It is deliberately
 * cheap and does not try to be a VAD; it only prevents retrying digital silence
 * or very low room tone after Whisper returned no words.
 */
export function hasSpeechEnergy(samples: Float32Array, sampleRate: number): boolean {
  if (!samples || samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return false;
  }
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  let frames = 0;
  let activeFrames = 0;
  let peak = 0;
  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(samples.length, start + frameSize);
    let sum = 0;
    let framePeak = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index];
      sum += value * value;
      const absolute = Math.abs(value);
      if (absolute > framePeak) framePeak = absolute;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    if (rms >= 0.004 && framePeak >= 0.01) activeFrames += 1;
    if (framePeak > peak) peak = framePeak;
    frames += 1;
  }
  return frames > 0 && activeFrames / frames >= 0.08 && peak >= 0.02;
}

function isEmphaticWord(key: string): boolean {
  return EMPHATIC_WORDS.has(key);
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim());
}

/**
 * Whisper loops are not always clean phrase repetitions. A difficult window can
 * emit a small vocabulary over and over with shuffled word order ("I was a
 * liar ... was a liar I ..."). The exact pass below handles clean loops; this
 * pass finds short, dense, low-diversity spans and keeps the first occurrence
 * of each word. That leaves one readable copy without inventing new text or
 * changing any retained timestamp.
 */
function collapseDenseRepetition(
  words: TimedWord[],
  keys: string[],
): { words: TimedWord[]; runs: number; removed: number; examples: string[] } {
  if (words.length < DENSE_MIN_WORDS) return { words, runs: 0, removed: 0, examples: [] };
  const marked = new Uint8Array(words.length);

  for (let anchor = 0; anchor < words.length; anchor += 1) {
    const key = keys[anchor];
    if (!key || (key.length < 2 && key !== 'y') || DENSE_ANCHOR_STOPWORDS.has(key)) continue;
    let last = anchor;
    let occurrences = 1;
    for (let index = anchor + 1; index < words.length; index += 1) {
      if (words[index].startMs - words[anchor].startMs > DENSE_WINDOW_MS) break;
      if (words[index].startMs - words[index - 1].endMs > DENSE_MAX_GAP_MS) break;
      if (keys[index] !== key) continue;
      last = index;
      occurrences += 1;
    }
    if (occurrences < DENSE_MIN_ANCHOR_REPEATS) continue;

    // Include the words immediately before the loop when they are still part
    // of the same phrase, so "I was a liar" is not reduced to "was a liar".
    let start = anchor;
    while (
      start > 0 &&
      anchor - start < 8 &&
      words[start].startMs - words[start - 1].endMs <= 800 &&
      !endsSentence(words[start - 1].text)
    ) {
      start -= 1;
    }
    marked.fill(1, start, last + 1);
  }

  const output: TimedWord[] = [];
  const examples: string[] = [];
  let runs = 0;
  let removed = 0;
  let index = 0;
  while (index < words.length) {
    if (!marked[index]) {
      output.push(words[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < words.length && marked[end]) end += 1;
    const zone = words.slice(index, end);
    const zoneKeys = keys.slice(index, end);
    const unique = new Set(zoneKeys.filter(Boolean));
    if (zone.length < DENSE_MIN_WORDS || unique.size / Math.max(1, zone.length) > DENSE_MAX_UNIQUE_RATIO) {
      output.push(...zone);
      index = end;
      continue;
    }

    const kept = new Map<string, number>();
    const keptWords: TimedWord[] = [];
    for (let offset = 0; offset < zone.length; offset += 1) {
      const key = zoneKeys[offset];
      const limit = isEmphaticWord(key) ? 2 : 1;
      const count = kept.get(key) ?? 0;
      if (count < limit) {
        kept.set(key, count + 1);
        keptWords.push(zone[offset]);
      } else {
        removed += 1;
      }
    }
    runs += 1;
    if (examples.length < 4) {
      examples.push(`${keptWords.slice(0, 8).map((word) => word.text).join(' ')} … dense ×${Math.round(zone.length / Math.max(1, keptWords.length))}`);
    }
    output.push(...keptWords);
    index = end;
  }
  return { words: output, runs, removed, examples };
}

/**
 * Collapse only exact, adjacent, densely timed loops. A repeated phrase or
 * single word must occur three times before it is treated as a decoder loop.
 * Two repetitions are always preserved, so ordinary emphasis such as "no, no"
 * survives while the three-plus stutters visible in captions do not.
 */
export function collapseRepeatedSpeech(words: TimedWord[]): {
  words: TimedWord[];
  repeatedRuns: number;
  removed: number;
  denseRuns: number;
  denseRemoved: number;
  examples: string[];
} {
  if (words.length === 0) {
    return { words, repeatedRuns: 0, removed: 0, denseRuns: 0, denseRemoved: 0, examples: [] };
  }
  const initialKeys = words.map((word) => transcriptTokenKey(word.text));
  const dense = collapseDenseRepetition(words, initialKeys);
  const output: TimedWord[] = [];
  const examples = [...dense.examples];
  let repeatedRuns = dense.runs;
  let removed = dense.removed;

  const keys = dense.words.map((word) => transcriptTokenKey(word.text));
  const source = dense.words;
  let index = 0;
  while (index < source.length) {
    let matched: { unit: number; repeats: number } | null = null;
    for (let unit = 1; unit <= MAX_REPEAT_UNIT_WORDS; unit += 1) {
      const minimum = unit === 1 ? MIN_SINGLE_WORD_REPEATS : MIN_PHRASE_REPEATS;
      if (index + unit * minimum > source.length) continue;
      const unitKeys = keys.slice(index, index + unit);
      if (unitKeys.some((key) => !key)) continue;
      const signature = unitKeys.join('\u0001');
      let repeats = 1;
      while (index + (repeats + 1) * unit <= source.length) {
        const nextStart = index + repeats * unit;
        const nextKeys = keys.slice(nextStart, nextStart + unit);
        if (nextKeys.join('\u0001') !== signature) break;
        const previousWord = source[nextStart - 1];
        const nextWord = source[nextStart];
        if (nextWord.startMs - previousWord.endMs > MAX_REPEAT_GAP_MS) break;
        repeats += 1;
      }
      if (repeats >= minimum) {
        matched = { unit, repeats };
        break;
      }
    }

    if (!matched) {
      output.push(source[index]);
      index += 1;
      continue;
    }

    const unitWords = source.slice(index, index + matched.unit);
    const keep = matched.unit === 1 && isEmphaticWord(keys[index]) ? 2 : 1;
    for (let repeat = 0; repeat < matched.repeats; repeat += 1) {
      for (let offset = 0; offset < matched.unit; offset += 1) {
        if (repeat < keep) output.push(source[index + repeat * matched.unit + offset]);
        else removed += 1;
      }
    }
    repeatedRuns += 1;
    if (examples.length < 5) {
      examples.push(`${unitWords.map((word) => word.text).join(' ')} ×${matched.repeats}`);
    }
    index += matched.repeats * matched.unit;
  }

  return {
    words: output,
    repeatedRuns,
    removed,
    denseRuns: dense.runs,
    denseRemoved: dense.removed,
    examples,
  };
}

export function cleanupTranscriptWords(words: TimedWord[]): CleanedTranscript {
  const inputWords = Array.isArray(words) ? words : [];
  const withoutPlaceholders: TimedWord[] = [];
  let placeholdersRemoved = 0;
  for (const word of inputWords) {
    if (!word || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)) continue;
    if (word.endMs <= word.startMs) continue;
    if (isTranscriptPlaceholder(word.text)) {
      placeholdersRemoved += 1;
      continue;
    }
    withoutPlaceholders.push({
      text: word.text.trim(),
      startMs: Math.max(0, Math.round(word.startMs)),
      endMs: Math.max(1, Math.round(word.endMs)),
    });
  }

  const collapsed = collapseRepeatedSpeech(withoutPlaceholders);
  return {
    words: collapsed.words,
    text: transcriptTextFromWords(collapsed.words),
    stats: {
      inputWords: inputWords.length,
      outputWords: collapsed.words.length,
      placeholdersRemoved,
      repeatedRuns: collapsed.repeatedRuns,
      repeatedWordsRemoved: collapsed.removed,
      denseRuns: collapsed.denseRuns,
      denseWordsRemoved: collapsed.denseRemoved,
      examples: collapsed.examples,
    },
  };
}
