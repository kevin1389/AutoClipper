/**
 * End-to-end smoke test against a running AutoClipper server.
 *
 * Prerequisites (fixture mode avoids spending API credits):
 *   1. Start the web server with fixture transcription env vars:
 *        AC_DATA_DIR=./.smoke/data TRANSCRIPTION_PROVIDER=fixture \
 *        AC_ALLOW_FIXTURE_TRANSCRIBER=1 AC_FIXTURE_TRANSCRIPT_PATH=./.smoke/transcript.json \
 *        npm run dev
 *   2. Run: npm run smoke
 *
 * The script generates a real test video, uploads it over HTTP, runs the worker
 * once, and verifies the rendered clip + ZIP download.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireHere = createRequire(import.meta.url);
const baseUrl = (process.env.AC_SMOKE_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const workDir = path.resolve(process.env.AC_SMOKE_DIR ?? path.join(process.cwd(), '.smoke'));
const videoPath = path.join(workDir, 'sample.mp4');
const fixturePath = path.join(workDir, 'transcript.json');

const SENTENCES = [
  'Here is the biggest mistake people make when they start clipping long recordings.',
  'The truth is nobody tells you how long the render takes when you batch everything.',
  'Why do most creators quit after ten videos? Because the feedback loop is brutal.',
  'Let me tell you what happened when we shipped a short clip every single day.',
  'We measured 42 percent more watch time after switching to vertical framing.',
  'What if you could turn one recording into a week of content without editing?',
  'The key is to start with the strongest sentence and cut everything before it.',
  'I remember the first time a clip went viral, it was completely unexpected.',
];

function log(message: string): void {
  process.stdout.write(`[smoke] ${message}\n`);
}

/**
 * fetch with a small retry. Dev servers close idle keep-alive sockets, so a
 * request made after a long pause can fail on a stale connection.
 */
async function request(input: string, init?: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(120_000),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError;
}

function resolveFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const mod = requireHere('ffmpeg-static') as unknown;
  if (typeof mod === 'string') return mod;
  throw new Error('ffmpeg-static is not installed and FFMPEG_PATH is not set');
}

interface HealthPayload {
  ok: boolean;
  config: { transcription: { configured: boolean; provider: string }; uploads: { maxBytes: number } };
  workerOnline: boolean;
}

async function main(): Promise<void> {
  await fsp.mkdir(workDir, { recursive: true });

  const healthResponse = await request(`${baseUrl}/api/health`);
  if (!healthResponse.ok) throw new Error(`/api/health returned HTTP ${healthResponse.status}`);
  const health = (await healthResponse.json()) as HealthPayload;
  log(`server config: transcription=${health.config.transcription.provider} (${health.config.transcription.configured ? 'configured' : 'MISSING'})`);
  if (!health.config.transcription.configured) {
    throw new Error(
      'The server has no transcription provider configured. Start it with TRANSCRIPTION_PROVIDER=fixture and AC_ALLOW_FIXTURE_TRANSCRIBER=1.',
    );
  }

  // ---- real source video -------------------------------------------------
  if (!fs.existsSync(videoPath)) {
    log('generating 72s test video with FFmpeg');
    const ffmpeg = resolveFfmpeg();
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=340:sample_rate=48000',
      '-t',
      '72',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      videoPath,
    ];
    execFileSync(ffmpeg, args, { stdio: 'pipe', timeout: 180_000 });
  }

  // ---- fixture transcript ------------------------------------------------
  const words: { text: string; startMs: number; endMs: number }[] = [];
  const sentenceMs = 2_400;
  const sentenceCount = Math.floor(72_000 / sentenceMs);
  for (let index = 0; index < sentenceCount; index += 1) {
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
  fs.writeFileSync(fixturePath, JSON.stringify({ language: 'en', words }, null, 2));

  // ---- upload over HTTP --------------------------------------------------
  const bytes = await fsp.readFile(videoPath);
  log(`creating project (${bytes.byteLength} byte upload)`);
  const createResponse = await request(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'upload', fileName: 'smoke-sample.mp4', size: bytes.byteLength }),
  });
  if (!createResponse.ok) throw new Error(`create failed: ${await createResponse.text()}`);
  const created = (await createResponse.json()) as { project: { id: string }; uploadEndpoint: string };
  const projectId = created.project.id;
  log(`project ${projectId}`);

  const uploadResponse = await request(`${baseUrl}${created.uploadEndpoint}`, {
    method: 'PUT',
    headers: {
      'content-type': 'video/mp4',
      'x-file-name': encodeURIComponent('smoke-sample.mp4'),
      'x-file-size': String(bytes.byteLength),
    },
    body: bytes,
  });
  if (!uploadResponse.ok) throw new Error(`upload failed: ${await uploadResponse.text()}`);
  const uploadResult = (await uploadResponse.json()) as { durationMs: number; width: number; height: number };
  log(`upload accepted: ${uploadResult.width}x${uploadResult.height}, ${Math.round(uploadResult.durationMs / 1000)}s`);

  const startResponse = await request(`${baseUrl}/api/projects/${projectId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!startResponse.ok) throw new Error(`start failed: ${await startResponse.text()}`);
  log('job queued');

  // ---- run the worker once ----------------------------------------------
  log('running worker for one job');
  await new Promise<void>((resolve, reject) => {
    const worker = spawn(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['worker/index.ts', '--once'], {
      env: {
        ...process.env,
        TRANSCRIPTION_PROVIDER: 'fixture',
        AC_ALLOW_FIXTURE_TRANSCRIBER: '1',
        AC_FIXTURE_TRANSCRIPT_PATH: fixturePath,
      },
      stdio: 'inherit',
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
  });

  // ---- verify results ----------------------------------------------------
  const projectResponse = await request(`${baseUrl}/api/projects/${projectId}`, { cache: 'no-store' });
  const view = (await projectResponse.json()) as {
    project: { status: string; error: string | null };
    clips: {
      id: string;
      status: string;
      title: string;
      videoUrl: string;
      downloadUrl: string;
      bytes: number | null;
      width: number | null;
      height: number | null;
      captionMode: string | null;
    }[];
    downloadAllUrl: string | null;
  };

  if (view.project.status !== 'completed') {
    throw new Error(`project is ${view.project.status}: ${view.project.error}`);
  }
  const rendered = view.clips.filter((clip) => clip.status === 'rendered');
  if (rendered.length === 0) throw new Error('project completed but no clips were rendered');

  log(`${rendered.length} clips rendered`);
  for (const clip of rendered.slice(0, 10)) {
    log(`  · ${clip.title} — ${clip.width}x${clip.height}, ${clip.bytes} bytes, ${clip.captionMode}`);
    if (clip.width !== 1080 || clip.height !== 1920) {
      throw new Error(`clip ${clip.id} is not 1080x1920`);
    }
  }

  const clip = rendered[0];
  const rangeResponse = await request(`${baseUrl}${clip.videoUrl}`, {
    headers: { range: 'bytes=0-4095' },
  });
  if (rangeResponse.status !== 206) {
    throw new Error(`expected a 206 range response for clip video, got ${rangeResponse.status}`);
  }
  const rangeBody = new Uint8Array(await rangeResponse.arrayBuffer());
  const ftypIndex = Buffer.from(rangeBody).indexOf(Buffer.from('ftyp'));
  if (ftypIndex < 0) throw new Error('clip video is not an MP4 (no ftyp box)');
  log(`clip streaming OK (206, ${rangeBody.byteLength} bytes, MP4 ftyp at ${ftypIndex})`);

  const downloadResponse = await request(`${baseUrl}${clip.downloadUrl}`);
  if (!downloadResponse.ok) throw new Error(`clip download failed: ${downloadResponse.status}`);
  const clipBytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const clipOut = path.join(workDir, 'out', 'clip-01.mp4');
  await fsp.mkdir(path.dirname(clipOut), { recursive: true });
  await fsp.writeFile(clipOut, clipBytes);
  log(`downloaded clip MP4: ${clipBytes.byteLength} bytes -> ${clipOut}`);

  if (!view.downloadAllUrl) throw new Error('downloadAllUrl missing');
  const zipResponse = await request(`${baseUrl}${view.downloadAllUrl}`);
  if (!zipResponse.ok) throw new Error(`ZIP download failed: ${zipResponse.status}`);
  const zipBytes = new Uint8Array(await zipResponse.arrayBuffer());
  if (zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) throw new Error('ZIP response is not a ZIP archive');
  const zipOut = path.join(workDir, 'out', 'clips.zip');
  await fsp.writeFile(zipOut, zipBytes);
  log(`downloaded ZIP: ${zipBytes.byteLength} bytes -> ${zipOut}`);

  log('PASS — upload, transcribe, select, render, stream and ZIP export all verified');
}

void main().catch((error) => {
  process.stderr.write(`[smoke] FAIL: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
