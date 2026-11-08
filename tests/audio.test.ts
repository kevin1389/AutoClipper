import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav } from '../src/lib/browser/audio';

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function makeWav(channels: number[][], sampleRate = 16_000): Uint8Array {
  const frames = channels[0].length;
  const channelCount = channels.length;
  const dataBytes = frames * channelCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = Math.max(-32768, Math.min(32767, Math.round(channels[channel][frame] * 32768)));
      view.setInt16(offset, value, true);
      offset += 2;
    }
  }
  return bytes;
}

test('decodes mono 16-bit PCM with the fast typed-array path', () => {
  const input = [0, 0.5, -0.5, 0.25, -0.25, 1, -1];
  const decoded = decodeWav(makeWav([input]));
  assert.equal(decoded.sampleRate, 16_000);
  assert.equal(decoded.samples.length, input.length);
  assert.equal(decoded.durationMs, 0);
  for (let index = 0; index < input.length; index += 1) {
    assert.ok(Math.abs(decoded.samples[index] - input[index]) <= 1 / 32768 + 1e-12);
  }
});

test('decodes and averages stereo PCM', () => {
  const left = [0.5, -0.5, 0.25];
  const right = [-0.5, 0.5, 0.75];
  const decoded = decodeWav(makeWav([left, right]));
  assert.equal(decoded.samples.length, 3);
  assert.ok(Math.abs(decoded.samples[0]) < 1e-9);
  assert.ok(Math.abs(decoded.samples[1]) < 1e-9);
  assert.ok(Math.abs(decoded.samples[2] - 0.5) < 1 / 32768);
});

test('rejects a non-WAV buffer', () => {
  assert.throws(() => decodeWav(new Uint8Array(64)), /invalid WAV/);
});
