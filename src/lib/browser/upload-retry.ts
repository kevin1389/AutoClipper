/**
 * Retry policy for clip/poster uploads.
 *
 * Chromium can suspend an in-flight upload when a tab is backgrounded
 * (`net::ERR_NETWORK_IO_SUSPENDED`, surfaced as `TypeError: Failed to fetch`).
 * The same bytes are safe to send again: the upload route stores a new version
 * and finalize selects the newest object. Transient 5xx/429 responses are also
 * retried; deterministic 4xx responses are returned immediately.
 */

export interface FetchRetryOptions {
  /** Total attempts, including the first one. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error.name === 'AbortError') return false;
  const message = error.message.toLowerCase();
  return (
    error instanceof TypeError ||
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('load failed') ||
    message.includes('err_network_io_suspended')
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the final response (successful or non-retryable) or throws the last
 * transport error after every attempt is exhausted. A retryable response body
 * is cancelled so a failed attempt cannot leak a connection.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 4));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 600);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 4_000);
  const sleep = options.sleep ?? wait;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (response.ok || !isRetryableStatus(response.status) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`Upload failed (HTTP ${response.status}).`);
      await response.body?.cancel().catch(() => undefined);
    } catch (caught) {
      lastError = caught instanceof Error ? caught : new Error(String(caught));
      if (init.signal?.aborted) throw lastError;
      if (!isRetryableNetworkError(lastError) || attempt === attempts) throw lastError;
    }

    const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    options.onRetry?.(attempt, lastError ?? new Error('Upload failed.'), delayMs);
    if (delayMs > 0) await sleep(delayMs);
  }

  throw lastError ?? new Error('Upload failed.');
}
