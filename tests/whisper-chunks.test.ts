import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transcriptionWindows,
  WHISPER_CHUNK_SECONDS,
  WHISPER_OVERLAP_SECONDS,
} from '../src/lib/browser/whisper-chunks';

test('302 seconds of audio uses 12 overlapping 28-second windows', () => {
  const rate = 16_000;
  const windows = transcriptionWindows(302 * rate, rate);
  assert.equal(windows.length, 12);
  assert.equal(WHISPER_CHUNK_SECONDS, 28);
  assert.equal(WHISPER_OVERLAP_SECONDS, 1.5);
  assert.equal(windows[0].startSample, 0);
  assert.equal(windows[0].endSample, 28 * rate);
  assert.equal(windows.at(-1)?.endSample, 302 * rate);
  assert.equal(windows.at(-1)?.startSample, 291.5 * rate);
  assert.equal(windows[0].skipBeforeMs, -1);
  assert.equal(windows[1].startSample, 26.5 * rate);
  assert.equal(windows[1].skipBeforeMs, 28_000);
});

test('every sample is covered and consecutive windows overlap', () => {
  const rate = 16_000;
  const total = 4_832_000;
  const windows = transcriptionWindows(total, rate);
  for (let index = 1; index < windows.length; index += 1) {
    assert.ok(
      windows[index].startSample < windows[index - 1].endSample,
      `window ${index} does not overlap its predecessor`,
    );
    assert.ok(
      windows[index].startSample > windows[index - 1].startSample,
      `window ${index} did not advance`,
    );
  }
  const covered = new Uint8Array(total);
  for (const window of windows) {
    for (let sample = window.startSample; sample < window.endSample; sample += 1) {
      covered[sample] = 1;
    }
  }
  assert.ok(covered.every((value) => value === 1), 'audio contains an uncovered gap');
});

test('short audio produces exactly one window', () => {
  const windows = transcriptionWindows(10 * 16_000, 16_000);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, 0);
  assert.equal(windows[0].endMs, 10_000);
});

test('a window ends at the final sample instead of reading past the buffer', () => {
  const windows = transcriptionWindows(35 * 16_000, 16_000);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].startSample, 26.5 * 16_000);
  assert.equal(windows[1].skipBeforeMs, 28_000);
  assert.equal(windows[1].endSample, 35 * 16_000);
  assert.equal(windows[1].endMs, 35_000);
});

test('empty or invalid audio has no windows', () => {
  assert.deepEqual(transcriptionWindows(0, 16_000), []);
  assert.deepEqual(transcriptionWindows(-1, 16_000), []);
  assert.deepEqual(transcriptionWindows(1_000, 0), []);
  assert.deepEqual(transcriptionWindows(Number.NaN, 16_000), []);
});
