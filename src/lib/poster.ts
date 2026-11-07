/** Shared poster validation and receipt checks. */

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength > 1024 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

export type PosterReceiptCode = 'poster_missing' | 'poster_key_missing';

export interface PosterReceiptIssue {
  code: PosterReceiptCode;
  message: string;
}

/**
 * A rendered clip is only complete when its poster was uploaded for this
 * render. Storage-pool uploads must also identify the exact object so an old
 * poster from a previous render can never be reused.
 */
export function posterReceiptError(
  input: { hasPoster: unknown; posterBytes: unknown; posterKey?: unknown },
  requiresStorageKey: boolean,
): PosterReceiptIssue | null {
  if (input.hasPoster !== true) {
    return {
      code: 'poster_missing',
      message: 'Every rendered clip must include a poster image. Re-render the clip before saving it.',
    };
  }
  const bytes = Math.round(Number(input.posterBytes));
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return {
      code: 'poster_missing',
      message: 'Every rendered clip must include a poster image. Re-render the clip before saving it.',
    };
  }
  if (
    requiresStorageKey &&
    (typeof input.posterKey !== 'string' || input.posterKey.length === 0)
  ) {
    return {
      code: 'poster_key_missing',
      message: 'The poster for this render was not uploaded.',
    };
  }
  return null;
}
