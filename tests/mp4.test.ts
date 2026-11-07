import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMp4 } from '../src/lib/mp4';

function box(type: string, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength, false);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function ftyp(brand = 'isom'): Uint8Array {
  const payload = new Uint8Array(8);
  payload.set(new TextEncoder().encode(brand), 0);
  return box('ftyp', payload);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

test('accepts a faststart MP4 with ftyp, moov and mdat', () => {
  const inspection = inspectMp4(concat(ftyp(), box('moov'), box('mdat', new Uint8Array(32))));
  assert.equal(inspection.valid, true);
  assert.equal(inspection.faststart, true);
  assert.equal(inspection.brand, 'isom');
});

test('rejects an MP4 whose moov atom comes after mdat', () => {
  const inspection = inspectMp4(concat(ftyp(), box('mdat', new Uint8Array(32)), box('moov')));
  assert.equal(inspection.valid, false);
  assert.match(inspection.reason ?? '', /not faststart/);
});

test('rejects truncated and empty objects', () => {
  assert.match(inspectMp4(new Uint8Array()).reason ?? '', /too small/);
  const truncated = concat(ftyp(), box('moov'));
  truncated[20] = 0;
  const inspection = inspectMp4(truncated.subarray(0, 20));
  assert.equal(inspection.valid, false);
});

test('rejects non-MP4 bytes and unknown brands', () => {
  assert.equal(inspectMp4(new TextEncoder().encode('<html>not a video</html>')).valid, false);
  assert.equal(inspectMp4(concat(ftyp('webm'), box('moov'), box('mdat'))).valid, false);
});

test('requires media data, not just headers', () => {
  const inspection = inspectMp4(concat(ftyp(), box('moov')));
  assert.equal(inspection.valid, false);
  assert.match(inspection.reason ?? '', /media data/);
});