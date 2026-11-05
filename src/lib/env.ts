import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { PublicConfig } from './public-config';
import { ACCEPT_ATTRIBUTE, ALLOWED_EXTENSIONS, MAX_SOURCE_BYTES } from './upload-limits';
import {
  AUTHORIZED_DIRECTORY_PROVIDER,
  automaticAccessReason,
  mediaDirectoryReady,
} from './youtube-content';

// Resolve installed binaries relative to the project root rather than this file:
// Next.js rewrites module locations when bundling server code, which makes a
// require() anchored to `import.meta.url` unreliable.
const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'));

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function whichBinary(name: string): string | null {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function resolveBinary(
  envPath: string | undefined,
  moduleName: string,
  systemName: string,
): string | null {
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const mod = requireFromProject(moduleName) as unknown;
    const resolved =
      typeof mod === 'string'
        ? mod
        : mod && typeof mod === 'object' && typeof (mod as { path?: unknown }).path === 'string'
          ? (mod as { path: string }).path
          : null;
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    // package not installed — fall back to PATH
  }
  return whichBinary(systemName);
}

export const FONTS_DIR = path.join(process.cwd(), 'assets', 'fonts');
export const BOLD_FONT = path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf');

/** Approximate resident memory (MiB) for int8 CPU inference, per model size. */
export const WHISPER_MODEL_MEMORY_MB: Record<string, number> = {
  tiny: 900,
  'tiny.en': 900,
  base: 1300,
  'base.en': 1300,
  small: 2200,
  'small.en': 2200,
  medium: 4500,
  'medium.en': 4500,
  large: 9000,
  'large-v3': 9000,
  'large-v3-turbo': 6000,
};

export function whisperMemoryRequirement(model: string): number {
  const key = model.toLowerCase();
  if (WHISPER_MODEL_MEMORY_MB[key]) return WHISPER_MODEL_MEMORY_MB[key];
  for (const [name, value] of Object.entries(WHISPER_MODEL_MEMORY_MB)) {
    if (key.startsWith(name)) return value;
  }
  return 2200;
}

export interface WhisperConfig {
  pythonPath: string;
  helperPath: string;
  model: string;
  device: string;
  computeType: string;
  modelDir: string;
  threads: number;
}

export interface AppConfig {
  dataDir: string;
  maxUploadBytes: number;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  fontsDir: string;
  transcription: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
    language: string | null;
    chunkSeconds: number;
    provider: string;
    whisper: WhisperConfig;
  };
  llm: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
  };
  youtube: {
    apiKey: string | null;
    contentProvider: string;
    /** Where the authorized-directory provider looks for staged sources. */
    mediaDir: string;
  };
  /** Explicit opt-in used only by the automated test suite. */
  allowFixtureTranscriber: boolean;
}

/**
 * Builds a path under the project root at runtime.
 *
 * The indirection is deliberate: Turbopack statically follows literal
 * `path.join(process.cwd(), '.dir')` expressions into the build and fails on the
 * Whisper venv, whose `bin/python` is a symlink to a system interpreter. Routing
 * through this helper keeps those runtime-only directories out of the module graph.
 */
function projectPath(...segments: string[]): string {
  return path.join(process.cwd(), ...segments);
}

/** Prefers the project venv created by `npm run setup:whisper`. */
function resolveWhisperPython(): string {
  const explicit = process.env.WHISPER_PYTHON?.trim();
  if (explicit) return explicit;
  const venvPython = projectPath('.venv-whisper', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return whichBinary('python3') ?? 'python3';
}

let cached: AppConfig | null = null;

/** Test helper: drops the memoized config so changed env vars take effect. */
export function resetConfigCache(): void {
  cached = null;
  whisperCheck = null;
}

export function config(): AppConfig {
  if (cached) return cached;
  cached = {
    dataDir: path.resolve(process.env.AC_DATA_DIR ?? path.join(process.cwd(), 'data')),
    // A 1 GB policy ceiling. Local-first processing does not put the source in
    // R2; the managed 1 GB object-store quota is reserved for clips and project
    // data unless the user explicitly asks to keep a source copy.
    maxUploadBytes: intEnv('AC_MAX_UPLOAD_MB', 1024) * 1024 * 1024,
    ffmpegPath: resolveBinary(process.env.FFMPEG_PATH, 'ffmpeg-static', 'ffmpeg'),
    ffprobePath: resolveBinary(process.env.FFPROBE_PATH, 'ffprobe-static', 'ffprobe'),
    fontsDir: FONTS_DIR,
    transcription: {
      apiKey: process.env.TRANSCRIPTION_API_KEY?.trim() || null,
      baseUrl: (process.env.TRANSCRIPTION_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: process.env.TRANSCRIPTION_MODEL?.trim() || 'whisper-1',
      language: process.env.TRANSCRIPTION_LANGUAGE?.trim() || null,
      chunkSeconds: intEnv('TRANSCRIPTION_CHUNK_SECONDS', 600),
      // Local faster-whisper is the default: the app works with no paid service.
      provider: process.env.TRANSCRIPTION_PROVIDER?.trim() || 'local-whisper',
      whisper: {
        pythonPath: resolveWhisperPython(),
        helperPath: projectPath('worker', 'whisper_transcribe.py'),
        model: process.env.WHISPER_MODEL?.trim() || 'base',
        device: process.env.WHISPER_DEVICE?.trim() || 'cpu',
        computeType: process.env.WHISPER_COMPUTE_TYPE?.trim() || 'int8',
        modelDir: path.resolve(process.env.WHISPER_MODEL_DIR ?? projectPath('.whisper-models')),
        threads: intEnv('WHISPER_THREADS', Math.max(1, Math.min(8, os.cpus().length))),
      },
    },
    llm: {
      apiKey: process.env.LLM_API_KEY?.trim() || null,
      baseUrl: (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: process.env.LLM_MODEL?.trim() || 'gpt-4o-mini',
    },
    youtube: {
      apiKey: process.env.YOUTUBE_API_KEY?.trim() || null,
      contentProvider: process.env.YOUTUBE_CONTENT_PROVIDER?.trim() || 'none',
      mediaDir: path.resolve(process.env.YOUTUBE_MEDIA_DIR ?? projectPath('.youtube-media')),
    },
    allowFixtureTranscriber:
      process.env.AC_ALLOW_FIXTURE_TRANSCRIBER === '1' && process.env.NODE_ENV !== 'production',
  };
  return cached;
}

export interface WhisperAvailability {
  ready: boolean;
  pythonPath: string;
  detail: string;
}

let whisperCheck: WhisperAvailability | null = null;

/**
 * Whether the local transcription stack can actually run: the Python
 * interpreter must import faster-whisper and numpy. Cached, because it spawns a
 * process and the answer does not change while the server runs.
 */
export function whisperAvailability(): WhisperAvailability {
  if (whisperCheck) return whisperCheck;
  const cfg = config();
  const pythonPath = cfg.transcription.whisper.pythonPath;
  if (!fs.existsSync(pythonPath)) {
    whisperCheck = {
      ready: false,
      pythonPath,
      detail: `Python interpreter not found at ${pythonPath}`,
    };
    return whisperCheck;
  }
  const result = spawnSync(
    pythonPath,
    ['-c', 'import faster_whisper, numpy; print(faster_whisper.__version__)'],
    { encoding: 'utf8', timeout: 25_000 },
  );
  if (result.error) {
    whisperCheck = { ready: false, pythonPath, detail: result.error.message };
    return whisperCheck;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? 'unknown error';
    whisperCheck = {
      ready: false,
      pythonPath,
      detail: `faster-whisper is not importable by ${pythonPath}: ${stderr.slice(0, 240)}`,
    };
    return whisperCheck;
  }
  whisperCheck = { ready: true, pythonPath, detail: result.stdout.trim() };
  return whisperCheck;
}

export interface SystemResources {
  cpuCount: number;
  totalMemMB: number;
  freeMemMB: number;
}

export function systemResources(): SystemResources {
  return {
    cpuCount: os.cpus().length,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  };
}

/**
 * What is missing before a project can be processed. Returned to the UI so it can
 * explain itself instead of failing silently after the user uploads a video.
 */
export function processingBlocker(): { code: string; message: string } | null {
  const cfg = config();
  const provider = cfg.transcription.provider;

  if (provider === 'fixture') {
    if (!cfg.allowFixtureTranscriber) {
      return {
        code: 'transcription_not_configured',
        message:
          'The fixture transcriber is test-only and disabled in production. Configure local Faster-Whisper or a real transcription provider.',
      };
    }
    return null;
  }

  if (!cfg.ffmpegPath) {
    return {
      code: 'ffmpeg_missing',
      message:
        'FFmpeg was not found. Install it (or run npm install so the bundled static build is available) and restart the server.',
    };
  }
  if (!cfg.ffprobePath) {
    return {
      code: 'ffprobe_missing',
      message:
        'ffprobe was not found. Install FFmpeg with ffprobe (or run npm install so the bundled static build is available).',
    };
  }

  if (provider === 'local-whisper') {
    const availability = whisperAvailability();
    if (!availability.ready) {
      return {
        code: 'whisper_not_installed',
        message: `Local transcription is not ready: ${availability.detail}. Run "npm run setup:whisper" to install Faster-Whisper into .venv-whisper, then restart the server and worker.`,
      };
    }
    const model = cfg.transcription.whisper.model;
    const required = whisperMemoryRequirement(model);
    const { freeMemMB, cpuCount } = systemResources();
    if (freeMemMB < required) {
      return {
        code: 'insufficient_memory',
        message: `The "${model}" Whisper model needs about ${required} MB of free memory, but this host has ${freeMemMB} MB free (${cpuCount} CPUs). Use WHISPER_MODEL=tiny (≈900 MB) or run the worker on a machine with more RAM.`,
      };
    }
    return null;
  }

  if (provider === 'openai-compatible') {
    if (!cfg.transcription.apiKey) {
      return {
        code: 'transcription_not_configured',
        message:
          'TRANSCRIPTION_PROVIDER=openai-compatible requires TRANSCRIPTION_API_KEY. To avoid paid services, use the default local Faster-Whisper provider instead.',
      };
    }
    return null;
  }

  return {
    code: 'unknown_transcription_provider',
    message: `Unknown TRANSCRIPTION_PROVIDER "${provider}". Supported: local-whisper (default), openai-compatible, fixture (tests only).`,
  };
}

export function publicConfig(): PublicConfig {
  const cfg = config();
  const resources = systemResources();
  const browserLimit = Math.min(cfg.maxUploadBytes, MAX_SOURCE_BYTES);

  return {
    // These describe the browser runtime. There is no server FFmpeg or Python
    // worker to probe, and no worker needs to be started for a project to run.
    ffmpeg: true,
    ffprobe: true,
    browser: {
      processing: true,
      model: 'Xenova/whisper-tiny.en (quantized)',
      maxSourceBytes: browserLimit,
      webgpu: 'auto',
    },
    transcription: {
      configured: true,
      provider: 'transformers.js',
      engine: 'quantized Whisper tiny.en in the browser (WebGPU, WASM CPU fallback)',
      model: 'Xenova/whisper-tiny.en',
      baseUrlHost: 'same-origin model files and browser cache',
    },
    selection: {
      engine: 'heuristic',
      model: null,
    },
    youtube: {
      contentAccess: cfg.youtube.contentProvider,
      metadata: 'oembed',
      autoAccess: youtubeAutoAccess(),
    },
    maxUploadBytes: Math.min(cfg.maxUploadBytes, browserLimit),
    uploads: {
      maxBytes: Math.min(cfg.maxUploadBytes, browserLimit),
      extensions: [...ALLOWED_EXTENSIONS],
      accept: ACCEPT_ATTRIBUTE,
    },
    resources: {
      cpuCount: resources.cpuCount,
      freeMemMB: resources.freeMemMB,
      recommendedMemMB: 0,
      status: 'ok',
    },
    blocker: null,
  };
}

/**
 * Whether pasting a URL can run without a manual upload. Only an operator-provisioned
 * authorized provider can make that true; nothing here can fetch from YouTube directly.
 */
export function youtubeAutoAccess(): { available: boolean; provider: string; reason: string | null } {
  const provider = config().youtube.contentProvider;
  if (provider === AUTHORIZED_DIRECTORY_PROVIDER) {
    if (!mediaDirectoryReady(config().youtube.mediaDir)) {
      return { available: false, provider, reason: automaticAccessReason(provider) };
    }
    return { available: true, provider, reason: null };
  }
  return { available: false, provider, reason: automaticAccessReason(provider) };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
