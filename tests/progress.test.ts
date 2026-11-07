import test from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_STAGES, progressFor } from '../src/lib/stages';

test('stage boundaries form one continuous 0-100 overall timeline', () => {
  assert.equal(PIPELINE_STAGES.reduce((total, stage) => total + stage.weight, 0), 100);
  assert.equal(progressFor('probe', 0), 0);
  assert.equal(progressFor('probe', 1), 5);
  assert.equal(progressFor('audio', 1), 15);
  assert.equal(progressFor('transcribe', 1), 50);
  assert.equal(progressFor('select', 1), 65);
  assert.equal(progressFor('render', 0), 65);
  assert.equal(progressFor('render', 1), 100);
});

test('clip progress is weighted, not a raw per-stage percentage', () => {
  const total = 8;
  const firstClipMid = progressFor('render', (0 + 0.5) / total);
  const sixthClipDone = progressFor('render', 6 / total);
  const seventhClipStart = progressFor('render', 6 / total);

  assert.equal(firstClipMid, 67);
  assert.equal(sixthClipDone, 91);
  assert.equal(seventhClipStart, 91);
  assert.ok(sixthClipDone > firstClipMid);
});

test('a resumed run starts at the rendered-clip boundary', () => {
  assert.equal(progressFor('render', 6 / 8), 91);
  assert.equal(progressFor('render', 7 / 8), 96);
  assert.equal(progressFor('render', 8 / 8), 100);
});