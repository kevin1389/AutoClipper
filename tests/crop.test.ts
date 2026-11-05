import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerticalFilter } from '../src/lib/media/crop';
import type { ClipFraming } from '../src/lib/types';

function framing(startX: number, endX: number, confidence = 0.7): ClipFraming {
  return { startX, endX, confidence, strategy: 'subject-following', samples: 6 };
}

function aspect(plan: ReturnType<typeof buildVerticalFilter>): number {
  return plan.cropWidth / plan.cropHeight;
}

test('landscape 16:9 is cropped to 9:16 with full height', () => {
  const plan = buildVerticalFilter({ width: 1920, height: 1080 });
  assert.equal(plan.strategy, 'crop-center');
  assert.equal(plan.cropHeight, 1080);
  assert.ok(plan.cropWidth <= 1920);
  assert.ok(Math.abs(aspect(plan) - 9 / 16) < 0.01);
  assert.match(plan.filter, /^crop=\d+:\d+:\d+:\d+,scale=1080:1920/);
  assert.equal(plan.cropWidth % 2, 0);
  assert.equal(plan.cropHeight % 2, 0);
});

test('square source is cropped, not stretched', () => {
  const plan = buildVerticalFilter({ width: 1080, height: 1080 });
  assert.equal(plan.strategy, 'crop-center');
  assert.equal(plan.cropHeight, 1080);
  assert.ok(Math.abs(aspect(plan) - 9 / 16) < 0.01);
});

test('already vertical source only scales', () => {
  const plan = buildVerticalFilter({ width: 1080, height: 1920 });
  assert.equal(plan.strategy, 'scale');
  assert.equal(plan.cropWidth, 1080);
  assert.equal(plan.cropHeight, 1920);
  assert.doesNotMatch(plan.filter, /crop=/);
  assert.match(plan.filter, /scale=1080:1920/);
});

test('ultra-tall source crops height and stays in bounds', () => {
  const plan = buildVerticalFilter({ width: 720, height: 1600 });
  assert.equal(plan.strategy, 'crop-center');
  assert.equal(plan.cropWidth, 720);
  assert.ok(plan.cropHeight <= 1600);
  assert.ok(plan.offsetY >= 0);
  assert.ok(plan.offsetY + plan.cropHeight <= 1600);
});

test('crop offsets stay inside the frame for wide sources', () => {
  const plan = buildVerticalFilter({ width: 3840, height: 2160 });
  assert.ok(plan.offsetX >= 0);
  assert.ok(plan.offsetX + plan.cropWidth <= 3840);
});

test('subject-aware framing follows a confident off-centre subject', () => {
  const plan = buildVerticalFilter(
    { width: 1920, height: 1080 },
    { framing: framing(-0.6, -0.6) },
  );
  const centre = buildVerticalFilter({ width: 1920, height: 1080 });
  assert.equal(plan.strategy, 'crop-subject');
  assert.ok(plan.offsetX < centre.offsetX, 'subject left of centre should crop left');
  assert.ok(plan.offsetX >= 0 && plan.offsetX + plan.cropWidth <= 1920);
});

test('a moving subject produces a smooth animated crop that stays in bounds', () => {
  const plan = buildVerticalFilter(
    { width: 1920, height: 1080 },
    { framing: framing(-0.4, 0.4), durationMs: 6_000 },
  );
  assert.equal(plan.strategy, 'crop-subject');
  assert.equal(plan.animated, true);
  assert.match(plan.filter, /crop=\d+:\d+:'[^']*clip\(t\//);
  assert.match(plan.filter, /scale=1080:1920/);
});

test('low-confidence or centre framing remains a stable centre crop', () => {
  const plan = buildVerticalFilter(
    { width: 1920, height: 1080 },
    { framing: framing(-0.6, 0.6, 0.05), durationMs: 6_000 },
  );
  assert.equal(plan.strategy, 'crop-center');
  assert.equal(plan.animated, false);
  assert.doesNotMatch(plan.filter, /clip\(t\//);
});
