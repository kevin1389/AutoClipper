import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupTranscriptWords,
  collapseRepeatedSpeech,
  hasSpeechEnergy,
  isTranscriptPlaceholder,
  isWordOwnedByRange,
  largestWordGap,
  transcriptTokenKey,
} from '../src/lib/browser/transcript-cleanup';

function word(text: string, startMs: number, endMs = startMs + 300) {
  return { text, startMs, endMs };
}

test('standalone punctuation is a placeholder; attached punctuation is speech', () => {
  assert.equal(isTranscriptPlaceholder('-'), true);
  assert.equal(isTranscriptPlaceholder('>>'), true);
  assert.equal(isTranscriptPlaceholder('♪'), true);
  assert.equal(isTranscriptPlaceholder('[Music]'), true);
  assert.equal(isTranscriptPlaceholder('(applause)'), true);
  assert.equal(isTranscriptPlaceholder('hello,'), false);
  assert.equal(isTranscriptPlaceholder("'S"), true);
  assert.equal(isTranscriptPlaceholder('-s'), true);
  assert.equal(isTranscriptPlaceholder('-y'), true);
  assert.equal(isTranscriptPlaceholder('.I'), true);
  assert.equal(isTranscriptPlaceholder("'I"), true);
  assert.equal(isTranscriptPlaceholder("'S..."), true);
  assert.equal(isTranscriptPlaceholder("'S'm"), true);
  assert.equal(isTranscriptPlaceholder('Q'), true);
  assert.equal(isTranscriptPlaceholder('I'), false);
  assert.equal(isTranscriptPlaceholder("'cause"), false);
  assert.equal(isTranscriptPlaceholder('(beep)'), false);
  assert.equal(isTranscriptPlaceholder('state-of-the-art'), false);
});

test('cleanup removes dash runs, preserves timings, and rebuilds clean text', () => {
  const words = [
    word('Today', 0, 420),
    word('-', 420, 490),
    word('-', 490, 560),
    word('we', 560, 800),
    word('begin.', 800, 1_200),
  ];

  const result = cleanupTranscriptWords(words);

  assert.deepEqual(result.words, [
    { text: 'Today', startMs: 0, endMs: 420 },
    { text: 'we', startMs: 560, endMs: 800 },
    { text: 'begin.', startMs: 800, endMs: 1_200 },
  ]);
  assert.equal(result.text, 'Today we begin.');
  assert.equal(result.stats.placeholdersRemoved, 2);
  assert.equal(result.stats.repeatedRuns, 0);
});

test('a long exact phrase loop collapses to one occurrence', () => {
  const words = Array.from({ length: 19 }, (_, index) => [
    word('I', index * 1_000),
    word('was', index * 1_000 + 200),
    word('a', index * 1_000 + 350),
    word('liar.', index * 1_000 + 500),
  ]).flat();

  const result = cleanupTranscriptWords(words);

  assert.equal(result.words.length, 4);
  assert.equal(result.words.map((entry) => entry.text).join(' '), 'I was a liar.');
  assert.equal(result.stats.repeatedRuns, 1);
  assert.equal(result.stats.repeatedWordsRemoved, 72);
  assert.equal(result.words[0].startMs, 0);
  assert.equal(result.words[3].endMs, 800);
});

test('a long single-word loop keeps two emphatic repetitions', () => {
  const words = Array.from({ length: 9 }, (_, index) => word('wait', index * 300, index * 300 + 220));
  const result = collapseRepeatedSpeech(words);

  assert.equal(result.words.length, 2);
  assert.equal(result.repeatedRuns, 1);
  assert.equal(result.removed, 7);
  assert.equal(result.words[0].startMs, 0);
  assert.equal(result.words[1].startMs, 300);
});

test('two emphatic repetitions survive and a third is collapsed', () => {
  const words = [
    word('no', 0, 200),
    word('no', 220, 420),
    word('no', 440, 640),
    word('I', 1_000, 1_200),
    word('know', 1_200, 1_500),
  ];
  const result = collapseRepeatedSpeech(words);

  assert.deepEqual(result.words, [words[0], words[1], words[3], words[4]]);
  assert.equal(result.repeatedRuns, 1);
  assert.equal(result.removed, 1);
});

test('a phrase repeated only twice is not treated as a decoder loop', () => {
  const words = [
    word('I', 0),
    word('know', 300),
    word('I', 1_000),
    word('know', 1_300),
  ];
  const result = collapseRepeatedSpeech(words);

  assert.equal(result.words.length, 4);
  assert.equal(result.repeatedRuns, 0);
});

test('a word crossing a boundary belongs to exactly one range', () => {
  const crossing = word('boundary', 27_950, 28_100);

  assert.equal(transcriptTokenKey(crossing.text), 'boundary');
  assert.equal(isWordOwnedByRange(crossing, 28_000, 30_000), true);
  assert.equal(isWordOwnedByRange(crossing, 0, 28_000), false);
  assert.equal(isWordOwnedByRange(crossing, 27_000, 28_000), false);
});

test('the largest uncovered gap ignores words outside the owned range', () => {
  const words = [word('before', 1_000, 1_300), word('inside', 10_000, 10_400), word('after', 29_000, 29_500)];
  const gap = largestWordGap(words, 5_000, 25_000);

  assert.deepEqual(gap, { startMs: 10_400, endMs: 25_000, gapMs: 14_600 });
  assert.equal(largestWordGap([], 5_000, 25_000).gapMs, 20_000);
});

test('speech energy rejects silence and accepts a voiced signal', () => {
  const quiet = new Float32Array(16_000 * 2);
  assert.equal(hasSpeechEnergy(quiet, 16_000), false);

  const voiced = new Float32Array(16_000 * 2);
  for (let index = 0; index < voiced.length; index += 1) {
    voiced[index] = 0.08 * Math.sin((2 * Math.PI * 180 * index) / 16_000);
  }
  assert.equal(hasSpeechEnergy(voiced, 16_000), true);
});
