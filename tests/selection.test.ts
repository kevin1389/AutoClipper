import test from 'node:test';
import assert from 'node:assert/strict';
import { selectHighlightsHeuristically } from '../src/lib/ai/heuristic';
import { buildSentences } from '../src/lib/ai/select-utils';
import type { MediaSignals } from '../src/lib/media/signals';
import type { TimedWord } from '../src/lib/types';

const HOOKS = [
  'Here is the biggest mistake I see people make when they start clipping long videos.',
  'The truth is nobody tells you how long a render actually takes when you batch them.',
  'Why do most creators quit after ten videos? The feedback loop is just too slow.',
  'What if you could turn one recording into a week of content without editing it by hand?',
];
const FILLER = [
  'So we were talking about the timeline and how it moves when you drag the clip.',
  'And then the audio drifted a little and we had to nudge it back into place.',
];

function buildTranscript(): { words: TimedWord[]; signals: MediaSignals } {
  return buildTranscriptOf(60);
}

function buildTranscriptOf(sentenceCount: number): { words: TimedWord[]; signals: MediaSignals } {
  const words: TimedWord[] = [];
  let cursor = 0;
  const peaks: number[] = [];
  const scenes: number[] = [];

  for (let index = 0; index < sentenceCount; index += 1) {
    const base = index % 4 === 0 ? HOOKS[index % HOOKS.length] : FILLER[index % FILLER.length];
    // A real 45-minute talk is not 900 copies of four sentences. Unique detail
    // lets the diversity gate distinguish a long recording from repeated filler.
    const sentence = `${base.replace(/[.!?]+$/, '')} Example ${index + 1} covers detail ${index * 7 + 3}.`;
    const tokens = sentence.split(' ');
    const sentenceStart = cursor;
    for (const token of tokens) {
      words.push({ text: token, startMs: cursor, endMs: cursor + 260 });
      cursor += 300;
    }
    if (index % 4 === 0) {
      peaks.push(sentenceStart + 600);
      scenes.push(sentenceStart + 400, sentenceStart + 1_800);
    }
    cursor += 700; // natural pause between sentences
  }

  return {
    words,
    signals: {
      audio: peaks.map((tMs) => ({ tMs, rms: -18 })),
      peaksMs: peaks,
      sceneChangesMs: scenes,
      source: { audio: true, visual: true },
    },
  };
}

test('selection returns 5-10 explainable, non-overlapping clips from a long transcript', () => {
  const { words, signals } = buildTranscript();
  const durationMs = words[words.length - 1].endMs + 1_000;
  const clips = selectHighlightsHeuristically({
    words,
    segments: [],
    durationMs,
    targetCount: 8,
    signals,
  });

  assert.ok(clips.length >= 5 && clips.length <= 10, `expected 5-10 clips, got ${clips.length}`);
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    assert.ok(clip.endMs > clip.startMs);
    assert.ok(clip.title.length > 3, 'titles come from the transcript');
    assert.ok(clip.reason.length > 0, 'every clip explains itself');
    assert.ok(clip.scoreBreakdown, 'score breakdown must be persisted');
    assert.ok((clip.scoreBreakdown?.total ?? 0) > 0);
    assert.ok((clip.scoreBreakdown?.hook ?? 0) <= 1 && (clip.scoreBreakdown?.payoff ?? 0) <= 1);
    assert.ok((clip.evidence?.length ?? 0) > 0, 'clips must cite the evidence that selected them');
    if (index > 0) {
      assert.ok(clip.startMs >= clips[index - 1].endMs, 'clips must not overlap');
    }
  }
});

test('strong hooks outrank filler of the same length', () => {
  const { words, signals } = buildTranscript();
  const durationMs = words[words.length - 1].endMs + 1_000;
  const clips = selectHighlightsHeuristically({ words, segments: [], durationMs, targetCount: 8, signals });
  const best = [...clips].sort((a, b) => (b.scoreBreakdown?.total ?? 0) - (a.scoreBreakdown?.total ?? 0))[0];
  assert.ok((best.scoreBreakdown?.hook ?? 0) >= 0.3, 'the strongest clip should open with a real hook');
});

test('no speech means no clips, and a short video is never over-filled', () => {
  assert.deepEqual(
    selectHighlightsHeuristically({ words: [], segments: [], durationMs: 60_000, targetCount: 8 }),
    [],
  );

  const words: TimedWord[] = [];
  for (let index = 0; index < 40; index += 1) {
    words.push({ text: 'word', startMs: index * 300, endMs: index * 300 + 240 });
  }
  const clips = selectHighlightsHeuristically({
    words,
    segments: [],
    durationMs: 12_000,
    targetCount: 8,
  });
  assert.ok(clips.length <= 1, 'a 12s source cannot produce eight clips');
});

/** ~45 minutes of continuous speech, the shape of one full-length upload. */
function buildFullLengthTranscript(): { words: TimedWord[]; durationMs: number; signals: MediaSignals } {
  const { words, signals } = buildTranscriptOf(900);
  return { words, durationMs: words[words.length - 1].endMs + 1_000, signals };
}

test('a full-length upload selects 8-10 clips, never the old two-clip cap', () => {
  const { words, durationMs, signals } = buildFullLengthTranscript();
  assert.ok(durationMs >= 44 * 60_000, 'fixture should be a full-length recording');

  const eight = selectHighlightsHeuristically({ words, segments: [], durationMs, targetCount: 8, signals });
  assert.equal(eight.length, 8);
  assert.ok(eight.length > 2, 'a long recording must not be capped at two clips');

  const ten = selectHighlightsHeuristically({ words, segments: [], durationMs, targetCount: 10, signals });
  assert.equal(ten.length, 10, 'the supported maximum is 10 clips from one recording');

  const five = selectHighlightsHeuristically({ words, segments: [], durationMs, targetCount: 5, signals });
  assert.equal(five.length, 5, 'a smaller target should still fill when enough moments exist');
});

test('a mid-sentence pause is not treated as a new thought', () => {
  const words: TimedWord[] = [
    { text: 'The', startMs: 0, endMs: 200 },
    { text: 'reason', startMs: 200, endMs: 500 },
    { text: 'this', startMs: 500, endMs: 700 },
    { text: 'matters', startMs: 700, endMs: 1_000 },
    // A thinking pause in the middle of the same sentence.
    { text: 'is', startMs: 1_700, endMs: 1_900 },
    { text: 'because', startMs: 1_900, endMs: 2_200 },
    { text: 'the', startMs: 2_200, endMs: 2_300 },
    { text: 'result', startMs: 2_300, endMs: 2_600 },
    { text: 'is', startMs: 2_600, endMs: 2_700 },
    { text: 'visible', startMs: 2_700, endMs: 3_100 },
    { text: 'immediately.', startMs: 3_100, endMs: 3_500 },
  ];
  const sentences = buildSentences(words, []);
  assert.equal(sentences.length, 1, 'the 700ms mid-sentence pause must not split the thought');
  assert.equal(sentences[0].terminal, true);
});

test('content type and quality evidence are attached to a funny moment', () => {
  const words: TimedWord[] = [];
  const sentence = "Here's the funniest thing I have seen all week because nobody expected the microphone to fall into the cake and everyone laughed. The whole room lost it.";
  const tokens = sentence.split(' ');
  tokens.forEach((token, index) => {
    words.push({ text: token, startMs: index * 300, endMs: index * 300 + 250 });
  });
  const clips = selectHighlightsHeuristically({
    words,
    segments: [],
    durationMs: tokens.length * 300 + 1_000,
    targetCount: 8,
  });
  assert.equal(clips.length, 1);
  assert.match(clips[0].reason, /Funny/i);
  assert.ok(clips[0].evidence?.some((item) => /funny|comedic/i.test(item)));
});

test('weak filler does not get padded to the target count', () => {
  const words: TimedWord[] = [];
  let cursor = 0;
  for (let index = 0; index < 45; index += 1) {
    const sentence = 'we kept talking about the same ordinary thing while the room stayed quiet and nothing changed at all.';
    for (const token of sentence.split(' ')) {
      words.push({ text: token, startMs: cursor, endMs: cursor + 250 });
      cursor += 300;
    }
    cursor += 900;
  }
  const clips = selectHighlightsHeuristically({
    words,
    segments: [],
    durationMs: cursor + 1_000,
    targetCount: 10,
  });
  assert.ok(clips.length < 5, `weak filler should not be padded, got ${clips.length}`);
  for (const clip of clips) {
    assert.ok((clip.scoreBreakdown?.total ?? 0) >= 0.3, 'any fallback still has to be labelled and explainable');
  }
});

test('a short source with speech still yields one clearly labelled fallback clip', () => {
  const words: TimedWord[] = [];
  for (let index = 0; index < 28; index += 1) {
    words.push({ text: index === 0 ? 'Here' : 'word', startMs: index * 300, endMs: index * 300 + 240 });
  }
  const clips = selectHighlightsHeuristically({
    words,
    segments: [],
    durationMs: 9_000,
    targetCount: 8,
  });
  assert.equal(clips.length, 1, 'a short source must not be rejected entirely');
  assert.match(clips[0].reason, /Best available coherent moment/i);
});

test('two full-length uploads are independent: there is no daily clip quota', () => {
  const first = buildFullLengthTranscript();
  const second = buildFullLengthTranscript();
  const firstClips = selectHighlightsHeuristically({
    words: first.words,
    segments: [],
    durationMs: first.durationMs,
    targetCount: 8,
    signals: first.signals,
  });
  const secondClips = selectHighlightsHeuristically({
    words: second.words,
    segments: [],
    durationMs: second.durationMs,
    targetCount: 8,
    signals: second.signals,
  });

  assert.equal(firstClips.length, 8);
  assert.equal(secondClips.length, 8);
  const total = firstClips.length + secondClips.length;
  assert.equal(total, 16, 'two uploads in a day should yield their full sets, not a shared quota');
});
