import { randomUUID } from 'node:crypto';
import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { pathExists } from '@/lib/storage';
import { isLocalSourcePath } from '@/lib/upload-limits';
import type { PipelineStage, TimedWord, Transcript, TranscriptSegment } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAGES: PipelineStage[] = ['queued', 'probe', 'audio', 'transcribe', 'select', 'render', 'package', 'done'];

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function validWords(value: unknown): TimedWord[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100_000)
    .map((entry) => {
      const word = entry as { text?: unknown; startMs?: unknown; endMs?: unknown };
      const text = cleanText(word.text, 120).trim();
      const startMs = Math.round(Number(word.startMs));
      const endMs = Math.round(Number(word.endMs));
      if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return { text, startMs: Math.max(0, startMs), endMs: Math.max(1, endMs) };
    })
    .filter((word): word is TimedWord => Boolean(word));
}

function validSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 20_000)
    .map((entry) => {
      const segment = entry as { text?: unknown; startMs?: unknown; endMs?: unknown };
      const text = cleanText(segment.text, 2_000).trim();
      const startMs = Math.round(Number(segment.startMs));
      const endMs = Math.round(Number(segment.endMs));
      if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return { text, startMs: Math.max(0, startMs), endMs: Math.max(1, endMs) };
    })
    .filter((segment): segment is TranscriptSegment => Boolean(segment));
}

async function viewClip(projectId: string, ownerId: string, clipId: string) {
  const { buildProjectView } = await import('@/lib/project-view');
  const view = await buildProjectView(projectId, ownerId);
  return view?.clips.find((clip) => clip.id === clipId) ?? null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  const project = await db.getProjectForOwner(id, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? '');

  if (action === 'start') {
    const sourcePath = await db.getProjectSourcePath(id);
    if (!sourcePath || (!isLocalSourcePath(sourcePath) && !(await pathExists(sourcePath)))) {
      return jsonError(409, 'source_missing', 'Attach a local video or upload a source before starting.');
    }
    if (project.status === 'processing' && body.resume !== true && body.force !== true) {
      return jsonError(409, 'already_processing', 'This project is already processing. Resume only if the original tab was closed.');
    }
    const existingClips = await db.getClips(id);
    const restart = body.restart === true;
    // Reset even when no clips exist: a run can have failed after saving a
    // transcript but before selection, and Re-run must not reuse those words.
    if (restart) await db.resetProjectForRun(id);
    const keptClips = restart ? [] : existingClips;
    const rendered = keptClips.filter((clip) => clip.status === 'rendered').length;
    await db.updateProject(id, {
      status: 'processing',
      stage: keptClips.length > 0 ? 'render' : 'probe',
      progress: 0,
      statusDetail:
        keptClips.length > 0
          ? `Resuming with ${rendered} of ${keptClips.length} clips already rendered`
          : 'Starting browser processor',
      error: null,
    });
    return Response.json({ ok: true, project: await db.getProjectForOwner(id, auth.user.id) });
  }

  if (action === 'probe') {
    const meta = (body.meta ?? {}) as Record<string, unknown>;
    const durationMs = Math.round(Number(meta.durationMs));
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return jsonError(400, 'invalid_video_metadata', 'The source video duration could not be verified.');
    }
    const width = Math.round(Number(meta.width));
    const height = Math.round(Number(meta.height));
    const fps = Number(meta.fps);
    await db.updateProject(id, {
      durationMs,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      fps: Number.isFinite(fps) && fps > 0 ? fps : null,
    });
    return Response.json({ ok: true, project: await db.getProjectForOwner(id, auth.user.id) });
  }

  if (action === 'progress') {
    // A progress POST can still be in flight when the worker fails. Never let a
    // late progress frame turn a terminal failed/completed project back into
    // "processing" — that would hide the actionable error from the user.
    if (project.status === 'failed' || project.status === 'completed') {
      return Response.json({ ok: true, ignored: true });
    }
    const stage = STAGES.includes(String(body.stage) as PipelineStage) ? (String(body.stage) as PipelineStage) : 'probe';
    const progress = Math.max(0, Math.min(100, Math.round(Number(body.progress) || 0)));
    const detail = cleanText(body.detail, 500) || null;
    // Multiple encoder progress callbacks can be in flight. Never let an older
    // frame overwrite a newer one from the same stage.
    const monotonic = project.stage === stage ? Math.max(project.progress, progress) : progress;
    await db.updateProject(id, {
      status: 'processing',
      stage,
      progress: monotonic,
      statusDetail: detail,
      error: null,
    });
    return Response.json({ ok: true });
  }

  if (action === 'transcript') {
    const words = validWords(body.transcript && (body.transcript as Record<string, unknown>).words);
    const segments = validSegments(body.transcript && (body.transcript as Record<string, unknown>).segments);
    if (words.length === 0) return jsonError(400, 'empty_transcript', 'No word-level transcript was supplied.');
    // A segment-level Whisper response is expanded in the browser; persist that
    // honestly instead of always claiming provider-precise word timing.
    const timing: 'provider' | 'estimated' =
      (body.transcript as Record<string, unknown> | undefined)?.timing === 'estimated'
        ? 'estimated'
        : 'provider';
    const transcript: Transcript = {
      provider: cleanText((body.transcript as Record<string, unknown>)?.provider, 200) || 'browser-whisper',
      language: cleanText((body.transcript as Record<string, unknown>)?.language, 30) || null,
      timing,
      text: cleanText((body.transcript as Record<string, unknown>)?.text, 500_000),
      words,
      segments,
    };
    const meta = (body.meta ?? {}) as Record<string, unknown>;
    await db.saveTranscript(id, transcript);
    await db.updateProject(id, {
      language: transcript.language,
      transcriptionProvider: transcript.provider,
      timingSource: timing,
      durationMs: Number.isFinite(Number(meta.durationMs)) ? Math.round(Number(meta.durationMs)) : undefined,
      width: Number.isFinite(Number(meta.width)) ? Math.round(Number(meta.width)) : undefined,
      height: Number.isFinite(Number(meta.height)) ? Math.round(Number(meta.height)) : undefined,
      fps: Number.isFinite(Number(meta.fps)) ? Number(meta.fps) : undefined,
      error: null,
    });
    return Response.json({ ok: true, wordCount: words.length });
  }

  if (action === 'selection') {
    const input = Array.isArray(body.clips) ? body.clips.slice(0, 10) : [];
    if (input.length === 0) return jsonError(400, 'empty_selection', 'No selected clips were supplied.');
    const clips = input.map((entry) => {
      const clip = entry as Record<string, unknown>;
      return {
        id: randomUUID(),
        title: cleanText(clip.title, 120) || 'Untitled highlight',
        reason: cleanText(clip.reason, 1_000),
        hook: cleanText(clip.hook, 500),
        startMs: Math.max(0, Math.round(Number(clip.startMs) || 0)),
        endMs: Math.max(1, Math.round(Number(clip.endMs) || 0)),
        score: Number.isFinite(Number(clip.score)) ? Number(clip.score) : 0,
        scoreBreakdown: (clip.scoreBreakdown ?? null) as never,
        evidence: Array.isArray(clip.evidence) ? clip.evidence.slice(0, 20).map((item) => cleanText(item, 300)) : [],
      };
    }).filter((clip) => clip.endMs > clip.startMs + 3_000);
    if (clips.length === 0) return jsonError(400, 'invalid_selection', 'Selected clips must be at least 4 seconds long.');
    const saved = await db.replaceClips(id, clips);
    await db.updateProject(id, {
      selectionEngine: cleanText(body.selectionEngine, 120) || 'browser-multi-signal-heuristic',
      stage: 'render',
      progress: 65,
      error: null,
    });
    return Response.json({ ok: true, clips: saved });
  }

  if (action === 'complete') {
    const clips = await db.getClips(id);
    const rendered = clips.filter((clip) => clip.status === 'rendered').length;
    if (clips.length === 0 || rendered !== clips.length) {
      return jsonError(
        409,
        'incomplete_render',
        `Only ${rendered} of ${clips.length} selected clips have verified rendered files. The project was not marked complete.`,
      );
    }
    await db.updateProject(id, {
      status: 'completed',
      stage: 'done',
      progress: 100,
      statusDetail: `${rendered} clip${rendered === 1 ? '' : 's'} ready`,
      error: null,
    });
    return Response.json({ ok: true, project: await db.getProjectForOwner(id, auth.user.id) });
  }

  if (action === 'fail') {
    const stage = STAGES.includes(String(body.stage) as PipelineStage)
      ? (String(body.stage) as PipelineStage)
      : project.stage;
    await db.updateProject(id, {
      status: 'failed',
      stage,
      error: cleanText(body.error, 1_500) || 'Browser processing failed.',
      statusDetail: null,
    });
    return Response.json({ ok: true });
  }

  return jsonError(400, 'unknown_action', 'Unknown processing action.');
}
