import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWithRetry,
  isRetryableNetworkError,
  isRetryableStatus,
} from '../src/lib/browser/upload-retry';

const noSleep = async () => undefined;

test('retries transient 5xx responses and returns the successful response', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return calls < 3
      ? new Response('busy', { status: calls === 1 ? 503 : 502 })
      : new Response('ok', { status: 200 });
  }) as typeof fetch;
  const response = await fetchWithRetry('http://local/upload', { method: 'PUT' }, {
    fetchImpl,
    sleep: noSleep,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test('retries a suspended-network TypeError and preserves the body for every attempt', async () => {
  let calls = 0;
  const bodies: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    bodies.push(String(init?.body));
    if (calls < 3) throw new TypeError('Failed to fetch');
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const retries: number[] = [];
  const response = await fetchWithRetry(
    'http://local/upload',
    { method: 'PUT', body: 'clip-bytes' },
    {
      fetchImpl,
      sleep: noSleep,
      onRetry: (attempt) => retries.push(attempt),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(bodies, ['clip-bytes', 'clip-bytes', 'clip-bytes']);
  assert.deepEqual(retries, [1, 2]);
});

test('does not retry a deterministic 4xx response', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('bad request', { status: 400 });
  }) as typeof fetch;
  const response = await fetchWithRetry('http://local/upload', {}, { fetchImpl, sleep: noSleep });
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});

test('returns the last retryable response after the final attempt and uses exponential backoff', async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('down', { status: 503 });
  }) as typeof fetch;
  const response = await fetchWithRetry('http://local/upload', {}, {
    fetchImpl,
    attempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('an aborted request is not retried', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }) as typeof fetch;
  await assert.rejects(
    fetchWithRetry('http://local/upload', {}, { fetchImpl, sleep: noSleep }),
    /aborted/,
  );
  assert.equal(calls, 1);
});

test('retry classification covers suspension and does not include client errors', () => {
  assert.ok(isRetryableStatus(503));
  assert.ok(isRetryableStatus(429));
  assert.ok(!isRetryableStatus(400));
  assert.ok(!isRetryableStatus(413));
  assert.ok(isRetryableNetworkError(new TypeError('Failed to fetch')));
  assert.ok(isRetryableNetworkError(new Error('net::ERR_NETWORK_IO_SUSPENDED')));
  assert.ok(!isRetryableNetworkError(new Error('The clip was rejected.')));
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  assert.ok(!isRetryableNetworkError(aborted));
});
