import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscriptPrompt, createLlmSelector } from '../src/lib/ai/selector-llm';
import type { SelectionInput } from '../src/lib/ai/types';
import type { TimedWord } from '../src/lib/types';

function timed(sentence: string, startMs: number): TimedWord[] {
  return sentence.split(' ').map((text, index) => ({
    text,
    startMs: startMs + index * 300,
    endMs: startMs + index * 300 + 260,
  }));
}

test('a long transcript prompt samples the whole recording instead of truncating early', () => {
  const segments = Array.from({ length: 600 }, (_, index) => ({
    text: `Segment ${index} covers a distinct detail about the topic and its result.`,
    startMs: index * 2_000,
    endMs: index * 2_000 + 1_800,
  }));
  segments[segments.length - 1].text = 'END-MARKER: the final segment still reaches the model.';

  const prompt = buildTranscriptPrompt({
    words: [],
    segments,
    durationMs: 600 * 2_000,
    targetCount: 8,
  });

  assert.match(prompt, /sampled evenly across the full recording/i);
  assert.match(prompt, /END-MARKER/, 'the final segment must not be silently truncated');
  assert.match(prompt, /#0 /);
});

test('LLM choices are locally rescored and ranked instead of sharing one score', async () => {
  const strongSentence =
    'Here is the biggest mistake nobody tells you about clipping long videos because the opening three seconds decides whether anyone keeps watching, and that is why we always cut straight to the point and end with a clear result.';
  const secondSentence =
    'The truth is nobody tells you how long a render actually takes when you batch them, because the feedback loop is slower than you think, and that is why we changed our process and cut our render time in half.';
  const strongWords = timed(strongSentence, 0);
  const secondStart = strongWords[strongWords.length - 1].endMs + 4_000;
  const secondWords = timed(secondSentence, secondStart);
  const words = [...strongWords, ...secondWords];
  const input: SelectionInput = {
    words,
    segments: [
      { text: strongSentence, startMs: 0, endMs: strongWords[strongWords.length - 1].endMs },
      { text: secondSentence, startMs: secondStart, endMs: secondWords[secondWords.length - 1].endMs },
    ],
    durationMs: secondWords[secondWords.length - 1].endMs + 1_000,
    targetCount: 2,
  };

  const previousFetch = globalThis.fetch;
  const modelScores = {
    hook: 0.9,
    engagement: 0.9,
    clarity: 0.9,
    substance: 0.9,
    context: 0.9,
    payoff: 0.9,
    pacing: 0.9,
  };
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                clips: [
                  {
                    startSegment: 0,
                    endSegment: 0,
                    title: 'The mistake nobody mentions',
                    hook: 'Here is the biggest mistake nobody tells you',
                    reason: 'A direct hook and a complete explanation.',
                    scores: modelScores,
                  },
                  {
                    startSegment: 1,
                    endSegment: 1,
                    title: 'Why the feedback loop matters',
                    hook: 'The truth is nobody tells you how long a render takes',
                    reason: 'A clear explanation with a concrete payoff.',
                    scores: modelScores,
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  try {
    const selector = createLlmSelector({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      model: 'test-model',
    });
    const clips = await selector.select(input);

    assert.equal(clips.length, 2, 'both model-selected moments should survive');
    assert.equal(clips[0].score, clips[0].scoreBreakdown?.total, 'clip score must be explainable');
    assert.equal(clips[1].score, clips[1].scoreBreakdown?.total, 'clip score must be explainable');
    assert.ok(clips[0].score > clips[1].score, 'clips must be ranked by their local scores');
    assert.equal(new Set(clips.map((clip) => clip.score)).size, 2, 'each clip needs its own score');
    assert.equal(typeof clips[0].scoreBreakdown?.hook, 'number');
    assert.equal(typeof clips[1].scoreBreakdown?.hook, 'number');
    assert.equal(typeof clips[0].scoreBreakdown?.clarity, 'number');
    assert.equal(typeof clips[1].scoreBreakdown?.clarity, 'number');
    assert.notEqual(clips[0].score, 0.9, 'the old blanket model score must not be reused');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
