import { requireUser, sameOriginError } from '@/lib/api-auth';
import { config } from '@/lib/env';
import { jsonError } from '@/lib/http';
import { fetchYoutubeMetadata, parseYoutubeUrl, YoutubeLookupError } from '@/lib/youtube';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Validates a YouTube link and returns public metadata only. It never returns a
 * media URL: authorized content access is not implemented (see src/lib/youtube.ts).
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;

  const body = (await request.json().catch(() => ({}))) as { url?: string };
  const raw = String(body.url ?? '').trim();

  if (!raw) return jsonError(400, 'url_required', 'Paste a YouTube video URL.');

  const parsed = parseYoutubeUrl(raw);
  if (!parsed) {
    return jsonError(
      400,
      'invalid_youtube_url',
      'That is not a valid YouTube video link. Supported: youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/….',
    );
  }

  try {
    const metadata = await fetchYoutubeMetadata(parsed, config().youtube.contentProvider);
    return Response.json({ ok: true, metadata });
  } catch (error) {
    if (error instanceof YoutubeLookupError) {
      return jsonError(error.code === 'VIDEO_UNAVAILABLE' ? 404 : 502, error.code, error.message);
    }
    return jsonError(502, 'youtube_lookup_failed', 'Could not read metadata for that YouTube video.');
  }
}
