import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { buildProjectView } from '@/lib/project-view';
import { ProjectClient } from './project-client';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/projects/${id}`)}`);
  const view = await buildProjectView(id, user.id);
  if (!view) notFound();
  return <ProjectClient initialView={view} />;
}
