import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_ASSET_SPECS,
  browserAssetSpec,
  joinBrowserAssetDirectoryUrl,
  joinBrowserAssetUrl,
  normalizeBrowserAssetBase,
} from '../src/lib/browser-assets';

test('browser asset manifest covers every required runtime file', () => {
  const paths = new Set(BROWSER_ASSET_SPECS.map((spec) => spec.path));
  for (const required of [
    'ffmpeg/ffmpeg-core.js',
    'ffmpeg/ffmpeg-core.wasm',
    'fonts/DejaVuSans-Bold.ttf',
    'transformers/ort-wasm-simd-threaded.jsep.wasm',
    'models/Xenova/whisper-tiny.en/onnx/encoder_model_quantized.onnx',
    'models/Xenova/whisper-tiny.en/onnx/decoder_model_merged_q4.onnx',
    'models/Xenova/whisper-tiny.en/tokenizer.json',
  ]) {
    assert.ok(paths.has(required), `missing ${required}`);
  }
  assert.equal(paths.size, BROWSER_ASSET_SPECS.length, 'duplicate asset path');
  for (const spec of BROWSER_ASSET_SPECS) {
    assert.ok(spec.bytes > 0, `${spec.path} has no byte length`);
    assert.ok(spec.contentType.includes('/'), `${spec.path} has no content type`);
  }
});

test('asset lookup uses the allow-list and rejects traversal', () => {
  assert.equal(browserAssetSpec('ffmpeg/ffmpeg-core.wasm')?.contentType, 'application/wasm');
  assert.equal(browserAssetSpec('fonts/DejaVuSans-Bold.ttf')?.contentType, 'font/ttf');
  assert.equal(browserAssetSpec('ffmpeg/../ffmpeg/ffmpeg-core.wasm'), null);
  assert.equal(browserAssetSpec('models/../../etc/passwd'), null);
  assert.equal(browserAssetSpec('/etc/passwd'), null);
  assert.equal(browserAssetSpec('models/Xenova/whisper-tiny.en/unknown.onnx'), null);
});

test('asset base normalization accepts same-origin and public URLs only', () => {
  assert.equal(normalizeBrowserAssetBase(undefined), '/api/browser-assets/');
  assert.equal(normalizeBrowserAssetBase('  '), '/api/browser-assets/');
  assert.equal(normalizeBrowserAssetBase('/assets'), '/assets/');
  assert.equal(
    normalizeBrowserAssetBase('https://cdn.example.com/browser-assets/v1'),
    'https://cdn.example.com/browser-assets/v1/',
  );
  assert.equal(normalizeBrowserAssetBase('http://127.0.0.1:8788'), 'http://127.0.0.1:8788/');
  assert.throws(() => normalizeBrowserAssetBase('//cdn.example.com'));
  assert.throws(() => normalizeBrowserAssetBase('ftp://cdn.example.com'));
  assert.throws(() => normalizeBrowserAssetBase('https://cdn.example.com/v1?x=1'));
  assert.throws(() => normalizeBrowserAssetBase('https://user:pass@cdn.example.com'));
});

test('asset URL joins preserve the base prefix and validate files', () => {
  assert.equal(
    joinBrowserAssetUrl('/api/browser-assets/', 'ffmpeg/ffmpeg-core.js'),
    '/api/browser-assets/ffmpeg/ffmpeg-core.js',
  );
  assert.equal(
    joinBrowserAssetUrl('https://cdn.example.com/v1/', 'fonts/DejaVuSans-Bold.ttf'),
    'https://cdn.example.com/v1/fonts/DejaVuSans-Bold.ttf',
  );
  assert.equal(
    joinBrowserAssetDirectoryUrl('https://cdn.example.com/v1', '/models/'),
    'https://cdn.example.com/v1/models/',
  );
  assert.throws(() => joinBrowserAssetUrl('/assets/', 'not-in-the-manifest.onnx'));
  assert.throws(() => joinBrowserAssetDirectoryUrl('/assets/', '../models'));
});
