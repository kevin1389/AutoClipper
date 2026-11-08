import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFromFilename,
  ManualTranscriptError,
  parseManualTranscript,
} from '../src/lib/manual-transcript';

const DURATION = 60_000;

test('parses SRT cues and distributes words inside each cue', () => {
  const result = parseManualTranscript({
    filename: 'talk.srt',
    durationMs: DURATION,
    text: [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'Hello world.',
      '',
      '2',
      '00:00:03,500 --> 00:00:05,000',
      '<i>Second</i> cue',
    ].join('\r\n'),
  });

  assert.equal(result.format, 'srt');
  assert.equal(result.cueCount, 2);
  assert.equal(result.wordCount, 4);
  assert.equal(result.transcript.provider, 'manual-srt');
  assert.equal(result.transcript.timing, 'estimated');
  assert.equal(result.transcript.language, null);
  assert.equal(result.startMs, 1_000);
  assert.ok(result.endMs <= 5_000);
  assert.deepEqual(
    result.transcript.words.map((word) => word.text),
    ['Hello', 'world.', 'Second', 'cue'],
  );
  for (const word of result.transcript.words) {
    assert.ok(word.endMs > word.startMs);
    assert.ok(word.startMs >= 1_000);
    assert.ok(word.endMs <= 5_000);
  }
  assert.equal(result.transcript.segments[0].text, 'Hello world.');
  assert.equal(result.warnings.length, 0);
});

test('parses WebVTT headers, cue settings, optional hours, and markup', () => {
  const result = parseManualTranscript({
    text: [
      'WEBVTT',
      'Kind: captions',
      '',
      'intro',
      '00:01.000 --> 00:02.500 align:start position:0%',
      '<b>Hello</b> <c.green>there</c>',
    ].join('\n'),
    format: 'vtt',
    durationMs: DURATION,
  });

  assert.equal(result.format, 'vtt');
  assert.equal(result.cueCount, 1);
  assert.equal(result.transcript.provider, 'manual-vtt');
  assert.deepEqual(result.transcript.words.map((word) => word.text), ['Hello', 'there']);
  assert.equal(result.startMs, 1_000);
  assert.ok(result.endMs <= 2_500);
});

test('skips invalid timestamp lines but keeps valid cues', () => {
  const result = parseManualTranscript({
    text: [
      '1',
      '00:00:xx,000 --> 00:00:02,000',
      'Broken',
      '',
      '2',
      '00:00:02,000 --> 00:00:04,000',
      'Good cue',
    ].join('\n'),
    durationMs: DURATION,
  });

  assert.equal(result.cueCount, 1);
  assert.equal(result.transcript.words[0].text, 'Good');
  assert.ok(result.warnings.some((warning) => warning.includes('timing line')));
});

test('rejects a transcript when no cue has a valid timestamp', () => {
  assert.throws(
    () =>
      parseManualTranscript({
        text: '1\n00:00:xx,000 --> 00:00:02,000\nBroken',
        durationMs: DURATION,
        format: 'srt',
      }),
    ManualTranscriptError,
  );
});

test('rejects SRT/VTT text with no timestamped cues', () => {
  assert.throws(
    () => parseManualTranscript({ text: 'This is just plain text', durationMs: DURATION, format: 'srt' }),
    /No timestamped cues/,
  );
});

test('normalizes overlapping cues into monotonic timings', () => {
  const result = parseManualTranscript({
    text: [
      '1',
      '00:00:01,000 --> 00:00:05,000',
      'First cue',
      '',
      '2',
      '00:00:03,000 --> 00:00:06,000',
      'Second cue',
    ].join('\n'),
    durationMs: DURATION,
  });

  assert.equal(result.cueCount, 2);
  assert.equal(result.transcript.segments[0].endMs, 5_000);
  assert.equal(result.transcript.segments[1].startMs, 5_000);
  assert.ok(result.warnings.some((warning) => warning.includes('overlapping')));
  assert.ok(result.transcript.words[2].startMs >= 5_000);
});

test('clamps cue ends to the video duration and skips out-of-range cues', () => {
  const result = parseManualTranscript({
    text: [
      '1',
      '00:00:04,000 --> 00:00:08,000',
      'Clamped cue',
      '',
      '2',
      '00:00:10,000 --> 00:00:12,000',
      'Outside cue',
    ].join('\n'),
    durationMs: 5_000,
  });

  assert.equal(result.cueCount, 1);
  assert.equal(result.endMs, 5_000);
  assert.ok(result.warnings.some((warning) => warning.includes('clamped')));
  assert.ok(result.warnings.some((warning) => warning.includes('skipped')));
});

test('rejects a transcript whose timestamps are all outside the video', () => {
  assert.throws(
    () =>
      parseManualTranscript({
        text: '1\n00:00:10,000 --> 00:00:12,000\nOutside',
        durationMs: 5_000,
      }),
    /No cue timestamps fall inside/,
  );
});

test('handles long videos and three-digit hours without losing timestamps', () => {
  const eightHours = 8 * 60 * 60 * 1_000;
  const result = parseManualTranscript({
    text: [
      '1',
      '07:59:59,000 --> 08:00:00,000',
      'The final second.',
    ].join('\n'),
    durationMs: eightHours,
  });

  assert.equal(result.startMs, (7 * 3600 + 59 * 60 + 59) * 1000);
  assert.equal(result.endMs, eightHours);
  assert.equal(result.wordCount, 3);
});

test('distributes plain text across the full video and warns that timing is estimated', () => {
  const result = parseManualTranscript({
    filename: 'notes.txt',
    durationMs: 10_000,
    text: 'One two. Three four.',
  });

  assert.equal(result.format, 'txt');
  assert.equal(result.transcript.provider, 'manual-txt');
  assert.equal(result.transcript.timing, 'estimated');
  assert.equal(result.wordCount, 4);
  assert.equal(result.startMs, 0);
  assert.ok(result.endMs <= 10_000);
  assert.ok(result.warnings.some((warning) => warning.includes('no timestamps')));
  assert.ok(result.transcript.words[1].startMs >= result.transcript.words[0].startMs);
});

test('plain text requires a known video duration', () => {
  assert.throws(
    () => parseManualTranscript({ filename: 'notes.txt', text: 'No timing here' }),
    /duration is required/,
  );
});

test('recognizes supported transcript filenames and rejects others', () => {
  assert.equal(formatFromFilename('captions.SRT'), 'srt');
  assert.equal(formatFromFilename('captions.vtt'), 'vtt');
  assert.equal(formatFromFilename('captions.txt'), 'txt');
  assert.equal(formatFromFilename('captions.json'), null);
});
