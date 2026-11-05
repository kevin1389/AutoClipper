import { redirect } from 'next/navigation';
import * as db from '@/lib/db';
import { accountLabel, getCurrentUser } from '@/lib/auth';
import { publicConfig } from '@/lib/env';
import { getStorageUsage } from '@/lib/storage';
import { DashboardClient } from './dashboard-client';
import type { ProjectListItem } from './dashboard-client';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login?next=/dashboard');

  const projects: ProjectListItem[] = [];
  for (const project of await db.listProjects(user.id, 60)) {
    const clips = await db.getClips(project.id);
    projects.push({
      ...project,
      renderedClips: clips.filter((clip) => clip.status === 'rendered').length,
    });
  }

  return (
    <DashboardClient
      initialProjects={projects}
      initialConfig={publicConfig()}
      initialStorage={await getStorageUsage(projects.map((project) => project.id))}
      account={{ label: accountLabel(user) }}
    />
  );
}
