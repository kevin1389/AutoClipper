/**
 * Same-origin Whisper assets.
 *
 * The model used to be fetched from huggingface.co by Transformers.js. That
 * makes model loading depend on a third-party CDN, its redirect chain, and the
 * user's network path to it. These files are the exact Xenova/whisper-tiny.en
 * artifacts, pinned to a commit and served by AutoClipper itself.
 *
 * Transformers.js still owns preprocessing, tokenization and inference. This
 * module only makes its file loading deterministic: every required file is
 * checked, downloaded with byte progress, and stored in a versioned Cache
 * Storage bucket so a retry does not restart completed files.
 */
import { browserAssetUrl } from './asset-base';

export const WHISPER_MODEL_ID = 'Xenova/whisper-tiny.en';
export const WHISPER_MODEL_REVISION = '79fb389fc764e7c395bd330e9531d9d32ada7049';
export const WHISPER_MODEL_ROOT = `models/${WHISPER_MODEL_ID}`;

const CACHE_NAME = `autoclipper-whisper-${WHISPER_MODEL_REVISION.slice(0, 8)}-v1`;

export type WhisperEngine = 'webgpu' | 'wasm';

interface AssetSpec {
  file: string;
  bytes: number;
}

export interface WhisperAssetProgress {
  detail: string;
  fraction: number;
  loadedBytes: number;
  totalBytes: number;
  reusedBytes: number;
}

export class WhisperAssetError extends Error {
  readonly code = 'whisper_model_load_failed';
  readonly asset: string;

  constructor(message: string, asset = '', options?: ErrorOptions) {
    super(message, options);
    this.name = 'WhisperAssetError';
    this.asset = asset;
  }
}

/**
 * Text/tokenizer files are small and shared by both backends. The ONNX files
 * are the quantized variants Transformers.js selects for the existing WASM and
 * WebGPU options.
 */
const COMMON_ASSETS: AssetSpec[] = [
  { file: 'config.json', bytes: 2_202 },
  { file: 'generation_config.json', bytes: 1_590 },
  { file: 'preprocessor_config.json', bytes: 339 },
  { file: 'tokenizer.json', bytes: 2_128_494 },
  { file: 'tokenizer_config.json', bytes: 835 },
  { file: 'special_tokens_map.json', bytes: 1_717 },
  { file: 'added_tokens.json', bytes: 2_082 },
  { file: 'normalizer.json', bytes: 52_666 },
  { file: 'vocab.json', bytes: 999_186 },
  { file: 'merges.txt', bytes: 456_318 },
];

const BACKEND_ASSETS: Record<WhisperEngine, AssetSpec[]> = {
  wasm: [
    { file: 'onnx/encoder_model_quantized.onnx', bytes: 10_124_913 },
    { file: 'onnx/decoder_model_merged_quantized.onnx', bytes: 30_727_382 },
  ],
  webgpu: [
    { file: 'onnx/encoder_model_fp16.onnx', bytes: 16_519_776 },
    { file: 'onnx/decoder_model_merged_q4.onnx', bytes: 86_737_938 },
  ],
};

let openCachePromise: Promise<Cache | null> | null = null;
let prunedCaches = false;

function assetUrl(file: string): string {
  return browserAssetUrl(`${WHISPER_MODEL_ROOT}/${file}`);
}

function requestUrl(request: RequestInfo | URL): string {
  if (typeof request === 'string') return new URL(request, self.location.origin).href;
  if (request instanceof URL) return request.href;
  return request.url;
}

async function getModelCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  if (!openCachePromise) {
    openCachePromise = caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        if (!prunedCaches) {
          prunedCaches = true;
          const keys = await caches.keys().catch(() => [] as string[]);
          await Promise.all(
            keys
              .filter((key) => key.startsWith('autoclipper-whisper-') && key !== CACHE_NAME)
              .map((key) => caches.delete(key).catch(() => false)),
          );
        }
        return cache;
      })
      .catch(() => null);
  }
  return openCachePromise;
}

/**
 * The cache adapter handed to Transformers.js. A cache failure is never fatal:
 * the library can still use the same-origin files, it just will not persist
 * them. The explicit preloader below is where cache failures are reported.
 */
export const whisperAssetCache = {
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const cache = await getModelCache();
    if (!cache) return undefined;
    try {
      return await cache.match(requestUrl(request));
    } catch {
      return undefined;
    }
  },

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const cache = await getModelCache();
    if (!cache) return;
    try {
      await cache.put(requestUrl(request), response);
    } catch (error) {
      console.warn('Could not persist a Whisper model file in browser storage.', error);
    }
  },
};

export async function whisperCacheAvailable(): Promise<boolean> {
  return (await getModelCache()) !== null;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function isQuotaError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      String((error as { name?: unknown }).name) === 'QuotaExceededError',
  );
}

async function cachedFileSize(response: Response): Promise<number | null> {
  const header = response.headers.get('content-length');
  if (header && Number.isFinite(Number(header))) return Number(header);
  try {
    return (await response.clone().blob()).size;
  } catch {
    return null;
  }
}

export function whisperAssetsFor(engine: WhisperEngine): AssetSpec[] {
  return [...COMMON_ASSETS, ...BACKEND_ASSETS[engine]];
}

/**
 * Downloads the exact asset set for one backend. Completed files are kept in
 * Cache Storage; an interrupted retry reuses them and starts again at the first
 * incomplete file. The current file is replaced atomically, never appended to a
 * corrupt partial model.
 */
export async function preloadWhisperAssets(
  engine: WhisperEngine,
  onProgress: (progress: WhisperAssetProgress) => void,
): Promise<void> {
  const cache = await getModelCache();
  if (!cache) {
    throw new WhisperAssetError(
      'Browser cache storage is unavailable, so the Whisper model cannot be prepared safely. Open AutoClipper in a normal browser tab and retry.',
    );
  }

  try {
    await navigator.storage?.persist?.();
  } catch {
    // This is a hint. Cache Storage can still work without it.
  }

  const assets = whisperAssetsFor(engine);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  let completedBytes = 0;
  let reusedBytes = 0;
  let lastPercent = -1;

  const report = (fraction: number, detail: string, force = false) => {
    const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    if (!force && percent === lastPercent) return;
    lastPercent = percent;
    onProgress({
      detail,
      fraction: Math.max(0, Math.min(1, fraction)),
      loadedBytes: completedBytes,
      totalBytes,
      reusedBytes,
    });
  };

  report(0, `Checking the Whisper model cache · ${megabytes(totalBytes)}`, true);

  for (const asset of assets) {
    const url = assetUrl(asset.file);
    const cached = await cache.match(url).catch(() => undefined);
    if (cached) {
      const size = await cachedFileSize(cached);
      if (size === asset.bytes) {
        completedBytes += asset.bytes;
        reusedBytes += asset.bytes;
        report(
          completedBytes / totalBytes,
          reusedBytes === completedBytes
            ? `Using cached Whisper files · ${megabytes(reusedBytes)} of ${megabytes(totalBytes)}`
            : `Reusing cached ${asset.file} · ${megabytes(completedBytes)} of ${megabytes(totalBytes)}`,
        );
        continue;
      }
      await cache.delete(url).catch(() => false);
    }

    if (reusedBytes > 0) {
      report(
        completedBytes / totalBytes,
        `Continuing Whisper download · ${megabytes(completedBytes)} of ${megabytes(totalBytes)} already cached`,
        true,
      );
    }

    let response: Response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new WhisperAssetError(
        `Could not reach ${asset.file} from the browser-asset host (${detail}). Check BROWSER_ASSET_BASE_URL, the bucket's CORS rules and the network, then retry.`,
        asset.file,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new WhisperAssetError(
        `The model file ${asset.file} returned HTTP ${response.status} from the browser-asset host.`,
        asset.file,
      );
    }

    const chunks: BlobPart[] = [];
    let fileLoaded = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value as unknown as BlobPart);
          fileLoaded += value.byteLength;
          report(
            (completedBytes + Math.min(fileLoaded, asset.bytes)) / totalBytes,
            `Downloading Whisper model · ${megabytes(completedBytes + Math.min(fileLoaded, asset.bytes))} of ${megabytes(totalBytes)} · ${asset.file.split('/').pop()}`,
          );
        }
      } catch (error) {
        throw new WhisperAssetError(
          `The Whisper download was interrupted while receiving ${asset.file} (${error instanceof Error ? error.message : String(error)}). Cached files are preserved; retry to continue.`,
          asset.file,
          { cause: error },
        );
      }
    } else {
      const blob = await response.blob();
      chunks.push(blob);
      fileLoaded = blob.size;
    }

    const blob = new Blob(chunks, {
      type: response.headers.get('content-type') ?? 'application/octet-stream',
    });
    if (blob.size !== asset.bytes) {
      throw new WhisperAssetError(
        `The model file ${asset.file} was incomplete: expected ${asset.bytes} bytes but received ${blob.size}.`,
        asset.file,
      );
    }

    const headers = new Headers();
    headers.set('content-type', blob.type || 'application/octet-stream');
    headers.set('content-length', String(blob.size));
    try {
      await cache.put(url, new Response(blob, { status: 200, headers }));
    } catch (error) {
      if (isQuotaError(error)) {
        throw new WhisperAssetError(
          `The Whisper model downloaded, but the browser has no room to cache it. Free browser storage and retry; already downloaded files will be reused.`,
          asset.file,
          { cause: error },
        );
      }
      throw new WhisperAssetError(
        `The Whisper model downloaded, but could not be saved in this browser (${error instanceof Error ? error.message : String(error)}).`,
        asset.file,
        { cause: error },
      );
    }

    completedBytes += asset.bytes;
    report(
      completedBytes / totalBytes,
      `Downloaded ${asset.file.split('/').pop()} · ${megabytes(completedBytes)} of ${megabytes(totalBytes)}`,
      true,
    );
  }

  report(
    1,
    reusedBytes === totalBytes
      ? `Whisper model loaded from this browser’s cache · ${megabytes(totalBytes)}`
      : `Whisper model downloaded · ${megabytes(totalBytes)}`,
    true,
  );
}
