import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { buildEditPlan } from '../src/lib/edit/plan';
import { probeMedia, renderEditedClip } from '../src/lib/media/ffmpeg';
import type { MediaSignals } from '../src/lib/media/signals';
import type { TimedWord } from '../src/lib/types';

/**
 * Renders through the real FFmpeg effect pipeline (trim pieces, concat, nine-by
 * sixteen reframe, zoompan and slow-motion timestretch) to prove the planner's
 * decisions actually reach the exported file.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-effects-'));
const ffmpeg = ffmpegPath as unknown as string;

function makeSource(destination: string, seconds: number): void {
  execFileSync(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=320:sample_rate=48000',
      '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      destination,
    ],
    { stdio: 'pipe' },
  );
}

const words: TimedWord[] = [
  { text: 'Here', startMs: 200, endMs: 500 },
  { text: 'is', startMs: 500, endMs: 700 },
  { text: 'the', startMs: 700, endMs: 900 },
  { text: 'point', startMs: 900, endMs: 1_400 },
  { text: 'it', startMs: 4_600, endMs: 4_800 },
  { text: 'was', startMs: 4_800, endMs: 5_000 },
  { text: 'unbelievable', startMs: 5_000, endMs: 5_600 },
];

const withScene: MediaSignals = {
  audio: [{ tMs: 5_000, rms: -18 }],
  peaksMs: [5_000],
  sceneChangesMs: [5_100],
  source: { audio: true, visual: true },
};

const noVisual: MediaSignals = { ...withScene, sceneChangesMs: [], source: { audio: true, visual: false } };

function render(name: string, plan: ReturnType<typeof buildEditPlan>) {
  const workDir = path.join(tmpRoot, `${name}-work`);
  fs.mkdirSync(workDir, { recursive: true });
  const outputPath = path.join(tmpRoot, `${name}.mp4`);
  return renderEditedClip(
    {
      sourcePath: path.join(tmpRoot, 'source.mp4'),
      outputPath,
      plan,
      sourceWidth: 1280,
      sourceHeight: 720,
      hasAudio: true,
      workDir,
    },
    null,
  ).then((result) => ({ result, outputPath }));
}

test('slow motion is rendered into the MP4 and lengthens the export', async () => {
  makeSource(path.join(tmpRoot, 'source.mp4'), 6.5);

  const plain = buildEditPlan({
    words,
    startMs: 0,
    endMs: 6_500,
    options: { zoomEnabled: false, slowMotionEnabled: false },
    signals: noVisual,
  });
  const slowed = buildEditPlan({
    words,
    startMs: 0,
    endMs: 6_500,
    options: { zoomEnabled: false, slowMotionEnabled: true },
    signals: withScene,
  });

  assert.equal(plain.slowMotion.length, 0);
  assert.equal(slowed.slowMotion.length, 1);

  const plainRender = await render('plain', plain);
  const slowedRender = await render('slowed', slowed);

  const plainProbe = await probeMedia(plainRender.outputPath);
  const slowedProbe = await probeMedia(slowedRender.outputPath);

  assert.equal(plainProbe.width, 1080);
  assert.equal(plainProbe.height, 1920);
  assert.equal(slowedProbe.width, 1080);
  assert.equal(slowedProbe.height, 1920);
  assert.equal(slowedProbe.hasAudio, true, 'slow motion must keep audio');

  assert.ok(
    slowedProbe.durationMs >= plainProbe.durationMs + 900,
    `slow motion should add time: plain ${plainProbe.durationMs}ms vs slowed ${slowedProbe.durationMs}ms`,
  );
  assert.ok(
    Math.abs(slowedProbe.durationMs - slowed.outputDurationMs) < 600,
    `rendered duration ${slowedProbe.durationMs}ms should match the plan ${slowed.outputDurationMs}ms`,
  );
});

test('zoom stays inside the frame and produces a valid export', async () => {
  makeSource(path.join(tmpRoot, 'zoom-source.mp4'), 6.5);
  const zoomPlan = buildEditPlan({
    words: [
      { text: 'We', startMs: 200, endMs: 400 },
      { text: 'measured', startMs: 400, endMs: 800 },
      { text: '42', startMs: 800, endMs: 1_200 },
      { text: 'percent', startMs: 1_200, endMs: 1_700 },
    ],
    startMs: 0,
    endMs: 6_500,
    options: { zoomEnabled: true, zoomIntensity: 2, slowMotionEnabled: false },
    signals: noVisual,
  });
  assert.ok(zoomPlan.zooms.length >= 1, 'a measured number should trigger a punch-in');
  assert.ok(zoomPlan.zooms[0].scale > 1.09, 'intensity 2 should produce a stronger punch-in');

  const workDir = path.join(tmpRoot, 'zoom-work');
  fs.mkdirSync(workDir, { recursive: true });
  const outputPath = path.join(tmpRoot, 'zoom.mp4');
  const result = await renderEditedClip(
    {
      sourcePath: path.join(tmpRoot, 'zoom-source.mp4'),
      outputPath,
      plan: zoomPlan,
      sourceWidth: 1280,
      sourceHeight: 720,
      hasAudio: true,
      workDir,
    },
    null,
  );

  const probe = await probeMedia(outputPath);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.ok(probe.durationMs > 1_000);
  assert.ok(fs.statSync(outputPath).size > 50_000);
  assert.ok(Math.abs(probe.durationMs - zoomPlan.outputDurationMs) < 600);
});
