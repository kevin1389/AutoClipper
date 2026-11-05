import * as db from '@/lib/db';
import { requireUser } from '@/lib/api-auth';
import { fileResponse, jsonError } from '@/lib/http';
import { pathExists } from '@/lib/storage';
import { isLocalSourcePath } from '@/lib/upload-limits';
import { mimeForExtension } from '@/lib/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Owner-scoped full source stream used by the browser processing worker. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const { id } = await context.params;
  const project = await db.getProjectForOwner(id, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');
  const sourcePath = await db.getProjectSourcePath(id);
  if (isLocalSourcePath(sourcePath)) {
    return jsonError(
      409,
      'local_source_only',
      'This source stays in your browser. Open the project on the device where you attached it.',
    );
  }
  if (!sourcePath || !(await pathExists(sourcePath))) {
    return jsonError(404, 'source_missing', 'This project has no stored source video.');
  }
  const extension = project.sourceFileName?.match(/\.[a-z0-9]+$/i)?.[0] ?? '.mp4';
  return fileResponse(request, sourcePath, {
    contentType: project.sourceMime || mimeForExtension(extension),
  });
}
