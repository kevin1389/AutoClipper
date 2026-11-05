import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssCaptions, sanitizeCaptionText } from '../src/lib/captions/ass';
import type { TimedWord } from '../src/lib/types';

const words: TimedWord[] = [
  { text: 'Hello', startMs: 10_500, endMs: 10_800 },
  { text: 'world', startMs: 10_850, endMs: 11_300 },
];

test('shifts word timings into clip-relative time', () => {
  const result = buildAssCaptions(words, { startMs: 10_000, endMs: 14_000 });
  assert.equal(result.cueCount, 1);
  assert.match(result.ass, /Dialogue: 0,0:00:00\.50,0:00:01\.30/);
  assert.match(result.ass, /PlayResX: 1080/);
  assert.match(result.ass, /PlayResY: 1920/);
});

test('emits karaoke tags so captions animate word by word', () => {
  const result = buildAssCaptions(words, { startMs: 10_000, endMs: 14_000 });
  assert.match(result.ass, /\{\\kf30\}Hello/);
  assert.match(result.ass, /\{\\kf45\}world/);
  assert.match(result.ass, /\\fad\(70,50\)/);
});

test('groups words into short cues and keeps every cue inside the clip', () => {
  const long: TimedWord[] = Array.from({ length: 6 }, (_, index) => ({
    text: 'word',
    startMs: index * 400,
    endMs: index * 400 + 300,
  }));
  const result = buildAssCaptions(long, { startMs: 0, endMs: 5_000 });
  assert.equal(result.cueCount, 2);
  const timestamps = [...result.ass.matchAll(/Dialogue: 0,(\d+:\d\d:\d\d\.\d\d),(\d+:\d\d:\d\d\.\d\d)/g)];
  assert.equal(timestamps.length, 2);
  for (const [, start, end] of timestamps) {
    assert.ok(start < end);
  }
});

test('drops words outside the clip window', () => {
  const result = buildAssCaptions(
    [
      { text: 'before', startMs: 1_000, endMs: 1_500 },
      { text: 'inside', startMs: 9_000, endMs: 9_500 },
      { text: 'after', startMs: 20_000, endMs: 20_500 },
    ],
    { startMs: 8_000, endMs: 12_000 },
  );
  assert.equal(result.wordCount, 1);
  assert.match(result.ass, /inside/);
  assert.doesNotMatch(result.ass, /before/);
  assert.doesNotMatch(result.ass, /after/);
});

test('sanitizes text that would break ASS markup', () => {
  const result = buildAssCaptions(
    [{ text: '{\\pos(0,0)}hello', startMs: 0, endMs: 500 }],
    { startMs: 0, endMs: 1_000 },
  );
  assert.doesNotMatch(result.ass, /\\pos/);
  assert.match(result.ass, /hello/);
  assert.equal(sanitizeCaptionText('  spaced   out  '), 'spaced out');
  assert.equal(sanitizeCaptionText('wave 🎬 now'), 'wave now');
});

test('returns a valid but empty subtitle file when no words overlap', () => {
  const result = buildAssCaptions([], { startMs: 0, endMs: 3_000 });
  assert.equal(result.cueCount, 0);
  assert.match(result.ass, /\[Events\]/);
  assert.doesNotMatch(result.ass, /Dialogue:/);
});
