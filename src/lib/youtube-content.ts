/**
 * Authorized YouTube content access.
 *
 * YouTube itself never hands an application a video file: the Data API returns
 * metadata, upload operations and player embeds, and its Terms of Service allow
 * copying content only as expressly authorized. Automatic retrieval is therefore
 * only possible through a provider the deployer provisions with content they own
 * or are licensed to process.
 *
 * This build ships one such provider: `authorized-directory`. It reads files the
 * operator staged under YOUTUBE_MEDIA_DIR, named by YouTube video id
 * (`<videoId>.mp4`), for example their own Studio export or licensed footage.
 * Pasting that video's URL then needs no manual upload.
 *
 * This module is intentionally free of app config imports so both the config
 * layer and the request layer can use it without a cycle.
 */
import fs from 'node:fs';
import path from 'node:path';

export const AUTHORIZED_DIRECTORY_PROVIDER = 'authorized-directory';

/** Extensions the pipeline already accepts for uploads. */
export const AUTHORIZED_MEDIA_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'] as const;

export interface AuthorizedMedia {
  provider: string;
  /** Absolute path on the server. Never returned to the browser. */
  path: string;
  fileName: string;
  bytes: number;
}

export type MediaResolution =
  | { available: true; media: AuthorizedMedia }
  | { available: false; code: 'no_provider' | 'not_staged' | 'unknown_provider'; reason: string };

/** Browser-safe explanation of why a URL alone cannot be turned into clips. */
export function automaticAccessReason(provider: string): string {
  if (!provider || provider === 'none') {
    return (
      'No authorized content-access provider is configured, so AutoClipper cannot fetch this video for you. ' +
      'YouTube offers no download API and this app does not use extractors. Attach the video you own or have ' +
      'written permission to use, or have the operator configure YOUTUBE_CONTENT_PROVIDER (see .env.example).'
    );
  }
  if (provider === AUTHORIZED_DIRECTORY_PROVIDER) {
    return (
      'The authorized media directory is not provisioned yet. The operator must create YOUTUBE_MEDIA_DIR and ' +
      'stage the authorized source there before links can be processed automatically.'
    );
  }
  return (
    `Unknown YOUTUBE_CONTENT_PROVIDER "${provider}". Supported: none, ${AUTHORIZED_DIRECTORY_PROVIDER}. ` +
    'AutoClipper will not fall back to an unauthorized download path.'
  );
}

export function mediaDirectoryReady(mediaDir: string): boolean {
  try {
    return fs.statSync(mediaDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds the authorized source for a video id. `videoId` must already be a
 * validated 11-character YouTube id (see parseYoutubeUrl), which also keeps this
 * path join free of traversal characters.
 */
export function resolveAuthorizedMedia(
  input: { provider: string; mediaDir: string },
  videoId: string,
): MediaResolution {
  const provider = input.provider || 'none';

  if (provider === 'none') {
    return { available: false, code: 'no_provider', reason: automaticAccessReason('none') };
  }
  if (provider !== AUTHORIZED_DIRECTORY_PROVIDER) {
    return { available: false, code: 'unknown_provider', reason: automaticAccessReason(provider) };
  }
  if (!mediaDirectoryReady(input.mediaDir)) {
    return { available: false, code: 'not_staged', reason: automaticAccessReason(AUTHORIZED_DIRECTORY_PROVIDER) };
  }

  for (const extension of AUTHORIZED_MEDIA_EXTENSIONS) {
    const candidate = path.join(input.mediaDir, `${videoId}${extension}`);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size === 0) continue;
      return {
        available: true,
        media: {
          provider,
          path: candidate,
          fileName: path.basename(candidate),
          bytes: stat.size,
        },
      };
    } catch {
      // Not staged under this extension — try the next one.
    }
  }

  return {
    available: false,
    code: 'not_staged',
    reason:
      `No authorized copy of this video is staged for the configured provider. The operator must add the file as ` +
      `${videoId}.mp4 (or .mov, .m4v, .webm, .mkv) to the authorized media directory — for example the owner’s own ` +
      'export from YouTube Studio, or footage covered by a written licence.',
  };
}
