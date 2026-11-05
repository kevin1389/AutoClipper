import { config } from '../env';
import { createHeuristicSelector } from './heuristic';
import { createLlmSelector } from './selector-llm';
import type { ClipSelector } from './types';

export { createHeuristicSelector } from './heuristic';
export { createLlmSelector } from './selector-llm';
export { createOpenAiTranscriber } from './transcription-openai';
export { createLocalWhisperTranscriber } from './transcription-local';
export { createTranscriptionProvider } from './transcription';
export { createFixtureTranscriber } from './fixture';
export { ConfigError, ProviderError } from './types';
export type { ClipSelector, TranscriptionProvider } from './types';

/** LLM when configured, deterministic heuristic otherwise. */
export function createClipSelector(): ClipSelector {
  const cfg = config();
  if (cfg.llm.apiKey) {
    return createLlmSelector({
      apiKey: cfg.llm.apiKey,
      baseUrl: cfg.llm.baseUrl,
      model: cfg.llm.model,
    });
  }
  return createHeuristicSelector();
}
