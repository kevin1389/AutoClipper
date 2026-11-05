/**
 * Verifies the configured transcription engine actually works.
 *
 *   npm run check:transcription
 *
 * - `local-whisper` (default): runs the real Python helper on a generated tone,
 *   proving the interpreter, faster-whisper install, FFmpeg decode and JSON
 *   contract all work. The first run downloads the model. A tone contains no
 *   speech, so zero words is the expected result — the check is completion.
 * - `openai-compatible`: makes a real API request with a 1-second tone and
 *   checks auth + transport without paying for a long transcript.
 *
 * Exits 0 only when the check passed. It never prints an API key.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  config,
  systemResources,
  whisperAvailability,
  whisperMemoryRequirement,
  type AppConfig,
} from '../src/lib/env';
import { loadEnvFile } from '../src/lib/load-env';

function toneWav(seconds = 1, sampleRate = 16_000): Buffer {
  const samples = seconds * sampleRate;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 3000;
    buffer.writeInt16LE(Math.round(value), 44 + index * 2);
  }
  return buffer;
}

function checkLocalWhisper(cfg: AppConfig): number {
  const whisper = cfg.transcription.whisper;
  const availability = whisperAvailability();

  if (!availability.ready) {
    process.stderr.write(
      `FAILED: local transcription is not installed for ${availability.pythonPath}\n` +
        `  ${availability.detail}\n` +
        '  Run "npm run setup:whisper", then run this check again.\n',
    );
    return 1;
  }
  if (!cfg.ffmpegPath) {
    process.stderr.write(
      'FAILED: FFmpeg was not found, so audio cannot be decoded. Install FFmpeg (or run npm install for the bundled build).\n',
    );
    return 1;
  }

  const resources = systemResources();
  const required = whisperMemoryRequirement(whisper.model);
  if (resources.freeMemMB < required) {
    process.stderr.write(
      `FAILED: the "${whisper.model}" model needs about ${required} MB of free memory, but this host has ` +
        `${resources.freeMemMB} MB free (${resources.cpuCount} CPUs). Use WHISPER_MODEL=tiny (≈900 MB) or add RAM.\n`,
    );
    return 1;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoclipper-check-'));
  const audioPath = path.join(dir, 'check.wav');
  const outputPath = path.join(dir, 'check.json');
  writeFileSync(audioPath, toneWav(2));

  process.stdout.write(
    'local faster-whisper\n' +
      `  python: ${availability.pythonPath}\n` +
      `  helper: ${whisper.helperPath}\n` +
      `  model:  ${whisper.model} (${whisper.device}/${whisper.computeType}, ${whisper.threads} threads)\n` +
      `  memory: ${resources.freeMemMB} MB free, ~${required} MB needed\n` +
      `  models: ${whisper.modelDir}\n`,
  );

  const started = Date.now();
  const result = spawnSync(
    whisper.pythonPath,
    [
      whisper.helperPath,
      '--audio',
      audioPath,
      '--model',
      whisper.model,
      '--device',
      whisper.device,
      '--compute-type',
      whisper.computeType,
      '--model-dir',
      whisper.modelDir,
      '--threads',
      String(whisper.threads),
      '--ffmpeg',
      cfg.ffmpegPath,
      '--output',
      outputPath,
    ],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  try {
    if (result.error) {
      process.stderr.write(`FAILED: could not run the helper — ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      const lastLine = (result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
      process.stderr.write(
        `FAILED: the helper exited with ${result.status} after ${elapsed}s.\n  ${lastLine.slice(0, 400)}\n`,
      );
      return 1;
    }

    let parsed: { segments?: unknown[]; language?: string | null; durationSeconds?: number } = {};
    try {
      parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as typeof parsed;
    } catch {
      process.stderr.write('FAILED: the helper exited cleanly but wrote no readable JSON output.\n');
      return 1;
    }

    process.stdout.write(
      `OK: local transcription ran end to end in ${elapsed}s.\n` +
        `  audio:    ${parsed.durationSeconds?.toFixed(2) ?? '?'}s decoded by FFmpeg\n` +
        `  segments: ${parsed.segments?.length ?? 0} (a tone has no speech, so 0 is expected)\n` +
        `  language: ${parsed.language ?? 'n/a'}\n` +
        'The engine works. Transcribe a real recording through a project to judge accuracy.\n',
    );
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const cfg = config();
  const { apiKey, baseUrl, model, provider } = cfg.transcription;

  if (provider === 'fixture') {
    process.stderr.write(
      'TRANSCRIPTION_PROVIDER=fixture selects the development transcriber. Set a real engine before checking.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (provider === 'local-whisper') {
    process.exitCode = checkLocalWhisper(cfg);
    return;
  }

  if (!apiKey) {
    process.stderr.write(
      'MISSING: TRANSCRIPTION_API_KEY is not set. Add it to .env (or the host environment) and run this again.\n' +
        'To avoid API keys and paid services entirely, leave TRANSCRIPTION_PROVIDER unset to use local Faster-Whisper.\n',
    );
    process.exitCode = 1;
    return;
  }

  const endpoint = `${baseUrl}/audio/transcriptions`;
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // keep the raw value for the message
  }

  const modelName = model;
  let form = buildForm(modelName);
  process.stdout.write(`POST ${endpoint}\n  model: ${modelName}\n  host:  ${host}\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    let response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });

    // Some OpenAI-compatible servers reject verbose_json/timestamp options;
    // fall back to the plain shape so the check still tests auth + transport.
    if (response.status === 400) {
      const detail = await response.text();
      form = buildForm(modelName, false);
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (response.ok) {
        process.stdout.write(`note: provider rejected verbose_json, plain request accepted. (${detail.slice(0, 120)})\n`);
      }
    }

    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      process.stderr.write(
        `FAILED: the provider rejected the API key (HTTP ${response.status}). Check TRANSCRIPTION_API_KEY and TRANSCRIPTION_BASE_URL.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (!response.ok) {
      process.stderr.write(`FAILED: HTTP ${response.status} — ${body.replace(/\s+/g, ' ').slice(0, 300)}\n`);
      process.exitCode = 1;
      return;
    }

    let parsed: { text?: string; words?: unknown[]; segments?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(body) as { text?: string; words?: unknown[]; segments?: unknown[] };
    } catch {
      // non-JSON success is still a successful round trip
    }

    process.stdout.write(
      `OK: provider accepted the request (HTTP ${response.status}).\n` +
        `  words:    ${parsed?.words?.length ?? 0}\n` +
        `  segments: ${parsed?.segments?.length ?? 0}\n` +
        `  text:     ${JSON.stringify((parsed?.text ?? '').slice(0, 60))}\n` +
        'Connectivity and credentials are valid. Transcribe a real recording to judge accuracy.\n',
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    process.stderr.write(
      aborted
        ? 'FAILED: the request timed out after 60s.\n'
        : `FAILED: could not reach ${host} — ${(error as Error).message}\n`,
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

function buildForm(model: string, verbose = true): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(toneWav())], { type: 'audio/wav' }), 'check.wav');
  form.append('model', model);
  if (verbose) {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
  }
  return form;
}

void main();
