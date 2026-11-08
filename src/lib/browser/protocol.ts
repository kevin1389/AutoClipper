import type { ClipEdits, ClipView, PipelineStage, Project, SelectedClip, TimedWord } from '../types';

export type BrowserStage = Exclude<PipelineStage, 'queued' | 'done'>;

export interface BrowserTranscript {
  provider: string;
  language: string | null;
  timing: 'provider' | 'estimated';
  text: string;
  words: TimedWord[];
  segments: { text: string; startMs: number; endMs: number }[];
}

export interface BrowserSignals {
  audio: { tMs: number; rms: number }[];
  peaksMs: number[];
  sceneChangesMs: number[];
  source: { audio: boolean; visual: boolean };
}

export interface BrowserProjectPayload {
  projectId: string;
  sourceMode?: 'local' | 'remote' | 'none';
  sourceUrl: string | null;
  sourceBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

/** The subset of a persisted clip the processor needs to resume rendering. */
export interface ProcessorClipSummary {
  id: string;
  index: number;
  title: string;
  startMs: number;
  endMs: number;
  status: 'pending' | 'rendered' | 'failed';
  edits: ClipEdits | null;
}

export interface StartMessage {
  type: 'start';
  projectId: string;
  engine: 'auto' | 'wasm';
  /** Present on the local-first path. Never serialized to the server. */
  sourceFile?: File | null;
}

export interface ProbeSourceMessage {
  type: 'probe-source';
  requestId: string;
  projectId: string;
  /** Required when the project's source is browser-local. */
  sourceFile?: File | null;
}

export interface SourceProbeMeta {
  durationMs: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
}

export interface RenderClipMessage {
  type: 'render-clip';
  projectId: string;
  clipId: string;
  index: number;
  title: string;
  startMs: number;
  endMs: number;
  edits: ClipEdits;
  /** Required when the project's source is browser-local. */
  sourceFile?: File | null;
  selected?: SelectedClip | null;
}

export interface PosterRequest {
  type: 'poster-request';
  requestId: string;
  clipNumber: number;
  /** A private copy of the rendered MP4; the worker keeps its own bytes for upload. */
  video: ArrayBuffer;
}

export interface PosterResponse {
  type: 'poster-response';
  requestId: string;
  poster?: ArrayBuffer;
  error?: string;
}

export type WorkerRequest = StartMessage | ProbeSourceMessage | RenderClipMessage | PosterResponse;

export type WorkerEvent =
  | { type: 'progress'; stage: BrowserStage; progress: number; detail: string }
  | { type: 'model'; detail: string; progress: number }
  | { type: 'engine'; engine: 'webgpu' | 'wasm'; detail: string }
  | { type: 'meta'; durationMs: number; width: number; height: number; fps: number | null; hasAudio: boolean }
  | { type: 'transcript'; wordCount: number; language: string | null }
  | { type: 'selection'; count: number }
  | { type: 'clip'; clip: ClipView }
  | { type: 'done'; project: Project }
  | { type: 'render-done'; clip: ClipView }
  | { type: 'source-probe'; requestId: string; meta: SourceProbeMeta }
  | { type: 'source-probe-error'; requestId: string; message: string; code: string }
  | PosterRequest
  | { type: 'error'; message: string; code: string };

export interface ProcessorData {
  project: Project;
  transcript: BrowserTranscript | null;
  clips: ProcessorClipSummary[];
  sourceUrl: string;
}
