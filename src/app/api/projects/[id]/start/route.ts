import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The old server queue is intentionally closed. Rendering and transcription
 * happen in the project's browser tab via /process; a deployment must not be
 * able to enqueue work that needs FFmpeg or Python on the server.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  return jsonError(
    409,
    'browser_processing_required',
    'Processing runs in your browser. Open the project and press Start processing; this server queue is disabled.',
  );
}
