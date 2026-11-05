import { config } from '../env';
import { createLocalWhisperTranscriber } from './transcription-local';
import { createOpenAiTranscriber } from './transcription-openai';
import { ConfigError, type TranscriptionProvider } from './types';

/**
 * Chooses the transcription engine.
 *
 * `local-whisper` is the default so the app works with no paid API: the worker
 * runs Faster-Whisper on its own CPU. `openai-compatible` stays available for
 * anyone who prefers a hosted provider, and `fixture` is only ever constructed
 * explicitly by the test harness.
 */
export function createTranscriptionProvider(): TranscriptionProvider {
  const cfg = config();
  const provider = cfg.transcription.provider;
  const whisper = cfg.transcription.whisper;

  if (provider === 'local-whisper') {
    if (!cfg.ffmpegPath) {
      throw new ConfigError(
        'ffmpeg_missing',
        'Local transcription needs FFmpeg to decode audio, but no ffmpeg binary was found.',
      );
    }
    return createLocalWhisperTranscriber({
      pythonPath: whisper.pythonPath,
      helperPath: whisper.helperPath,
      model: whisper.model,
      device: whisper.device,
      computeType: whisper.computeType,
      modelDir: whisper.modelDir,
      threads: whisper.threads,
      language: cfg.transcription.language,
      ffmpegPath: cfg.ffmpegPath,
    });
  }

  if (provider === 'openai-compatible') {
    if (!cfg.transcription.apiKey) {
      throw new ConfigError(
        'transcription_not_configured',
        'TRANSCRIPTION_PROVIDER=openai-compatible requires TRANSCRIPTION_API_KEY. Use the default local-whisper provider to avoid paid services.',
      );
    }
    return createOpenAiTranscriber({
      apiKey: cfg.transcription.apiKey,
      baseUrl: cfg.transcription.baseUrl,
      model: cfg.transcription.model,
      language: cfg.transcription.language,
    });
  }

  if (provider === 'fixture') {
    throw new ConfigError(
      'fixture_provider',
      'The fixture transcriber must be constructed explicitly (test harness only).',
    );
  }

  throw new ConfigError(
    'unknown_transcription_provider',
    `Unknown TRANSCRIPTION_PROVIDER "${provider}". Supported: local-whisper (default), openai-compatible, fixture (tests only).`,
  );
}
