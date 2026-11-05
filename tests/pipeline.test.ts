import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import * as db from '../src/lib/db-sqlite';
import { createFixtureTranscriber } from '../src/lib/ai/fixture';
import { createHeuristicSelector } from '../src/lib/ai/heuristic';
import { PipelineError, runPipeline } from '../src/lib/pipeline';
import { probeMedia } from '../src/lib/media/ffmpeg';
import type { TranscriptionProvider } from '../src/lib/ai/types';
import { ProviderError } from '../src/lib/ai/types';

/**
 * Integration test for the real media pipeline: real FFmpeg source, real audio
 * extraction, real 9:16 render, real caption burn-in. Transcription is injected
 * with a fixture transcript (no network, no API credits); everything downstream
 * of it is the production code path.
 */

process.env.AC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-data-'));
process.env.AC_ALLOW_FIXTURE_TRANSCRIBER = '1';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-media-'));
const ffmpeg = ffmpegPath as unknown as string;

function makeSource(destination: string, seconds: number, withAudio = true): void {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30`];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=320:sample_rate=48000');
  args.push('-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push(destination);
  execFileSync(ffmpeg, args, { stdio: 'pipe' });
}

const SENTENCES = [
  'Here is the biggest mistake I see people make when they start clipping long videos.',
  'The truth is nobody tells you how long a render actually takes when you batch them.',
  'Why do most creators quit after ten videos? The feedback loop is just too slow.',
  'Let me tell you what happened when we tried to ship a short clip every single day.',
  'We measured 42 percent more watch time after switching to vertical framing and captions.',
  'What if you could turn one recording into a week of content without editing it by hand?',
  'The key is to start with the strongest sentence and cut everything before it lands.',
  'I remember the first time a clip went viral, it was completely unexpected for all of us.',
];

function buildFixture(destination: string, sentenceMs: number, totalSentences: number): void {
  const words: { text: string; startMs: number; endMs: number }[] = [];
  for (let index = 0; index < totalSentences; index += 1) {
    const sentence = SENTENCES[index % SENTENCES.length];
    const tokens = sentence.split(' ');
    const start = index * sentenceMs;
    const step = sentenceMs / tokens.length;
    tokens.forEach((token, tokenIndex) => {
      words.push({
        text: token,
        startMs: Math.round(start + tokenIndex * step),
        endMs: Math.round(start + (tokenIndex + 1) * step),
      });
    });
  }
  fs.writeFileSync(
    destination,
    JSON.stringify({ language: 'en', words }),
    'utf8',
  );
}

const TEST_OWNER = 'test-pipeline-owner';

async function createProjectWithSource(videoPath: string, title: string): Promise<string> {
  db.upsertUser({ id: TEST_OWNER, email: null, name: 'Pipeline Test', picture: null });
  const id = randomUUID();
  const base = path.join(process.env.AC_DATA_DIR as string, 'projects', id, 'source');
  await fsp.mkdir(base, { recursive: true });
  const sourcePath = path.join(base, 'input.mp4');
  await fsp.copyFile(videoPath, sourcePath);
  db.createProject({
    id,
    ownerId: TEST_OWNER,
    title,
    sourceKind: 'upload',
    sourcePath,
    sourceFileName: 'input.mp4',
    sourceBytes: fs.statSync(sourcePath).size,
    status: 'ready',
  });
  return id;
}

test('runs the full pipeline and produces real 1080x1920 MP4 files', async () => {
  const videoPath = path.join(tmpRoot, 'source.mp4');
  makeSource(videoPath, 96);

  const fixturePath = path.join(tmpRoot, 'transcript.json');
  buildFixture(fixturePath, 2_400, 40); // 96 seconds of speech

  const projectId = await createProjectWithSource(videoPath, 'Pipeline integration test');
  const stages: string[] = [];

  const result = await runPipeline({
    projectId,
    transcribe: createFixtureTranscriber(fixturePath),
    select: createHeuristicSelector(),
    onProgress: (update) => {
      if (stages[stages.length - 1] !== update.stage) stages.push(update.stage);
    },
  });

  assert.ok(result.clipCount >= 1 && result.clipCount <= 10);
  assert.equal(result.renderedCount, result.clipCount);
  assert.equal(result.failedClips, 0);
  assert.deepEqual(stages, ['probe', 'audio', 'transcribe', 'select', 'render']);

  const project = db.getProject(projectId);
  assert.equal(project?.status, 'completed');
  assert.equal(project?.progress, 100);
  assert.equal(project?.durationMs !== null, true);
  assert.ok(project?.transcriptionProvider?.startsWith('fixture'));

  const transcript = db.getTranscript(projectId);
  assert.ok(transcript);
  assert.ok((transcript?.words.length ?? 0) > 100);

  const clips = db.getClips(projectId);
  assert.equal(clips.length, result.clipCount);

  for (const clip of clips) {
    assert.equal(clip.status, 'rendered', `clip ${clip.index} failed: ${clip.error ?? ''}`);
    const detailed = db.getClip(clip.id);
    assert.ok(detailed?.filePath);
    const stat = await fsp.stat(detailed!.filePath!);
    assert.ok(stat.size > 50_000, 'rendered clip should have real bytes');

    const probe = await probeMedia(detailed!.filePath!);
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
    assert.equal(probe.hasAudio, true);
    assert.ok(clip.effects, 'clip should record the effects that were applied');
    const expected = clip.effects?.outputDurationMs ?? clip.endMs - clip.startMs;
    assert.ok(
      Math.abs(probe.durationMs - expected) < 2_000,
      `duration ${probe.durationMs}ms should be close to the edited ${expected}ms`,
    );
    assert.ok(
      probe.durationMs <= clip.endMs - clip.startMs + 1_000,
      'editing must not make a clip longer than its source range',
    );

    assert.match(clip.captionMode ?? '', /burned-in/);
    assert.equal(clip.cropStrategy, 'crop-center');
    assert.ok(detailed?.posterPath);
    const posterStat = await fsp.stat(detailed!.posterPath!);
    assert.ok(posterStat.size > 1_000);
  }
});

test('marks the project failed and produces no clips when transcription errors', async () => {
  const videoPath = path.join(tmpRoot, 'source-short.mp4');
  makeSource(videoPath, 24);

  const projectId = await createProjectWithSource(videoPath, 'Transcription failure test');
  const failing: TranscriptionProvider = {
    id: 'failing',
    label: 'failing test provider',
    async transcribeChunk() {
      throw new ProviderError('transcription_failed', 'Transcription provider returned HTTP 401: invalid key');
    },
  };

  await assert.rejects(
    () => runPipeline({ projectId, transcribe: failing, select: createHeuristicSelector() }),
    (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.match((error as PipelineError).message, /401/);
      return true;
    },
  );

  const project = db.getProject(projectId);
  assert.equal(project?.status, 'failed');
  assert.match(project?.error ?? '', /401/);
  assert.equal(db.getClips(projectId).length, 0);
});

test('rejects a source with no audio track instead of inventing a transcript', async () => {
  const videoPath = path.join(tmpRoot, 'silent.mp4');
  makeSource(videoPath, 12, false);

  const fixturePath = path.join(tmpRoot, 'transcript-silent.json');
  buildFixture(fixturePath, 2_000, 6);

  const projectId = await createProjectWithSource(videoPath, 'Silent source test');

  await assert.rejects(
    () =>
      runPipeline({
        projectId,
        transcribe: createFixtureTranscriber(fixturePath),
        select: createHeuristicSelector(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.equal((error as PipelineError).code, 'no_audio_track');
      return true;
    },
  );

  const project = db.getProject(projectId);
  assert.equal(project?.status, 'failed');
  assert.match(project?.error ?? '', /no audio track/i);
  assert.equal(db.getClips(projectId).length, 0);
});
