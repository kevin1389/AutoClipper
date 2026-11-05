import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTHORIZED_DIRECTORY_PROVIDER,
  automaticAccessReason,
  mediaDirectoryReady,
  resolveAuthorizedMedia,
} from '../src/lib/youtube-content';

const VIDEO_ID = 'dQw4w9WgXcQ';

function stagingDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-youtube-media-'));
}

test('without a provider, automatic access is refused with a reason that names the limits', () => {
  const resolution = resolveAuthorizedMedia({ provider: 'none', mediaDir: stagingDir() }, VIDEO_ID);
  assert.equal(resolution.available, false);
  assert.equal(resolution.available === false ? resolution.code : '', 'no_provider');
  const reason = resolution.available === false ? resolution.reason : '';
  assert.match(reason, /no authorized content-access provider/i);
  assert.match(reason, /no download API/i);
  assert.match(reason, /does not use extractors/i);
});

test('authorized-directory returns the staged file with its real size', () => {
  const dir = stagingDir();
  const media = path.join(dir, `${VIDEO_ID}.mp4`);
  fs.writeFileSync(media, Buffer.alloc(4096, 7));

  assert.equal(mediaDirectoryReady(dir), true);
  const resolution = resolveAuthorizedMedia({ provider: AUTHORIZED_DIRECTORY_PROVIDER, mediaDir: dir }, VIDEO_ID);
  assert.equal(resolution.available, true);
  if (resolution.available) {
    assert.equal(resolution.media.provider, AUTHORIZED_DIRECTORY_PROVIDER);
    assert.equal(resolution.media.fileName, `${VIDEO_ID}.mp4`);
    assert.equal(resolution.media.bytes, 4096);
    assert.equal(resolution.media.path, media);
  }
});

test('a different video id is not served from someone else’s staged copy', () => {
  const dir = stagingDir();
  fs.writeFileSync(path.join(dir, `${VIDEO_ID}.mp4`), Buffer.alloc(1024));
  const resolution = resolveAuthorizedMedia(
    { provider: AUTHORIZED_DIRECTORY_PROVIDER, mediaDir: dir },
    'aqz-KE-bpKQ',
  );
  assert.equal(resolution.available, false);
  assert.match(resolution.available === false ? resolution.reason : '', /No authorized copy/i);
});

test('the not-staged reason gives the expected filename and never leaks a server path', () => {
  const dir = stagingDir();
  const resolution = resolveAuthorizedMedia({ provider: AUTHORIZED_DIRECTORY_PROVIDER, mediaDir: dir }, VIDEO_ID);
  assert.equal(resolution.available, false);
  const reason = resolution.available === false ? resolution.reason : '';
  assert.match(reason, new RegExp(`${VIDEO_ID}\\.mp4`));
  assert.ok(!reason.includes(dir), 'reason must not expose the absolute media directory');
});

test('an unprovisioned directory is reported distinctly from a missing copy', () => {
  const missing = path.join(os.tmpdir(), `autoclipper-not-created-${Date.now()}`);
  const resolution = resolveAuthorizedMedia(
    { provider: AUTHORIZED_DIRECTORY_PROVIDER, mediaDir: missing },
    VIDEO_ID,
  );
  assert.equal(resolution.available, false);
  assert.match(
    resolution.available === false ? resolution.reason : '',
    /not provisioned yet/i,
  );
});

test('empty or non-video files are not treated as authorized media', () => {
  const dir = stagingDir();
  fs.writeFileSync(path.join(dir, `${VIDEO_ID}.mp4`), Buffer.alloc(0));
  fs.writeFileSync(path.join(dir, `${VIDEO_ID}.txt`), 'not a video');
  const resolution = resolveAuthorizedMedia({ provider: AUTHORIZED_DIRECTORY_PROVIDER, mediaDir: dir }, VIDEO_ID);
  assert.equal(resolution.available, false);
});

test('an unknown provider is refused instead of silently ignored', () => {
  const resolution = resolveAuthorizedMedia({ provider: 'acme-licensed-feed', mediaDir: stagingDir() }, VIDEO_ID);
  assert.equal(resolution.available, false);
  assert.equal(resolution.available === false ? resolution.code : '', 'unknown_provider');
  assert.match(
    resolution.available === false ? resolution.reason : '',
    /Unknown YOUTUBE_CONTENT_PROVIDER "acme-licensed-feed"/,
  );
  assert.match(automaticAccessReason('acme-licensed-feed'), /unauthorized download path/i);
});
