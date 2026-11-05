/** Shared upload constraints (imported by both server and client code). */
export const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'] as const;

/**
 * The source ceiling is a policy limit, not a promise that every browser can
 * process a file of this size. Normal processing keeps the file local and
 * mounts it into FFmpeg.wasm without copying the whole file into the JS heap.
 */
export const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;

/** Marks a project whose source remains in the browser's local object store. */
export const LOCAL_SOURCE_PREFIX = 'local://';

export function localSourcePath(projectId: string): string {
  return `${LOCAL_SOURCE_PREFIX}${projectId}`;
}

export function isLocalSourcePath(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(LOCAL_SOURCE_PREFIX));
}

export const ACCEPT_ATTRIBUTE = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'video/x-matroska',
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
].join(',');

export const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

export function isAllowedExtension(extension: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}
