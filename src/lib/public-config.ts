/** Shape returned by /api/health and /api/projects; shared with client components. */
export interface PublicConfig {
  ffmpeg: boolean;
  ffprobe: boolean;
  transcription: {
    configured: boolean;
    provider: string;
    /** Human-readable engine, e.g. "faster-whisper base (cpu/int8, local)". */
    engine: string;
    model: string;
    baseUrlHost: string;
  };
  resources: {
    cpuCount: number;
    freeMemMB: number;
    /** Memory the configured local model needs; 0 when not local. */
    recommendedMemMB: number;
    status: 'ok' | 'low';
  };
  selection: {
    engine: 'llm' | 'heuristic';
    model: string | null;
  };
  youtube: {
    contentAccess: string;
    metadata: string;
    /** True only when an operator-provisioned authorized provider is usable. */
    autoAccess: {
      available: boolean;
      provider: string;
      reason: string | null;
    };
  };
  /** Media work happens in this tab; no processing worker is required. */
  browser: {
    processing: true;
    model: string;
    maxSourceBytes: number;
    webgpu: 'auto';
  };
  maxUploadBytes: number;
  uploads: {
    maxBytes: number;
    extensions: string[];
    accept: string;
  };
  blocker: { code: string; message: string } | null;
}
