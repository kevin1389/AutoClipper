import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureProjectDirs } from '../src/lib/storage';
import { unexpectedErrorResponse } from '../src/lib/http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-project-create-'));
const savedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  AC_DATA_DIR: process.env.AC_DATA_DIR,
  AC_B2_ENDPOINT: process.env.AC_B2_ENDPOINT,
  AC_B2_REGION: process.env.AC_B2_REGION,
  AC_B2_BUCKET: process.env.AC_B2_BUCKET,
  AC_B2_ACCESS_KEY_ID: process.env.AC_B2_ACCESS_KEY_ID,
  AC_B2_SECRET_ACCESS_KEY: process.env.AC_B2_SECRET_ACCESS_KEY,
};

Object.assign(process.env, {
  NODE_ENV: 'production',
  AC_DATA_DIR: dataDir,
  AC_B2_ENDPOINT: 'https://s3.example.test',
  AC_B2_REGION: 'test-region',
  AC_B2_BUCKET: 'test-bucket',
  AC_B2_ACCESS_KEY_ID: 'test-access',
  AC_B2_SECRET_ACCESS_KEY: 'test-secret',
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('production local servers with an S3 pool create local project dirs without an R2 binding', async () => {
  const projectId = randomUUID();
  const dirs = await ensureProjectDirs(projectId);

  assert.equal(dirs.base, path.join(dataDir, 'projects', projectId));
  assert.equal(dirs.source, path.join(dirs.base, 'source'));
  assert.equal(dirs.clips, path.join(dirs.base, 'clips'));
  assert.equal(fs.existsSync(dirs.source), true);
  assert.equal(fs.existsSync(dirs.work), true);
  assert.equal(fs.existsSync(dirs.clips), true);
});

test('unexpected project creation failures expose the actual cause as JSON', async () => {
  const response = unexpectedErrorResponse(
    new Error('R2 FILES binding unavailable:\nmissing Cloudflare context'),
    'project_create_failed',
    'Could not create the project',
  );

  assert.equal(response.status, 500);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const body = (await response.json()) as { error: string; code: string };
  assert.equal(body.code, 'project_create_failed');
  assert.match(body.error, /Could not create the project: R2 FILES binding unavailable/);
  assert.doesNotMatch(body.error, /\n/);
});
