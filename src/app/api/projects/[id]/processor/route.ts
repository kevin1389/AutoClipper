import * as db from '@/lib/db';
import { requireUser } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { pathExists } from '@/lib/storage';
import { isLocalSourcePath } from '@/lib/upload-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Everything the browser worker needs, and nothing it does not need. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const { id } = await context.params;
  const project = await db.getProjectForOwner(id, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  const sourcePath = await db.getProjectSourcePath(id);
  const local = isLocalSourcePath(sourcePath);
  if (!local && (!sourcePath || !(await pathExists(sourcePath)))) {
    return jsonError(409, 'source_missing', 'Attach or upload a video file before starting browser processing.');
  }
  const transcript = await db.getTranscript(id);
  return Response.json(
    {
      project,
      transcript,
      sourceMode: local ? 'local' : 'remote',
      sourceUrl: local ? null : `/api/projects/${id}/source/download`,
      sourceBytes: project.sourceBytes,
      sourceMime: project.sourceMime,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
