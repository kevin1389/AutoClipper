/**
 * YouTube support.
 *
 * What this module actually does:
 *  - validates and normalizes YouTube video URLs (all common URL shapes)
 *  - reads public metadata (title, author, thumbnail) from YouTube's oEmbed endpoint
 *  - exposes a content-access provider interface
 *
 * What it deliberately does not do: download YouTube media. YouTube's Data API
 * has no download endpoint, and its Terms of Service only allow copying content
 * as expressly authorized, so a pasted URL is not itself authorization. No
 * licensed provider is configured in this build, so `contentAccess.available` is
 * always false and the UI pairs the link's metadata with a file the user is
 * authorized to supply. Any future licensed provider implements the same
 * interface and can flip that flag.
 */

export interface YoutubeMetadata {
  videoId: string;
  canonicalUrl: string;
  watchUrl: string;
  title: string;
  authorName: string | null;
  authorUrl: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  contentAccess: {
    available: boolean;
    provider: string;
    reason: string;
  };
}

export interface ParsedYoutubeUrl {
  videoId: string;
  canonicalUrl: string;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Parses any common YouTube video URL, returning null for anything else. */
export function parseYoutubeUrl(input: string): ParsedYoutubeUrl | null {
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.replace(/\/+$/, '');
  let candidate: string | null = null;

  if (host === 'youtu.be') {
    candidate = pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (HOSTS.has(host)) {
    const segments = pathname.split('/').filter(Boolean);
    const v = url.searchParams.get('v');
    if (segments[0] === 'watch' && v) {
      candidate = v;
    } else if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live' || segments[0] === 'v') {
      candidate = segments[1] ?? null;
    } else if (v) {
      candidate = v;
    }
  }

  if (!candidate || !VIDEO_ID_RE.test(candidate)) return null;
  return {
    videoId: candidate,
    canonicalUrl: `https://www.youtube.com/watch?v=${candidate}`,
  };
}

export function contentAccessReason(provider: string): string {
  if (provider !== 'none') {
    return (
      `A content-access provider ("${provider}") is configured, but this build has no media-fetch ` +
      'implementation for it and will not fall back to an unauthorized download path.'
    );
  }
  return (
    'YouTube gives applications no downloadable video file: the Data API returns metadata, upload ' +
    'operations and player embeds only, and the Terms of Service permit copying content only as ' +
    'expressly authorized. This link therefore supplies the title, channel and thumbnail; the video ' +
    'file has to come from you — your own upload exported from YouTube Studio, or footage you have ' +
    'written permission to use. AutoClipper processes that file end to end.'
  );
}

const OEMBED_TIMEOUT_MS = 8000;

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
}

/**
 * Public metadata lookup. Uses YouTube's documented oEmbed endpoint, which
 * requires no API key and returns no media stream.
 */
export async function fetchYoutubeMetadata(
  parsed: ParsedYoutubeUrl,
  provider = 'none',
): Promise<YoutubeMetadata> {
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', parsed.canonicalUrl);
  endpoint.searchParams.set('format', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });

    if (response.status === 404 || response.status === 401 || response.status === 403) {
      throw new YoutubeLookupError(
        'VIDEO_UNAVAILABLE',
        'YouTube did not return metadata for this video. It may be private, age-restricted, removed, or region-blocked.',
      );
    }
    if (!response.ok) {
      throw new YoutubeLookupError(
        'LOOKUP_FAILED',
        `YouTube metadata lookup failed (HTTP ${response.status}). Try again in a moment.`,
      );
    }

    const data = (await response.json()) as OEmbedResponse;
    return {
      videoId: parsed.videoId,
      canonicalUrl: parsed.canonicalUrl,
      watchUrl: parsed.canonicalUrl,
      title: data.title?.trim() || `YouTube video ${parsed.videoId}`,
      authorName: data.author_name?.trim() || null,
      authorUrl: data.author_url?.trim() || null,
      thumbnailUrl: data.thumbnail_url?.trim() || null,
      durationMs: null,
      contentAccess: {
        available: false,
        provider,
        reason: contentAccessReason(provider),
      },
    };
  } catch (error) {
    if (error instanceof YoutubeLookupError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new YoutubeLookupError('LOOKUP_TIMEOUT', 'YouTube metadata lookup timed out. Try again.');
    }
    throw new YoutubeLookupError(
      'LOOKUP_FAILED',
      'Could not reach YouTube to read this video’s metadata. Check the server’s network access and try again.',
    );
  } finally {
    clearTimeout(timer);
  }
}

export class YoutubeLookupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'YoutubeLookupError';
    this.code = code;
  }
}
