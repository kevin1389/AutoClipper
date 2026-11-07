import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createClipSelector, createHeuristicSelector, createFixtureTranscriber, createTranscriptionProvider } from './ai';
import type { ClipSelector, TranscriptionProvider } from './ai/types';
import { ConfigError, ProviderError } from './ai/types';
import { config, processingBlocker } from './env';
import * as db from './db';
import { extractAudio, MediaCommandError, MediaToolMissingError, probeMedia, segmentAudio } from './media/ffmpeg';
import { loadMediaSignals, renderClipWithContext, type RenderContext } from './render';
import { progressFor } from './stages';
import { ensureProjectDirs, pathExists } from './storage';
import type { PipelineStage, SelectedClip, TimedWord, Transcript, TranscriptSegment } from './types';

export class PipelineError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly retryable: boolean;
  constructor(code: string, message: string, options: { hint?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.hint = options.hint ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export type PipelineStageKey = Exclude<PipelineStage, 'queued' | 'done'>;

export interface ProgressUpdate {
  stage: PipelineStageKey;
  fraction: number;
  detail: string;
}

export interface RunPipelineOptions {
  projectId: string;
  transcribe?: TranscriptionProvider;
  select?: ClipSelector;
  onProgress?: (update: ProgressUpdate) => void | Promise<void>;
}

export interface RunPipelineResult {
  clipCount: number;
  renderedCount: number;
  failedClips: number;
  transcriptProvider: string;
  selectionEngine: string;
  timing: 'provider' | 'estimated';
}

const TARGET_CLIP_COUNT = 8;
const MIN_SOURCE_DURATION_MS = 5_000;

function resolveTranscriber(): TranscriptionProvider {
  const cfg = config();
  if (cfg.transcription.provider === 'fixture') {
    // Synthetic transcripts must never reach a real run. The fixture transcriber
    // is a development harness: it needs an explicit opt-in and is refused
    // outright in production, whatever the provider setting says.
    if (!cfg.allowFixtureTranscriber) {
      throw new PipelineError(
        'fixture_disabled',
        'The fixture transcriber is development-only and is disabled here. Set TRANSCRIPTION_PROVIDER=openai-compatible and TRANSCRIPTION_API_KEY to process real speech.',
      );
    }
    const fixturePath = process.env.AC_FIXTURE_TRANSCRIPT_PATH;
    if (!fixturePath) {
      throw new PipelineError(
        'fixture_missing',
        'TRANSCRIPTION_PROVIDER=fixture is set but AC_FIXTURE_TRANSCRIPT_PATH is missing.',
      );
    }
    return createFixtureTranscriber(fixturePath);
  }
  try {
    return createTranscriptionProvider();
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new PipelineError(error.code, error.message, {
        hint: 'Add TRANSCRIPTION_API_KEY to .env and restart the web server and worker.',
      });
    }
    throw error;
  }
}

function toPipelineError(error: unknown): PipelineError {
  if (error instanceof PipelineError) return error;
  if (error instanceof MediaToolMissingError) {
    return new PipelineError(
      'media_tool_missing',
      `${error.message}. Install FFmpeg/ffprobe or set FFMPEG_PATH/FFPROBE_PATH.`,
    );
  }
  if (error instanceof MediaCommandError) {
    return new PipelineError(
      'media_command_failed',
      `Video processing failed: ${error.message}${error.stderrTail ? ` (${error.stderrTail.split('\n').slice(-2).join(' ')})` : ''}`,
    );
  }
  if (error instanceof ProviderError) {
    return new PipelineError(error.code, error.message, { retryable: error.retryable });
  }
  if (error instanceof ConfigError) {
    return new PipelineError(error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PipelineError('pipeline_failed', message);
}

/**
 * Runs the full media pipeline for a project. Every stage persists its output,
 * so a crash leaves an accurate status behind rather than a "succeeded" project
 * with no files.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<RunPipelineResult> {
  const { projectId } = options;
  const project = await db.getProject(projectId);
  if (!project) throw new PipelineError('project_missing', 'That project no longer exists.');
  const sourcePath = await db.getProjectSourcePath(projectId);
  if (!sourcePath || !(await pathExists(sourcePath))) {
    throw new PipelineError(
      'source_missing',
      'No uploaded video was found for this project. Upload the file again.',
    );
  }

  // A job must never run without a working provider. This also catches jobs that
  // were queued before the configuration changed, and keeps a deployment with no
  // API key from silently producing anything at all.
  if (!options.transcribe) {
    const blocker = processingBlocker();
    if (blocker) throw new PipelineError(blocker.code, blocker.message);
  }

  const transcribe = options.transcribe ?? resolveTranscriber();
  const selector = options.select ?? createClipSelector();
  const dirs = await ensureProjectDirs(projectId);

  const report = async (stage: PipelineStageKey, fraction: number, detail: string) => {
    await options.onProgress?.({ stage, fraction, detail });
    await db.updateProject(projectId, {
      status: 'processing',
      stage,
      progress: progressFor(stage, fraction),
      statusDetail: detail,
      error: null,
    });
  };

  await db.updateProject(projectId, {
    status: 'processing',
    stage: 'probe',
    progress: 0,
    error: null,
    statusDetail: 'Inspecting source video',
  });

  try {
    /* ---------------------------------------------------------------- probe */
    await report('probe', 0.2, 'Reading video metadata');
    const probe = await probeMedia(sourcePath);
    if (!probe.durationMs || probe.durationMs < MIN_SOURCE_DURATION_MS) {
      throw new PipelineError(
        'source_too_short',
        'This video is shorter than 5 seconds, so there is nothing to clip.',
      );
    }
    if (!probe.hasAudio) {
      throw new PipelineError(
        'no_audio_track',
        'This video has no audio track. AutoClipper needs speech to transcribe and find highlights.',
      );
    }
    await db.updateProject(projectId, {
      durationMs: probe.durationMs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
    });
    await report('probe', 1, `${probe.width}×${probe.height}, ${Math.round(probe.durationMs / 1000)}s`);

    /* ---------------------------------------------------------------- audio */
    await report('audio', 0.1, 'Extracting speech track');
    const audioPath = await extractAudio(sourcePath, path.join(dirs.work, 'audio.mp3'));
    const chunkSeconds = Math.max(60, config().transcription.chunkSeconds);
    const needsChunking = probe.durationMs > chunkSeconds * 1000;

    const chunks: { path: string; offsetMs: number; durationMs: number }[] = [];
    if (needsChunking) {
      await report('audio', 0.5, 'Splitting audio into provider-sized chunks');
      const extension = path.extname(audioPath) || '.mp3';
      const chunkFiles = await segmentAudio(
        audioPath,
        path.join(dirs.work, 'chunks', `chunk-%03d${extension}`),
        chunkSeconds,
      );
      for (let index = 0; index < chunkFiles.length; index += 1) {
        const offsetMs = index * chunkSeconds * 1000;
        let durationMs = Math.min(chunkSeconds * 1000, Math.max(0, probe.durationMs - offsetMs));
        try {
          const chunkProbe = await probeMedia(chunkFiles[index]);
          if (chunkProbe.durationMs > 0) durationMs = chunkProbe.durationMs;
        } catch {
          // keep estimate
        }
        chunks.push({ path: chunkFiles[index], offsetMs, durationMs });
      }
      if (chunks.length === 0) {
        throw new PipelineError('audio_extraction_failed', 'Audio chunking produced no files.');
      }
    } else {
      chunks.push({ path: audioPath, offsetMs: 0, durationMs: probe.durationMs });
    }
    await report('audio', 1, `${chunks.length} audio chunk${chunks.length === 1 ? '' : 's'}`);

    /* ----------------------------------------------------------- transcribe */
    const allWords: TimedWord[] = [];
    const allSegments: TranscriptSegment[] = [];
    let language: string | null = null;
    let timing: 'provider' | 'estimated' = 'provider';
    let textParts: string[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await report(
        'transcribe',
        index / chunks.length,
        `Transcribing audio ${index + 1} of ${chunks.length}`,
      );
      const result = await transcribe.transcribeChunk({
        audioPath: chunk.path,
        mimeType: chunk.path.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg',
        offsetMs: chunk.offsetMs,
        durationMs: chunk.durationMs,
      });
      allWords.push(...result.words);
      allSegments.push(...result.segments);
      if (result.text.trim()) textParts.push(result.text.trim());
      if (!language && result.language) language = result.language;
      if (result.timing === 'estimated') timing = 'estimated';
    }

    allWords.sort((a, b) => a.startMs - b.startMs);
    allSegments.sort((a, b) => a.startMs - b.startMs);

    if (allWords.length === 0) {
      throw new PipelineError(
        'empty_transcript',
        'No speech was recognized in this video, so no highlights could be found.',
        { hint: 'Upload a video where people are speaking, or check the transcription provider settings.' },
      );
    }

    const transcript: Transcript = {
      text: textParts.join(' ').replace(/\s+/g, ' ').trim(),
      language,
      words: allWords,
      segments: allSegments,
      timing,
      provider: transcribe.label,
    };
    await db.saveTranscript(projectId, transcript);
    await db.updateProject(projectId, {
      transcriptionProvider: transcribe.label.slice(0, 200),
      timingSource: timing,
      language,
    });
    await report(
      'transcribe',
      1,
      `${allWords.length} words transcribed${timing === 'estimated' ? ' (estimated word timing)' : ''}`,
    );

    // Audio chunks are large; once the transcript is stored they are expendable.
    await fsp.rm(path.join(dirs.work, 'chunks'), { recursive: true, force: true });
    if (needsChunking) await fsp.rm(audioPath, { force: true });

    /* --------------------------------------------------------------- select */
    await report('select', 0.1, 'Analysing audio peaks and visual changes');
    // Real measured signals: RMS loudness per second and FFmpeg scene changes.
    // Selection and the edit planner both use them; empty is a valid answer.
    const signals = await loadMediaSignals(projectId, sourcePath, dirs.work);

    await report('select', 0.3, 'Scoring hooks, engagement, clarity, context, payoff and pacing; ranking strongest first');
    let selectionEngine = selector.label;
    let selected: SelectedClip[] = [];
    try {
      selected = await selector.select({
        words: allWords,
        segments: allSegments,
        durationMs: probe.durationMs,
        targetCount: TARGET_CLIP_COUNT,
        signals,
      });
      if (selected.length === 0) {
        throw new ProviderError('selection_empty', 'The highlight selector returned no clips.');
      }
    } catch (error) {
      if (selector.id === 'heuristic') throw error;
      const fallback = createHeuristicSelector();
      selected = await fallback.select({
        words: allWords,
        segments: allSegments,
        durationMs: probe.durationMs,
        targetCount: TARGET_CLIP_COUNT,
        signals,
      });
      if (selected.length === 0) throw error;
      selectionEngine = `${fallback.label} — fallback after: ${
        error instanceof Error ? error.message.slice(0, 160) : 'unknown error'
      }`;
    }

    const withIds = selected.map((clip) => ({ ...clip, id: randomUUID() }));
    const storedClips = await db.replaceClips(projectId, withIds);
    await db.updateProject(projectId, { selectionEngine: selectionEngine.slice(0, 300) });
    await report('select', 1, `${storedClips.length} highlights selected`);

    /* --------------------------------------------------------------- render */
    let renderedCount = 0;
    let firstRenderError: string | null = null;
    const context: RenderContext = {
      project,
      sourcePath,
      probe,
      words: allWords,
      signals,
      dirs,
    };

    for (let index = 0; index < storedClips.length; index += 1) {
      const clip = storedClips[index];
      await report(
        'render',
        index / storedClips.length,
        `Rendering clip ${index + 1} of ${storedClips.length}`,
      );

      try {
        await renderClipWithContext(context, clip);
        renderedCount += 1;
      } catch (error) {
        const message = toPipelineError(error).message;
        if (!firstRenderError) firstRenderError = message;
        await db.updateClip(clip.id, { status: 'failed', error: message.slice(0, 500) });
      }
    }

    await fsp.rm(path.join(dirs.work, 'audio.mp3'), { force: true });

    if (renderedCount === 0) {
      throw new PipelineError(
        'render_failed',
        'Every clip failed to render, so no video files were produced.',
        { hint: firstRenderError ?? undefined },
      );
    }

    /* -------------------------------------------------------------- package */
    await db.updateProject(projectId, {
      status: 'completed',
      stage: 'done',
      progress: 100,
      statusDetail: `${renderedCount} of ${storedClips.length} clips rendered`,
      error: null,
    });

    return {
      clipCount: storedClips.length,
      renderedCount,
      failedClips: storedClips.length - renderedCount,
      transcriptProvider: transcribe.label,
      selectionEngine,
      timing,
    };
  } catch (error) {
    const pipelineError = toPipelineError(error);
    // Persist the failure so a project is never left looking like it is still
    // working (or worse, finished) after the pipeline stopped.
    await db.updateProject(projectId, {
      status: 'failed',
      error: pipelineError.message.slice(0, 1500),
      statusDetail: null,
    });
    throw pipelineError;
  }
}
