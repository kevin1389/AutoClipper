/**
 * Browser assets that must not be bundled with the Worker.
 *
 * FFmpeg.wasm, ONNX Runtime, the pinned Whisper model and the caption font are
 * ~205 MB. Cloudflare Workers rejects any static asset above 25 MiB, so these
 * files are uploaded once to an object-storage bucket/CDN and loaded by the
 * browser from `BROWSER_ASSET_BASE_URL`. The same-origin `/api/browser-assets`
 * route is the default and reads the R2 FILES binding (or `browser-assets/` on
 * disk during local development).
 *
 * This module is intentionally dependency-free: it is imported by the server
 * route, the browser workers and the upload script.
 */

export const DEFAULT_BROWSER_ASSET_BASE = '/api/browser-assets/';

export interface BrowserAssetSpec {
  /** Path relative to the asset base. */
  path: string;
  contentType: string;
  /** Exact byte length, used to reject truncated downloads and uploads. */
  bytes: number;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const JS_TYPE = 'text/javascript; charset=utf-8';
const WASM_TYPE = 'application/wasm';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const MODEL_ROOT = 'models/Xenova/whisper-tiny.en';

export const BROWSER_ASSET_SPECS: readonly BrowserAssetSpec[] = [
  { path: 'ffmpeg/ffmpeg-core.js', contentType: JS_TYPE, bytes: 111_804 },
  { path: 'ffmpeg/ffmpeg-core.wasm', contentType: WASM_TYPE, bytes: 32_232_419 },
  { path: 'fonts/DejaVuSans-Bold.ttf', contentType: 'font/ttf', bytes: 704_128 },
  { path: 'transformers/ort-wasm-simd-threaded.mjs', contentType: JS_TYPE, bytes: 20_856 },
  { path: 'transformers/ort-wasm-simd-threaded.wasm', contentType: WASM_TYPE, bytes: 11_133_407 },
  { path: 'transformers/ort-wasm-simd-threaded.jsep.mjs', contentType: JS_TYPE, bytes: 44_484 },
  { path: 'transformers/ort-wasm-simd-threaded.jsep.wasm', contentType: WASM_TYPE, bytes: 21_596_019 },
  { path: `${MODEL_ROOT}/MODEL_NOTICE.md`, contentType: TEXT_TYPE, bytes: 746 },
  { path: `${MODEL_ROOT}/added_tokens.json`, contentType: JSON_TYPE, bytes: 2_082 },
  { path: `${MODEL_ROOT}/config.json`, contentType: JSON_TYPE, bytes: 2_202 },
  { path: `${MODEL_ROOT}/generation_config.json`, contentType: JSON_TYPE, bytes: 1_590 },
  { path: `${MODEL_ROOT}/merges.txt`, contentType: TEXT_TYPE, bytes: 456_318 },
  { path: `${MODEL_ROOT}/normalizer.json`, contentType: JSON_TYPE, bytes: 52_666 },
  { path: `${MODEL_ROOT}/preprocessor_config.json`, contentType: JSON_TYPE, bytes: 339 },
  { path: `${MODEL_ROOT}/special_tokens_map.json`, contentType: JSON_TYPE, bytes: 1_717 },
  { path: `${MODEL_ROOT}/tokenizer.json`, contentType: JSON_TYPE, bytes: 2_128_494 },
  { path: `${MODEL_ROOT}/tokenizer_config.json`, contentType: JSON_TYPE, bytes: 835 },
  { path: `${MODEL_ROOT}/vocab.json`, contentType: JSON_TYPE, bytes: 999_186 },
  {
    path: `${MODEL_ROOT}/onnx/encoder_model_quantized.onnx`,
    contentType: 'application/octet-stream',
    bytes: 10_124_913,
  },
  {
    path: `${MODEL_ROOT}/onnx/decoder_model_merged_quantized.onnx`,
    contentType: 'application/octet-stream',
    bytes: 30_727_382,
  },
  {
    path: `${MODEL_ROOT}/onnx/encoder_model_fp16.onnx`,
    contentType: 'application/octet-stream',
    bytes: 16_519_776,
  },
  {
    path: `${MODEL_ROOT}/onnx/decoder_model_merged_q4.onnx`,
    contentType: 'application/octet-stream',
    bytes: 86_737_938,
  },
];

const SPECS_BY_PATH = new Map(BROWSER_ASSET_SPECS.map((spec) => [spec.path, spec]));

/**
 * Returns the exact allow-listed asset, or null. A map lookup (rather than a
 * filesystem join) is what prevents traversal from ever reaching storage.
 */
export function browserAssetSpec(path: string): BrowserAssetSpec | null {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..') return null;
  }
  return SPECS_BY_PATH.get(path) ?? null;
}

/**
 * Normalizes `BROWSER_ASSET_BASE_URL`. Absolute HTTPS/HTTP URLs support a
 * public bucket or CDN; a root-relative path uses the same-origin route.
 * Query strings and credentials are rejected because they would break joins.
 */
export function normalizeBrowserAssetBase(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_BROWSER_ASSET_BASE;
  if (raw.startsWith('//')) {
    throw new Error('BROWSER_ASSET_BASE_URL must not be protocol-relative.');
  }
  if (raw.startsWith('/')) {
    return `${raw.replace(/\/+$/, '')}/`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BROWSER_ASSET_BASE_URL must be an absolute URL or a root-relative path.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('BROWSER_ASSET_BASE_URL must use http or https.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('BROWSER_ASSET_BASE_URL must not contain credentials, a query or a fragment.');
  }
  return `${url.toString().replace(/\/+$/, '')}/`;
}

/** Joins a validated asset file path onto a normalized base. */
export function joinBrowserAssetUrl(base: string, path: string): string {
  if (!browserAssetSpec(path)) throw new Error(`Unknown browser asset: ${path}`);
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Joins a directory (for Transformers.js wasm/model roots) onto the base. */
export function joinBrowserAssetDirectoryUrl(base: string, directory: string): string {
  if (!directory || directory.includes('..') || directory.includes('\\')) {
    throw new Error('Invalid browser asset directory.');
  }
  return `${base.replace(/\/+$/, '')}/${directory.replace(/^\/+|\/+$/g, '')}/`;
}
