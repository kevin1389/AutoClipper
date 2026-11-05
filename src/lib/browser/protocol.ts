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

export interface StartMessage {
  type: 'start';
  projectId: string;
  engine: 'auto' | 'wasm';
  /** Present on the local-first path. Never serialized to the server. */
  sourceFile?: File | null;
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

export type WorkerRequest = StartMessage | RenderClipMessage;

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
  | { type: 'error'; message: string; code: string };

export interface ProcessorData {
  project: Project;
  transcript: BrowserTranscript | null;
  sourceUrl: string;
}
