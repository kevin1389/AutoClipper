import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConfig } from '../src/lib/env';
import { isLocalSourcePath, localSourcePath, MAX_SOURCE_BYTES } from '../src/lib/upload-limits';
import { validateUploadCandidate } from '../src/lib/upload';

test('the source ceiling is 1 GiB and is reported to the browser', () => {
  assert.equal(MAX_SOURCE_BYTES, 1024 * 1024 * 1024);
  assert.equal(publicConfig().browser.maxSourceBytes, MAX_SOURCE_BYTES);
  assert.equal(publicConfig().uploads.maxBytes, MAX_SOURCE_BYTES);
});

test('a 1 GiB source is accepted and one byte over is rejected before upload', () => {
  const accepted = validateUploadCandidate('recording.mp4', MAX_SOURCE_BYTES);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.extension, '.mp4');

  const rejected = validateUploadCandidate('recording.mp4', MAX_SOURCE_BYTES + 1);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, 'file_too_large');
});

test('local source markers are distinguishable from storage keys', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const marker = localSourcePath(id);
  assert.equal(marker, `local://${id}`);
  assert.equal(isLocalSourcePath(marker), true);
  assert.equal(isLocalSourcePath(`projects/${id}/source/input.mp4`), false);
  assert.equal(isLocalSourcePath(null), false);
});
