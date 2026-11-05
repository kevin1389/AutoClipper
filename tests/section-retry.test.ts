import test from 'node:test';
import assert from 'node:assert/strict';
import { retrySection } from '../src/lib/browser/section-retry';

test('a successful section runs once without a retry notice', async () => {
  let calls = 0;
  let retries = 0;
  const result = await retrySection(async () => {
    calls += 1;
    return 'ok';
  }, {
    label: 'audio section 1',
    delayMs: 0,
    onRetry: () => {
      retries += 1;
    },
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
  assert.equal(retries, 0);
});

test('a transient section failure is retried once and can succeed', async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await retrySection(async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary decode pressure');
    return 'recovered';
  }, {
    label: 'audio section 2',
    delayMs: 0,
    onRetry: (attempt, error) => {
      retries.push(attempt);
      assert.match(error.message, /temporary decode pressure/);
    },
  });
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
  assert.deepEqual(retries, [1]);
});

test('a section that fails twice reports both attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () => retrySection(async () => {
      calls += 1;
      throw new Error(`failure ${calls}`);
    }, { label: 'transcription section 3', delayMs: 0 }),
    /transcription section 3 failed after 2 attempts: failure 2/,
  );
  assert.equal(calls, 2);
});
