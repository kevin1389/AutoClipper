import assert from 'node:assert/strict';
import test from 'node:test';
import { isJpeg, posterReceiptError } from '../src/lib/poster';

function jpegBytes(): Uint8Array {
  const bytes = new Uint8Array(2048).fill(0x22);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

test('only a real JPEG is accepted as a poster', () => {
  assert.equal(isJpeg(jpegBytes()), true);
  assert.equal(isJpeg(new Uint8Array(2048)), false);
  assert.equal(isJpeg(new Uint8Array(8).fill(0xff)), false);
});

test('a clip cannot be finalized without the poster from this render', () => {
  assert.equal(posterReceiptError({ hasPoster: false, posterBytes: 120_000 }, false)?.code, 'poster_missing');
  assert.equal(posterReceiptError({ hasPoster: true, posterBytes: 0 }, false)?.code, 'poster_missing');
  assert.equal(posterReceiptError({ hasPoster: true, posterBytes: null }, false)?.code, 'poster_missing');
  assert.equal(posterReceiptError({ hasPoster: true, posterBytes: 120_000 }, false), null);
});

test('storage-pool finalization requires the uploaded poster key', () => {
  assert.equal(
    posterReceiptError({ hasPoster: true, posterBytes: 120_000 }, true)?.code,
    'poster_key_missing',
  );
  assert.equal(
    posterReceiptError({ hasPoster: true, posterBytes: 120_000, posterKey: '' }, true)?.code,
    'poster_key_missing',
  );
  assert.equal(
    posterReceiptError(
      { hasPoster: true, posterBytes: 120_000, posterKey: 'projects/p/clips/clip-01-poster.jpg' },
      true,
    ),
    null,
  );
});
