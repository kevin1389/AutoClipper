import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFrameFocus, planFraming, splitRawFrames } from '../src/lib/media/framing';

const WIDTH = 96;
const HEIGHT = 54;

function frameWithSubject(x0: number, x1: number): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 3;
      const inSubject = x >= x0 && x < x1 && y >= 10 && y < 44;
      if (inSubject) {
        rgb[index] = 198;
        rgb[index + 1] = 142;
        rgb[index + 2] = 108;
      } else {
        rgb[index] = 20;
        rgb[index + 1] = 36;
        rgb[index + 2] = 72;
      }
    }
  }
  return rgb;
}

test('a skin-toned subject on the left/right moves the estimated focus', () => {
  const left = analyzeFrameFocus(frameWithSubject(8, 30), WIDTH, HEIGHT);
  const right = analyzeFrameFocus(frameWithSubject(65, 88), WIDTH, HEIGHT);
  const centre = analyzeFrameFocus(frameWithSubject(38, 58), WIDTH, HEIGHT);

  assert.ok(left.x < -0.2, `expected left focus, got ${left.x}`);
  assert.ok(right.x > 0.2, `expected right focus, got ${right.x}`);
  assert.ok(Math.abs(centre.x) < 0.12, `expected centred focus, got ${centre.x}`);
  assert.ok(left.confidence > 0.1);
});

test('framing follows a moving subject and refuses to invent one from a blank frame', () => {
  const plan = planFraming([
    frameWithSubject(8, 30),
    frameWithSubject(8, 30),
    frameWithSubject(65, 88),
    frameWithSubject(65, 88),
  ]);
  assert.equal(plan.strategy, 'subject-following');
  assert.ok(plan.startX < 0 && plan.endX > 0, `expected a left-to-right move: ${plan.startX} → ${plan.endX}`);
  assert.ok(plan.confidence > 0.1);

  const blank = new Uint8Array(WIDTH * HEIGHT * 3).fill(40);
  const fallback = planFraming([blank, blank]);
  assert.equal(fallback.strategy, 'crop-center');
  assert.equal(fallback.startX, 0);
  assert.equal(fallback.endX, 0);
});

test('raw frames split on exact RGB24 boundaries', () => {
  const frame = frameWithSubject(8, 30);
  const frames = splitRawFrames(new Uint8Array([...frame, ...frame]), WIDTH, HEIGHT);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].byteLength, WIDTH * HEIGHT * 3);
});
