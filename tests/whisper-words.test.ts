import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhisperWords, type WhisperResultLike } from '../src/lib/browser/whisper-words';

function assertOrdered(words: { text: string; startMs: number; endMs: number }[]) {
  for (const word of words) {
    assert.ok(word.endMs > word.startMs, `${word.text} must have a positive duration`);
  }
  for (let index = 1; index < words.length; index += 1) {
    assert.ok(
      words[index].startMs >= words[index - 1].startMs,
      `word ${index} must not start before the previous word`,
    );
  }
}

test('word-level chunks keep their exact provider timings', () => {
  const result: WhisperResultLike = {
    text: ' Hello world',
    chunks: [
      { text: ' Hello', timestamp: [0, 0.42] },
      { text: ' world', timestamp: [0.45, 0.9] },
    ],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 5_000, durationMs: 3_000 });

  assert.equal(parsed.timing, 'provider');
  assert.deepEqual(parsed.words, [
    { text: 'Hello', startMs: 5_000, endMs: 5_420 },
    { text: 'world', startMs: 5_450, endMs: 5_900 },
  ]);
  assert.equal(parsed.stats.wordChunks, 2);
  assert.equal(parsed.stats.mergedChunks, 0);
});

test('segment-level chunks are split into words inside their own window', () => {
  const result: WhisperResultLike = {
    text: ' Hello world again',
    chunks: [
      { text: ' Hello world', timestamp: [0, 1.2] },
      { text: ' again', timestamp: [1.3, 1.8] },
    ],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 0, durationMs: 3_000 });

  assert.equal(parsed.timing, 'estimated');
  assert.equal(parsed.stats.mergedChunks, 1);
  assert.deepEqual(
    parsed.words.map((word) => word.text),
    ['Hello', 'world', 'again'],
  );
  assertOrdered(parsed.words);
  assert.equal(parsed.words[0].startMs, 0);
  assert.equal(parsed.words[1].endMs, 1_200);
  assert.equal(parsed.words[2].startMs, 1_300);
  assert.equal(parsed.words[2].endMs, 1_800);
});

test('verbose-JSON segments are expanded when no word data is present', () => {
  const result: WhisperResultLike = {
    text: 'One two three',
    segments: [
      { text: 'One two', start: 0, end: 1 },
      { text: 'three', start: 1.1, end: 1.6 },
    ],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 10_000, durationMs: 4_000 });

  assert.equal(parsed.timing, 'estimated');
  assert.equal(parsed.stats.segmentChunks, 2);
  assert.deepEqual(
    parsed.words.map((word) => word.text),
    ['One', 'two', 'three'],
  );
  assertOrdered(parsed.words);
  assert.equal(parsed.words[0].startMs, 10_000);
  assert.equal(parsed.words[1].startMs, 10_500);
  assert.equal(parsed.words[2].startMs, 11_100);
  assert.equal(parsed.words[2].endMs, 11_600);
});

test('a segment chunk that already carries word timings stays provider-timed', () => {
  const result: WhisperResultLike = {
    text: ' Hi there',
    chunks: [
      {
        text: ' Hi there',
        timestamp: [0, 1],
        words: [
          { text: ' Hi', timestamp: [0, 0.3] },
          { text: ' there', timestamp: [0.4, 0.9] },
        ],
      },
    ],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 0, durationMs: 2_000 });

  assert.equal(parsed.timing, 'provider');
  assert.deepEqual(parsed.words, [
    { text: 'Hi', startMs: 0, endMs: 300 },
    { text: 'there', startMs: 400, endMs: 900 },
  ]);
});

test('a short response with one multi-word chunk no longer fails the project', () => {
  // The old validator threw when a chunk held several words in a response with
  // fewer than four chunks. This is exactly the shape that failed a real run.
  const result: WhisperResultLike = {
    text: ' Welcome back to the show everybody',
    chunks: [{ text: ' Welcome back to the show everybody', timestamp: [0, 3] }],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 120_000, durationMs: 28_000 });

  assert.equal(parsed.words.length, 6);
  assert.equal(parsed.timing, 'estimated');
  assert.equal(parsed.stats.mergedChunks, 1);
  assert.deepEqual(
    parsed.words.map((word) => word.text),
    ['Welcome', 'back', 'to', 'the', 'show', 'everybody'],
  );
  assertOrdered(parsed.words);
  assert.equal(parsed.words[0].startMs, 120_000);
  assert.equal(parsed.words.at(-1)?.endMs, 123_000);
});

test('byte-merged words keep every token and stay inside the chunk window', () => {
  const result: WhisperResultLike = {
    chunks: [{ text: ' CORE IRL MAFIA 002', timestamp: [2, 3.5] }],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 0, durationMs: 5_000 });

  assert.deepEqual(
    parsed.words.map((word) => word.text),
    ['CORE', 'IRL', 'MAFIA', '002'],
  );
  assertOrdered(parsed.words);
  assert.equal(parsed.words[0].startMs, 2_000);
  assert.equal(parsed.words.at(-1)?.endMs, 3_500);
});

test('zero-duration word timestamps keep their position instead of being deferred', () => {
  const result: WhisperResultLike = {
    chunks: [
      { text: ' Hello', timestamp: [1.2, 1.35] },
      { text: ' world', timestamp: [1.4, 1.4] },
      { text: ' again', timestamp: [1.5, 1.7] },
    ],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 0, durationMs: 3_000 });

  assert.equal(parsed.timing, 'provider');
  assert.equal(parsed.stats.untimedChunks, 0);
  assert.deepEqual(parsed.words, [
    { text: 'Hello', startMs: 1_200, endMs: 1_350 },
    { text: 'world', startMs: 1_400, endMs: 1_420 },
    { text: 'again', startMs: 1_500, endMs: 1_700 },
  ]);
});

test('untimed chunks stay in transcript order between timed chunks', () => {
  const result: WhisperResultLike = {
    chunks: [
      { text: ' First', timestamp: [0, 0.5] },
      { text: ' orphan words', timestamp: [null, null] },
      { text: ' Last', timestamp: [2, 2.5] },
    ],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 0, durationMs: 3_000 });

  assert.equal(parsed.timing, 'estimated');
  assert.deepEqual(
    parsed.words.map((word) => word.text),
    ['First', 'orphan', 'words', 'Last'],
  );
  assertOrdered(parsed.words);
  assert.equal(parsed.words[1].startMs, 500);
  assert.equal(parsed.words[3].startMs, 2_000);
});

test('untimed text falls back to readable pacing instead of being dropped', () => {
  const result: WhisperResultLike = {
    text: 'No timing here',
    chunks: [{ text: 'No timing here', timestamp: [null, null] }],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 0, durationMs: 4_000 });

  assert.equal(parsed.timing, 'estimated');
  assert.equal(parsed.stats.untimedChunks, 1);
  assert.deepEqual(
    parsed.words.map((word) => word.text),
    ['No', 'timing', 'here'],
  );
  assertOrdered(parsed.words);
  assert.ok((parsed.words.at(-1)?.endMs ?? 0) <= 4_000);
});

test('plain text with no timestamps is distributed at a readable pace', () => {
  const result: WhisperResultLike = { text: 'Alpha beta' };

  const parsed = parseWhisperWords(result, { offsetMs: 250, durationMs: 2_000 });

  assert.equal(parsed.timing, 'estimated');
  assert.deepEqual(parsed.words, [
    { text: 'Alpha', startMs: 250, endMs: 717 },
    { text: 'beta', startMs: 717, endMs: 1_090 },
  ]);
});

test('mixed provider and merged chunks are all retained and marked estimated', () => {
  const result: WhisperResultLike = {
    chunks: [
      { text: ' Exact', timestamp: [0, 0.3] },
      { text: ' two words', timestamp: [0.4, 1.0] },
      { text: ' tail', timestamp: [1.1, 1.4] },
    ],
  };

  const parsed = parseWhisperWords(result, { offsetMs: 0, durationMs: 2_000 });

  assert.equal(parsed.timing, 'estimated');
  assert.deepEqual(
    parsed.words.map((word) => word.text),
    ['Exact', 'two', 'words', 'tail'],
  );
  assert.equal(parsed.words[0].startMs, 0);
  assert.equal(parsed.words[0].endMs, 300);
  assert.equal(parsed.words[1].startMs, 400);
  assert.equal(parsed.words[2].endMs, 1_000);
  assert.equal(parsed.words[3].startMs, 1_100);
  assert.equal(parsed.words[3].endMs, 1_400);
  assertOrdered(parsed.words);
});

test('an empty response produces no words without throwing', () => {
  const parsed = parseWhisperWords({ text: '' }, { offsetMs: 0, durationMs: 1_000 });

  assert.deepEqual(parsed.words, []);
  assert.equal(parsed.timing, 'provider');
});
