import path from 'node:path';
import { config } from './env';
import { ALLOWED_EXTENSIONS, MIME_BY_EXTENSION, isAllowedExtension } from './upload-limits';

export { ALLOWED_EXTENSIONS, MIME_BY_EXTENSION } from './upload-limits';

export interface UploadValidation {
  ok: boolean;
  error?: { code: string; message: string };
  extension?: string;
  mime?: string;
  fileName?: string;
  maxBytes?: number;
}

/** Validates a file name/size before a single byte is written to disk. */
export function validateUploadCandidate(fileName: string, size: number | null): UploadValidation {
  const maxBytes = config().maxUploadBytes;
  const trimmed = (fileName ?? '').trim();
  if (!trimmed || trimmed.length > 255) {
    return { ok: false, error: { code: 'invalid_filename', message: 'A valid file name is required.' } };
  }

  const extension = path.extname(trimmed).toLowerCase();
  if (!isAllowedExtension(extension)) {
    return {
      ok: false,
      error: {
        code: 'unsupported_type',
        message: `Unsupported file type "${extension || 'unknown'}". Upload ${ALLOWED_EXTENSIONS.join(', ')}.`,
      },
    };
  }

  if (size !== null && size !== undefined) {
    if (size <= 0) {
      return { ok: false, error: { code: 'empty_file', message: 'That file is empty.' } };
    }
    if (size > maxBytes) {
      return {
        ok: false,
        error: {
          code: 'file_too_large',
          // Round the over-limit size up to a tenth so a file one byte over the
          // limit never renders as "500 MB; the limit is 500 MB".
          message: `That file is ${Math.ceil((size / 1024 / 1024) * 10) / 10} MB; the limit is ${Math.round(
            maxBytes / 1024 / 1024,
          )} MB.`,
        },
      };
    }
  }

  return { ok: true, extension, fileName: trimmed, maxBytes };
}

export function mimeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? 'application/octet-stream';
}
