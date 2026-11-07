export type ProjectSourceKind = 'upload' | 'youtube';

export type ProjectStatus =
  | 'draft' // project created, source not uploaded yet
  | 'ready' // source present, waiting for the user to start
  | 'queued' // job enqueued, waiting for a worker
  | 'processing'
  | 'completed'
  | 'failed';

export type PipelineStage =
  | 'queued'
  | 'probe'
  | 'audio'
  | 'transcribe'
  | 'select'
  | 'render'
  | 'package'
  | 'done';

export type ClipStatus = 'pending' | 'rendered' | 'failed';

export interface Project {
  id: string;
  title: string;
  sourceKind: ProjectSourceKind;
  sourceUrl: string | null;
  status: ProjectStatus;
  stage: PipelineStage;
  progress: number;
  statusDetail: string | null;
  error: string | null;

  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  language: string | null;

  sourceFileName: string | null;
  sourceBytes: number | null;
  sourceMime: string | null;

  transcriptionProvider: string | null;
  selectionEngine: string | null;
  timingSource: 'provider' | 'estimated' | null;

  createdAt: string;
  updatedAt: string;
}

export type ClipScoreDimension =
  | 'hook'
  | 'engagement'
  | 'clarity'
  | 'substance'
  | 'context'
  | 'payoff'
  | 'pacing';

/** Explainable score components (0-1 each) produced by the selector. */
export interface ClipScoreBreakdown {
  hook: number;
  engagement: number;
  clarity: number;
  substance: number;
  context: number;
  payoff: number;
  pacing: number;
  total: number;
  /** Older persisted clips used this name before engagement became explicit. */
  entertainment?: number;
}

/** User overrides for a rendered clip. Persisted so a re-render is repeatable. */
export interface ClipEdits {
  startMs: number;
  endMs: number;
  /** Replacement caption text; null keeps the transcript-derived captions. */
  captionText: string | null;
  zoomEnabled: boolean;
  /** 0.4–2; 1 is the default punch-in amount. */
  zoomIntensity: number;
  slowMotionEnabled: boolean;
}

export interface ClipZoomWindow {
  startMs: number;
  endMs: number;
  scale: number;
  reason: string;
}

export interface ClipSlowMotionWindow {
  startMs: number;
  endMs: number;
  speed: number;
  reason: string;
}

/** What the renderer actually applied to the exported MP4. */
export interface ClipFraming {
  /** Horizontal subject centre at the start/end, -1 (left) to +1 (right). */
  startX: number;
  endX: number;
  confidence: number;
  strategy: 'subject-following' | 'crop-center';
  samples: number;
}

export interface ClipEffects {
  zoomWindows: ClipZoomWindow[];
  slowMotion: ClipSlowMotionWindow[];
  removedPausesMs: number;
  outputDurationMs: number;
  captionsEdited: boolean;
  framing?: ClipFraming | null;
}

export interface Clip {
  id: string;
  projectId: string;
  index: number;
  title: string;
  reason: string | null;
  hook: string | null;
  startMs: number;
  endMs: number;
  score: number;
  status: ClipStatus;
  error: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  captionMode: string | null;
  cropStrategy: string | null;

  /** Why this clip scored the way it did, and what evidence backed it. */
  scoreBreakdown: ClipScoreBreakdown | null;
  evidence: string[];
  edits: ClipEdits | null;
  effects: ClipEffects | null;
}

export interface ProjectJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A clip + the URLs the browser needs. Never contains server file paths. */
export interface ClipView extends Clip {
  videoUrl: string;
  posterUrl: string | null;
  downloadUrl: string;
  /** Transcript text inside this clip's range (or the user's custom captions). */
  transcriptText: string;
}

export interface ProjectView {
  project: Project;
  /** Whether the original is in this browser's local store or remote storage. */
  sourceMode: 'local' | 'remote' | 'none';
  clips: ClipView[];
  job: ProjectJob | null;
  transcript: {
    provider: string;
    language: string | null;
    timing: 'provider' | 'estimated';
    text: string;
    wordCount: number;
  } | null;
  workerOnline: boolean;
  /** User-facing explanation of why processing cannot start, if anything is missing. */
  blocker: { code: string; message: string } | null;
  downloadAllUrl: string | null;
}

export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
  words?: TimedWord[];
}

export interface Transcript {
  text: string;
  language: string | null;
  words: TimedWord[];
  segments: TranscriptSegment[];
  timing: 'provider' | 'estimated';
  provider: string;
}

export interface SelectedClip {
  title: string;
  reason: string;
  hook: string;
  startMs: number;
  endMs: number;
  score: number;
  scoreBreakdown?: ClipScoreBreakdown | null;
  evidence?: string[];
}
