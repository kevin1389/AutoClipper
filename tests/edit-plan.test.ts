import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEditPlan,
  buildZoomExpression,
  distributeCaptionText,
  emphasisScore,
} from '../src/lib/edit/plan';
import type { MediaSignals } from '../src/lib/media/signals';
import type { TimedWord } from '../src/lib/types';

function makeWords(entries: [string, number, number][]): TimedWord[] {
  return entries.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
}

const noSignals: MediaSignals = {
  audio: [],
  peaksMs: [],
  sceneChangesMs: [],
  source: { audio: false, visual: false },
};

const spacedWords = makeWords([
  ['Here', 200, 500],
  ['is', 500, 700],
  ['the', 700, 900],
  ['point', 900, 1_400],
  ['and', 4_200, 4_500],
  ['that', 4_500, 4_800],
  ['worked', 4_800, 5_300],
]);

test('long pauses are cut and the timeline maps captions into the edited clock', () => {
  const plan = buildEditPlan({ words: spacedWords, startMs: 0, endMs: 5_600, signals: noSignals });

  assert.equal(plan.pieces.length, 2, 'a 2.8s pause should split the clip into two pieces');
  assert.ok(plan.removedPauses.length === 1);
  const removed = plan.removedPauses[0].endMs - plan.removedPauses[0].startMs;
  assert.ok(removed > 2_000, `expected to remove most of the pause, removed ${removed}ms`);
  assert.ok(plan.outputDurationMs < 5_600 - 2_000, 'output must be shorter than the source range');
  assert.ok(plan.outputDurationMs > 2_000);

  const secondGroup = plan.captionWords.filter((word) => ['and', 'that', 'worked'].includes(word.text));
  assert.equal(secondGroup.length, 3);
  assert.ok(secondGroup[0].startMs < 2_000, 'captions after the cut must follow the edited clock');
  assert.ok(
    secondGroup[2].endMs <= plan.outputDurationMs,
    'no caption may point past the end of the edited clip',
  );
});

test('zooms are placed on emphasis words, scaled by intensity and kept inside the clip', () => {
  const plan = buildEditPlan({
    words: spacedWords,
    startMs: 0,
    endMs: 5_600,
    options: { zoomEnabled: true, zoomIntensity: 1.5 },
    signals: { ...noSignals, peaksMs: [1_000] },
  });

  assert.ok(plan.zooms.length >= 1, 'a number and an audio peak should earn a punch-in');
  for (const zoom of plan.zooms) {
    assert.ok(zoom.startMs >= 0 && zoom.endMs <= plan.outputDurationMs);
    assert.ok(zoom.scale > 1.05 && zoom.scale <= 1.075, `unexpected scale ${zoom.scale}`);
    assert.ok(zoom.endMs - zoom.startMs >= 700);
  }
  assert.match(plan.effectsSummary.join(' '), /punch-in/);

  const expression = buildZoomExpression(plan.zooms);
  assert.match(expression, /clip\(\(it-/);
  assert.match(expression, /^min\(1\.15,1\+/);
});

test('disabling zooms or slow motion removes those effects entirely', () => {
  const plan = buildEditPlan({
    words: spacedWords,
    startMs: 0,
    endMs: 5_600,
    options: { zoomEnabled: false, slowMotionEnabled: false },
    signals: { ...noSignals, peaksMs: [1_000], sceneChangesMs: [1_000] },
  });
  assert.equal(plan.zooms.length, 0);
  assert.equal(plan.slowMotion.length, 0);
});

test('slow motion requires a real visual change, not just emphasis', () => {
  const payoffWords = makeWords([
    ['It', 7_000, 7_200],
    ['was', 7_200, 7_400],
    ['unbelievable', 7_400, 8_000],
    ['when', 8_000, 8_200],
    ['it', 8_200, 8_400],
    ['landed', 8_400, 8_900],
  ]);
  const withScene = buildEditPlan({
    words: payoffWords,
    startMs: 0,
    endMs: 9_500,
    signals: { ...noSignals, peaksMs: [7_600], sceneChangesMs: [7_500], source: { audio: true, visual: true } },
  });
  assert.equal(withScene.slowMotion.length, 1, 'scene change + peak + emphasis should allow one slow window');
  assert.equal(withScene.slowMotion[0].speed, 0.55);

  const withoutScene = buildEditPlan({
    words: payoffWords,
    startMs: 0,
    endMs: 9_500,
    signals: { ...noSignals, peaksMs: [7_600], source: { audio: true, visual: false } },
  });
  assert.equal(withoutScene.slowMotion.length, 0, 'no visual evidence means no slow motion');
  assert.ok(
    withScene.outputDurationMs > withoutScene.outputDurationMs + 1_000,
    'slow motion must lengthen the edited clip by the stretched window',
  );
  assert.ok(withScene.outputDurationMs <= 9_500, 'slow motion must never exceed the source range');
});

test('custom caption text is distributed across the edited duration', () => {
  const plan = buildEditPlan({
    words: spacedWords,
    startMs: 0,
    endMs: 5_600,
    options: { captionText: 'Nobody tells you how slow rendering really is' },
    signals: noSignals,
  });
  assert.equal(plan.captionWords.length, 8);
  assert.equal(plan.captionWords[0].startMs, 0);
  assert.ok(plan.captionWords[7].endMs <= plan.outputDurationMs);
  assert.match(plan.effectsSummary.join(' '), /custom caption text/i);
});

test('emphasis scoring is deterministic and explainable', () => {
  assert.ok(emphasisScore('42') >= 0.7);
  assert.ok(emphasisScore('NEVER') >= 0.7);
  assert.ok(emphasisScore('unbelievable') >= 0.7);
  assert.equal(emphasisScore('the'), 0);
  assert.deepEqual(distributeCaptionText('a b', 1_000).map((word) => word.startMs), [0, 500]);
});
