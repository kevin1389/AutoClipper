import * as db from '@/lib/db';
import { requireUser, sameOriginError } from '@/lib/api-auth';
import { jsonError } from '@/lib/http';
import { buildProjectView } from '@/lib/project-view';
import { deleteProjectFiles } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function privateError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { error: message, code, ...extra },
    { status, headers: { 'cache-control': 'private, no-store' } },
  );
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const { id } = await context.params;
  const view = await buildProjectView(id, auth.user.id);
  if (!view) return jsonError(404, 'project_not_found', 'That project does not exist.');
  return Response.json(view, { headers: { 'cache-control': 'private, no-store' } });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if ('response' in auth) return auth.response;
  const originError = sameOriginError(request);
  if (originError) return originError;
  const { id } = await context.params;
  const project = await db.getProjectForOwner(id, auth.user.id);
  if (!project) return jsonError(404, 'project_not_found', 'That project does not exist.');

  if (project.status === 'processing' || await db.hasActiveJob(id)) {
    return jsonError(409, 'project_busy', 'This project is still processing. Try again when it finishes.');
  }

  let deletion;
  try {
    deletion = await deleteProjectFiles(id);
  } catch (error) {
    return privateError(
      500,
      'file_deletion_failed',
      'The project files could not be deleted. The project and its database records were kept.',
      {
        failedFiles: [
          { path: `projects/${id}/`, error: (error as Error).message.slice(0, 300) },
        ],
        filesDeleted: false,
        verified: false,
      },
    );
  }

  if (!deletion.verified) {
    return privateError(
      500,
      'file_deletion_failed',
      'Some files could not be deleted. The project and its database records were kept so you can retry.',
      {
        failedFiles: deletion.failedFiles,
        filesDeleted: false,
        verified: false,
        bytesRemaining: deletion.bytesRemaining,
      },
    );
  }

  try {
    await db.deleteProject(id);
  } catch (error) {
    return privateError(
      500,
      'project_record_delete_failed',
      'All project files were deleted, but the project record could not be removed. Retry to finish deleting the project.',
      {
        failedFiles: [],
        filesDeleted: true,
        databaseDeleted: false,
        verified: true,
        bytesFreed: deletion.bytesFreed,
        detail: (error as Error).message.slice(0, 300),
      },
    );
  }

  return Response.json(
    {
      ok: true,
      deletedFiles: deletion.deletedFiles,
      bytesFreed: deletion.bytesFreed,
      databaseDeleted: true,
      verified: true,
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
