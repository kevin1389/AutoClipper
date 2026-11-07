import fsp from 'node:fs/promises';
import path from 'node:path';
import * as db from './db';
import { buildAssCaptions } from './captions/ass';
import { buildEditPlan, DEFAULT_EDITS, type EditPlan } from './edit/plan';
import { probeMedia, renderEditedClip, type MediaProbe } from './media/ffmpeg';
import { analyzeMediaSignals, EMPTY_SIGNALS, type MediaSignals } from './media/signals';
import { ensureProjectDirs, pathExists } from './storage';
import type { Clip, ClipEdits, ClipEffects, Project, TimedWord } from './types';

/**
 * Clip rendering service.
 *
 * Both the background pipeline and the per-clip editor endpoint go through this
 * module, so an edited clip and a freshly generated clip are produced by exactly
 * the same code path and the same effect planner.
 */

export interface RenderContext {
  project: Project;
  sourcePath: string;
  probe: MediaProbe;
  words: TimedWord[];
  signals: MediaSignals;
  dirs: { base: string; source: string; work: string; clips: string };
}

const SIGNALS_FILE = 'media-signals.json';

async function loadSignals(projectId: string, sourcePath: string, workDir: string): Promise<MediaSignals> {
  const cachePath = path.join(workDir, SIGNALS_FILE);
  try {
    const stat = await fsp.stat(cachePath);
    const sourceStat = await fsp.stat(sourcePath);
    if (stat.mtimeMs >= sourceStat.mtimeMs) {
      const cached = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as MediaSignals;
      if (Array.isArray(cached.audio) && Array.isArray(cached.sceneChangesMs)) return cached;
    }
  } catch {
    // no cache yet
  }

  const signals = await analyzeMediaSignals(sourcePath);
  const usable = signals.audio.length > 0 ? signals : EMPTY_SIGNALS;
  await fsp.mkdir(workDir, { recursive: true }).catch(() => undefined);
  await fsp.writeFile(cachePath, JSON.stringify(usable), 'utf8').catch(() => undefined);
  return usable;
}

export async function loadRenderContext(projectId: string): Promise<RenderContext> {
  const project = await db.getProject(projectId);
  if (!project) throw new Error('project_missing');
  const sourcePath = await db.getProjectSourcePath(projectId);
  if (!sourcePath || !(await pathExists(sourcePath))) throw new Error('source_missing');

  const transcript = await db.getTranscript(projectId);
  if (!transcript || transcript.words.length === 0) throw new Error('transcript_missing');

  const probe = await probeMedia(sourcePath);
  const dirs = await ensureProjectDirs(projectId);
  const signals = await loadSignals(projectId, sourcePath, dirs.work);

  return { project, sourcePath, probe, words: transcript.words, signals, dirs };
}

export function resolveEdits(clip: Clip): ClipEdits {
  const base = clip.edits;
  return {
    ...DEFAULT_EDITS,
    startMs: base?.startMs ?? clip.startMs,
    endMs: base?.endMs ?? clip.endMs,
    captionText: base?.captionText ?? null,
    zoomEnabled: base?.zoomEnabled ?? true,
    zoomIntensity: base?.zoomIntensity ?? 1,
    slowMotionEnabled: base?.slowMotionEnabled ?? false,
  };
}

export function planClip(context: RenderContext, clip: Clip, edits?: ClipEdits): EditPlan {
  const resolved = edits ?? resolveEdits(clip);
  return buildEditPlan({
    words: context.words,
    startMs: resolved.startMs,
    endMs: resolved.endMs,
    options: resolved,
    signals: context.signals,
  });
}

export function effectsFor(plan: EditPlan, edits: ClipEdits): ClipEffects {
  return {
    zoomWindows: plan.zooms,
    slowMotion: plan.slowMotion,
    removedPausesMs: plan.removedPauses.reduce((sum, pause) => sum + (pause.endMs - pause.startMs), 0),
    outputDurationMs: plan.outputDurationMs,
    captionsEdited: Boolean(edits.captionText && edits.captionText.trim()),
    framing: plan.framing,
  };
}

export async function renderClipWithContext(
  context: RenderContext,
  clip: Clip,
  edits?: ClipEdits,
): Promise<Clip> {
  const resolved = edits ?? resolveEdits(clip);
  const plan = planClip(context, clip, resolved);

  const workDir = path.join(context.dirs.work, `clip-${String(clip.index + 1).padStart(2, '0')}`);
  await fsp.mkdir(workDir, { recursive: true });
  const outputPath = path.join(context.dirs.clips, `clip-${String(clip.index + 1).padStart(2, '0')}.mp4`);

  const captions = buildAssCaptions(plan.captionWords, {
    startMs: 0,
    endMs: plan.outputDurationMs,
    highlightKeywords: true,
  });

  let assFileName: string | null = null;
  if (captions.cueCount > 0) {
    await fsp.writeFile(path.join(workDir, 'captions.ass'), captions.ass, 'utf8');
    assFileName = 'captions.ass';
  }

  const result = await renderEditedClip(
    {
      sourcePath: context.sourcePath,
      outputPath,
      plan,
      sourceWidth: context.probe.width,
      sourceHeight: context.probe.height,
      hasAudio: context.probe.hasAudio,
      workDir,
    },
    assFileName,
  );

  const effects = effectsFor(plan, resolved);
  await db.updateClip(clip.id, {
    status: 'rendered',
    error: null,
    filePath: outputPath,
    posterPath: result.posterPath,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    durationMs: result.durationMs,
    captionMode: result.captionMode === 'burned-in' ? `burned-in (${captions.cueCount} cues)` : 'none',
    cropStrategy: result.cropStrategy,
    edits: resolved,
    effects,
  });

  const updated = await db.getClip(clip.id);
  if (!updated) throw new Error('clip_missing');
  return (await db.getClips(context.project.id)).find((entry) => entry.id === clip.id) ?? updated;
}

/** Renders one clip by id, loading everything it needs from the database. */
export async function renderClipById(clipId: string): Promise<Clip> {
  const clip = await db.getClip(clipId);
  if (!clip) throw new Error('clip_missing');
  const context = await loadRenderContext(clip.projectId);
  return renderClipWithContext(context, (await db.getClip(clipId)) as unknown as Clip);
}

/** Exposed so the pipeline can analyse signals once, before selection. */
export async function loadMediaSignals(projectId: string, sourcePath: string, workDir: string): Promise<MediaSignals> {
  return loadSignals(projectId, sourcePath, workDir);
}
