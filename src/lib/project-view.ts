import * as db from './db';
import { pathExists } from './storage';
import { isLocalSourcePath } from './upload-limits';
import type { ClipView, ProjectView } from './types';

/** Builds everything the browser needs for a project, without leaking server paths. */
export async function buildProjectView(projectId: string, ownerId: string): Promise<ProjectView | null> {
  const project = await db.getProjectForOwner(projectId, ownerId);
  if (!project) return null;

  const clips = await db.getClips(projectId);
  const transcript = await db.getTranscript(projectId);
  const sourcePath = await db.getProjectSourcePath(projectId);
  const sourceMode: ProjectView['sourceMode'] = isLocalSourcePath(sourcePath)
    ? 'local'
    : sourcePath
      ? 'remote'
      : 'none';

  /**
   * The excerpt a clip's captions came from. Derived from the same word timings
   * the renderer uses, so the editor never shows text that was not spoken there.
   */
  const transcriptTextFor = (startMs: number, endMs: number): string => {
    if (!transcript) return '';
    return transcript.words
      .filter((word) => word.endMs > startMs && word.startMs < endMs)
      .map((word) => word.text)
      .join(' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim()
      .slice(0, 600);
  };

  const clipViews: ClipView[] = [];
  for (const clip of clips) {
    const detailed = await db.getClipForOwner(clip.id, ownerId);
    const hasPoster = detailed?.posterPath ? await pathExists(detailed.posterPath) : false;
    const edits = clip.edits;
    clipViews.push({
      ...clip,
      videoUrl: `/api/clips/${clip.id}/video`,
      posterUrl: clip.status === 'rendered' && hasPoster ? `/api/clips/${clip.id}/poster` : null,
      downloadUrl: `/api/clips/${clip.id}/video?download=1`,
      transcriptText:
        edits?.captionText?.trim() ||
        transcriptTextFor(edits?.startMs ?? clip.startMs, edits?.endMs ?? clip.endMs),
    });
  }

  const renderedCount = clips.filter((clip) => clip.status === 'rendered').length;

  return {
    project,
    sourceMode,
    clips: clipViews,
    job: db.toProjectJob(await db.getLatestJob(projectId)),
    transcript: transcript
      ? {
          provider: transcript.provider,
          language: transcript.language,
          timing: transcript.timing,
          text: transcript.text.slice(0, 12_000),
          wordCount: transcript.words.length,
        }
      : null,
    // Retained for compatibility with older clients. Processing is now owned
    // by the open browser tab, so no background worker heartbeat is required.
    workerOnline: false,
    blocker: null,
    downloadAllUrl: renderedCount > 0 ? `/api/projects/${projectId}/download` : null,
  };
}
