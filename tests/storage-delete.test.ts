import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from '../src/lib/db-sqlite';
import {
  deleteProjectFiles,
  ensureProjectDirs,
  getStorageUsage,
  type R2Bucket,
} from '../src/lib/storage';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-storage-'));
process.env.AC_DATA_DIR = dataDir;
process.env.AC_R2_STORAGE_LIMIT_BYTES = '1000000';
db.closeDb();

const ALICE = 'storage_alice';
const BOB = 'storage_bob';
db.upsertUser({ id: ALICE, email: 'storage-alice@example.test', name: 'Alice', picture: null });
db.upsertUser({ id: BOB, email: 'storage-bob@example.test', name: 'Bob', picture: null });

const aliceProject = randomUUID();
const bobProject = randomUUID();
db.createProject({ id: aliceProject, ownerId: ALICE, title: 'Alice storage', sourceKind: 'upload' });
db.createProject({ id: bobProject, ownerId: BOB, title: 'Bob storage', sourceKind: 'upload' });

async function writeFile(target: string, bytes: number): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.alloc(bytes, 7));
}

test('storage accounting measures source, clips/posters, temp files and per-project totals', async () => {
  const alice = await ensureProjectDirs(aliceProject);
  const bob = await ensureProjectDirs(bobProject);
  await writeFile(path.join(alice.source, 'input.mp4'), 1_000);
  await writeFile(path.join(alice.clips, 'clip-01.mp4'), 2_000);
  await writeFile(path.join(alice.clips, 'clip-01.jpg'), 300);
  await writeFile(path.join(alice.work, 'audio.wav'), 400);
  await writeFile(path.join(bob.source, 'input.mp4'), 500);

  const usage = await getStorageUsage([aliceProject, bobProject]);
  assert.equal(usage.available, true);
  assert.equal(usage.backend, 'local');
  assert.equal(usage.usedBytes, 4_200);
  assert.equal(usage.sourceBytes, 1_500);
  assert.equal(usage.clipBytes, 2_300);
  assert.equal(usage.fileCount, 5);
  assert.equal(usage.availableBytes, 1_000_000 - 4_200);

  const aliceUsage = usage.projects.find((project) => project.projectId === aliceProject);
  const bobUsage = usage.projects.find((project) => project.projectId === bobProject);
  assert.deepEqual(aliceUsage, {
    projectId: aliceProject,
    usedBytes: 3_700,
    sourceBytes: 1_000,
    clipBytes: 2_300,
    fileCount: 4,
  });
  assert.deepEqual(bobUsage, {
    projectId: bobProject,
    usedBytes: 500,
    sourceBytes: 500,
    clipBytes: 0,
    fileCount: 1,
  });
});

test('deleting one project frees only its files, including upload staging', async () => {
  const staging = path.join(dataDir, 'uploads', 'staging-for-alice');
  await fsp.mkdir(staging, { recursive: true });
  await fsp.writeFile(path.join(staging, 'meta.json'), JSON.stringify({ projectId: aliceProject }));
  await fsp.writeFile(path.join(staging, 'part-1'), Buffer.alloc(80));

  const result = await deleteProjectFiles(aliceProject);
  assert.equal(result.verified, true);
  assert.equal(result.failedFiles.length, 0);
  assert.equal(result.deletedFiles, 4);
  assert.equal(result.bytesFreed, 3_700);
  assert.equal(fs.existsSync(path.join(dataDir, 'projects', aliceProject)), false);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'projects', bobProject, 'source', 'input.mp4')), true);

  const usage = await getStorageUsage([aliceProject, bobProject]);
  assert.equal(usage.usedBytes, 500);
  assert.equal(usage.projects.find((project) => project.projectId === aliceProject)?.usedBytes, 0);
  assert.equal(usage.projects.find((project) => project.projectId === bobProject)?.usedBytes, 500);
});

test('a failed R2 delete keeps the project records and reports the exact file for retry', async () => {
  const projectId = randomUUID();
  db.createProject({ id: projectId, ownerId: ALICE, title: 'R2 retry', sourceKind: 'upload' });

  const objects = new Map<string, number>([
    [`projects/${projectId}/source/input.mp4`, 100],
    [`projects/${projectId}/clips/clip-01.mp4`, 200],
  ]);
  let failClip = true;
  const bucket = {
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, size]) => ({ key, size })),
        truncated: false,
      };
    },
    async delete(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      for (const target of keys) {
        if (failClip && target.endsWith('/clips/clip-01.mp4')) {
          throw new Error('simulated R2 deletion failure');
        }
        objects.delete(target);
      }
    },
  } as unknown as R2Bucket;

  const first = await deleteProjectFiles(projectId, bucket);
  assert.equal(first.verified, false);
  assert.equal(first.bytesFreed, 0);
  assert.equal(first.failedFiles.length, 1);
  assert.equal(first.failedFiles[0]?.path, 'clips/clip-01.mp4');
  assert.match(first.failedFiles[0]?.error ?? '', /simulated R2 deletion failure/);
  assert.equal(objects.size, 1, 'the failed object and any unconfirmed bytes remain');
  assert.ok(db.getProject(projectId), 'the project record must remain after a storage failure');

  failClip = false;
  const retry = await deleteProjectFiles(projectId, bucket);
  assert.equal(retry.verified, true);
  assert.equal(retry.bytesFreed, 200);
  assert.equal(retry.failedFiles.length, 0);
  assert.equal(objects.size, 0);
  assert.ok(db.getProject(projectId), 'D1 is not deleted by the storage helper itself');

  db.deleteProject(projectId);
  assert.equal(db.getProject(projectId), null);
});

test('deleteProject explicitly removes the project transcript, clips and jobs', async () => {
  const projectId = randomUUID();
  db.createProject({ id: projectId, ownerId: ALICE, title: 'Cascade test', sourceKind: 'upload' });
  db.saveTranscript(projectId, {
    text: 'hello world',
    language: 'en',
    timing: 'provider',
    provider: 'test',
    words: [{ text: 'hello', startMs: 0, endMs: 400 }],
    segments: [{ text: 'hello world', startMs: 0, endMs: 500 }],
  });
  db.replaceClips(projectId, [
    {
      id: randomUUID(),
      title: 'test clip',
      reason: 'test',
      hook: 'hello',
      startMs: 0,
      endMs: 500,
      score: 0.5,
    },
  ]);
  db.enqueueJob(projectId, randomUUID());

  db.deleteProject(projectId);
  assert.equal(db.getProject(projectId), null);
  assert.equal(db.getTranscript(projectId), null);
  assert.equal(db.getClips(projectId).length, 0);
  assert.equal(db.getLatestJob(projectId), null);
});
