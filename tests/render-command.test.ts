import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { buildClipRenderArgs } from '../src/lib/browser/render-command';
import { buildEditPlan } from '../src/lib/edit/plan';
import { probeMedia } from '../src/lib/media/ffmpeg';
import type { TimedWord } from '../src/lib/types';

/**
 * The browser renderer now seeks each edit piece at the input with `-ss`.
 * These tests run the generated command through real FFmpeg, because a broken
 * seek would silently render the opening seconds of a long video instead of the
 * selected moment.
 */

const ffmpeg = ffmpegPath as unknown as string;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-seek-'));

function makeSource(destination: string, fps = 30): void {
  execFileSync(
    ffmpeg,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${fps}:duration=12`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-filter_complex', '[1:a][2:a]concat=n=2:v=0:a=1[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-t', '12',
      destination,
    ],
    { stdio: 'pipe' },
  );
}

const sourcePath = path.join(tmpRoot, 'source.mp4');
makeSource(sourcePath);
const source24Path = path.join(tmpRoot, 'source-24fps.mp4');
makeSource(source24Path, 24);

const words: TimedWord[] = [
  { text: 'here', startMs: 8_200, endMs: 8_400 },
  { text: 'is', startMs: 8_400, endMs: 8_600 },
  { text: 'the', startMs: 8_600, endMs: 8_800 },
  { text: 'moment', startMs: 8_800, endMs: 9_300 },
  { text: 'that', startMs: 10_500, endMs: 10_700 },
  { text: 'matters', startMs: 10_700, endMs: 11_100 },
  { text: 'most', startMs: 11_100, endMs: 11_500 },
];

function planFor(clipWords: TimedWord[], startMs: number, endMs: number) {
  return buildEditPlan({
    words: clipWords,
    startMs,
    endMs,
    options: { zoomEnabled: false, slowMotionEnabled: false },
  });
}

test('every edit piece is an input-seeked source; later moments do not decode from zero', () => {
  const plan = planFor(words, 8_000, 12_000);
  assert.equal(plan.pieces.length, 2, 'the 1.2s pause should split the clip into two pieces');

  const args = buildClipRenderArgs({
    plan,
    sourceWidth: 320,
    sourceHeight: 180,
    source: 'input.mp4',
    output: 'clip.mp4',
    captionFile: null,
  });

  assert.equal(args.filter((arg) => arg === '-i').length, plan.pieces.length);
  assert.equal(args.filter((arg) => arg === '-ss').length, plan.pieces.length);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes('concat=n=2:v=1:a=1[vcat][acat]'));
  for (const piece of plan.pieces) {
    const seek = (piece.srcStartMs / 1000).toFixed(3);
    const index = args.indexOf(seek);
    assert.ok(index > 0 && args[index - 1] === '-ss', `piece at ${seek}s must be seeked`);
    assert.ok(args.indexOf('-i', index) > index, 'the seek must be an input option');
  }
});

test('a clip near the end of a long source renders the selected audio, not the opening silence', () => {
  const plan = planFor(words, 8_000, 12_000);
  const outputPath = path.join(tmpRoot, 'end-clip.mp4');
  const args = buildClipRenderArgs({
    plan,
    sourceWidth: 320,
    sourceHeight: 180,
    source: sourcePath,
    output: outputPath,
    captionFile: null,
  });

  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });
  const probe = spawnSync(
    ffmpeg,
    ['-hide_banner', '-i', outputPath, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(probe.stderr);
  assert.ok(mean, `volumedetect should report a level: ${probe.stderr.slice(-400)}`);
  assert.ok(
    Number(mean[1]) > -35,
    `expected the 440 Hz tone from 8s onward, got mean volume ${mean[1]} dB`,
  );
});

test('subject-following framing and camera moves reach FFmpeg together', async () => {
  const plan = buildEditPlan({
    words,
    startMs: 8_000,
    endMs: 12_000,
    options: { zoomEnabled: true, slowMotionEnabled: false },
    signals: {
      audio: [{ tMs: 9_000, rms: -18 }],
      peaksMs: [9_000, 10_800],
      sceneChangesMs: [],
      source: { audio: true, visual: false },
    },
    framing: {
      startX: -0.3,
      endX: 0.3,
      confidence: 0.8,
      strategy: 'subject-following',
      samples: 4,
    },
  });
  assert.ok(plan.zooms.length > 0, 'the emphasis words should still earn a camera move');
  const outputPath = path.join(tmpRoot, 'framed-clip.mp4');
  const args = buildClipRenderArgs({
    plan,
    sourceWidth: 320,
    sourceHeight: 180,
    source: sourcePath,
    output: outputPath,
    captionFile: null,
  });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /crop=\d+:\d+:'[^']*clip\(t\//);
  assert.match(graph, /crop=\d+:\d+:'[^']*clip\(t\//);
  assert.match(graph, /zoompan=/);

  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });
  const probe = await probeMedia(outputPath);
  assert.equal(probe.width, 1080);
  assert.equal(probe.height, 1920);
  assert.equal(probe.hasAudio, true);
  assert.ok(Math.abs(probe.durationMs - plan.outputDurationMs) < 600);
  assert.ok(
    Math.abs(probe.videoDurationMs - plan.outputDurationMs) < 600,
    `video track ${probe.videoDurationMs}ms should match the plan ${plan.outputDurationMs}ms`,
  );
});

test('camera moves preserve the video track duration on a 24 fps source', async () => {
  const plan = buildEditPlan({
    words,
    startMs: 8_000,
    endMs: 12_000,
    options: { zoomEnabled: true, slowMotionEnabled: false },
    signals: {
      audio: [{ tMs: 9_000, rms: -18 }],
      peaksMs: [9_000, 10_800],
      sceneChangesMs: [],
      source: { audio: true, visual: false },
    },
    framing: {
      startX: -0.3,
      endX: 0.3,
      confidence: 0.8,
      strategy: 'subject-following',
      samples: 4,
    },
  });
  assert.ok(plan.zooms.length > 0, 'the emphasis words should earn a camera move');

  const outputPath = path.join(tmpRoot, '24fps-camera-move.mp4');
  const args = buildClipRenderArgs({
    plan,
    sourceWidth: 320,
    sourceHeight: 180,
    source: source24Path,
    output: outputPath,
    captionFile: null,
  });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });

  const probe = await probeMedia(outputPath);
  assert.ok(
    Math.abs(probe.videoDurationMs - plan.outputDurationMs) < 700,
    `24 fps camera-move video track was ${probe.videoDurationMs}ms, expected ${plan.outputDurationMs}ms`,
  );
  assert.ok(
    Math.abs(probe.durationMs - plan.outputDurationMs) < 700,
    `24 fps camera-move container was ${probe.durationMs}ms, expected ${plan.outputDurationMs}ms`,
  );
});

test('input-seeked renders keep the planned duration and 9:16 output', async () => {
  const plan = planFor(words, 8_000, 12_000);
  const outputPath = path.join(tmpRoot, 'duration-clip.mp4');
  const args = buildClipRenderArgs({
    plan,
    sourceWidth: 320,
    sourceHeight: 180,
    source: sourcePath,
    output: outputPath,
    captionFile: null,
  });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });

  const probe = await probeMedia(outputPath);
  assert.equal(probe.width, 1080);
  assert.equal(probe.height, 1920);
  assert.equal(probe.hasAudio, true);
  assert.ok(
    Math.abs(probe.durationMs - plan.outputDurationMs) < 500,
    `rendered ${probe.durationMs}ms should match planned ${plan.outputDurationMs}ms`,
  );
});
