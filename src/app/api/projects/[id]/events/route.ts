import * as db from '@/lib/db';
import { requireUser } from '@/lib/api-auth';
import { buildProjectView } from '@/lib/project-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server-sent events stream of the project snapshot, so the processing page
 * updates live. The stream closes itself once the project reaches a terminal
 * state; the client also polls as a fallback.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const { id } = await context.params;
  if (!await db.getProjectForOwner(id, auth.user.id)) {
    return Response.json(
      { error: 'That project does not exist.' },
      { status: 404, headers: { 'cache-control': 'private, no-store' } },
    );
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let finished = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (event: string, data: unknown): boolean => {
        if (finished) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          close();
          return false;
        }
      };

      const tick = async () => {
        if (finished) return;
        try {
          const view = await buildProjectView(id, auth.user.id);
          if (!view) {
            send('gone', { message: 'Project no longer exists' });
            close();
            return;
          }
          const sent = send('snapshot', view);
          if (!sent) return;
          if (view.project.status === 'completed' || view.project.status === 'failed') {
            send('done', { status: view.project.status });
            close();
          }
        } catch (error) {
          send('stream_error', { message: (error as Error).message });
          close();
        }
      };

      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      void tick();
      timer = setInterval(() => void tick(), 1500);

      request.signal.addEventListener('abort', close);
    },
    cancel() {
      finished = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
