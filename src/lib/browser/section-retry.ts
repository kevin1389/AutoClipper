export interface SectionRetryHooks {
  label: string;
  onRetry?: (attempt: number, error: Error) => void;
  /** Tests use zero; production waits briefly for transient pressure to clear. */
  delayMs?: number;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Retry one bounded audio/transcription section once. Audio extraction is
 * repeated from the original source; transcription may reuse the already
 * bounded section. The failed attempt is allowed to settle before the retry.
 */
export async function retrySection<T>(task: () => Promise<T>, hooks: SectionRetryHooks): Promise<T> {
  try {
    return await task();
  } catch (first) {
    const error = asError(first);
    hooks.onRetry?.(1, error);
    if ((hooks.delayMs ?? 500) > 0) {
      await new Promise((resolve) => setTimeout(resolve, hooks.delayMs ?? 500));
    }
    try {
      return await task();
    } catch (second) {
      const finalError = asError(second);
      throw new Error(
        `${hooks.label} failed after 2 attempts: ${finalError.message || error.message}`,
        { cause: finalError },
      );
    }
  }
}
