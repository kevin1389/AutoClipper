import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from '../src/lib/db';
import { closeDb } from '../src/lib/db-sqlite';
import {
  abortMultipartStorageObject,
  startMultipartStorageObject,
  uploadMultipartPart,
} from '../src/lib/storage-pool';
import { abortSourceUpload, startSourceUpload, uploadSourcePart } from '../src/lib/source-upload';
import { storageProviders } from '../src/lib/storage-providers';
import { createMockS3, type MockS3 } from './support/mock-s3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-security-'));
const OWNER = 'security-owner';
const PROVIDER_PREFIXES = ['AC_B2', 'AC_TIGRIS', 'AC_FILEBASE'];
const PROVIDER_SUFFIXES = [
  'ACCESS_KEY_ID',
  'SECRET_ACCESS_KEY',
  'BUCKET',
  'ENDPOINT',
  'REGION',
  'LIMIT_BYTES',
  'RESERVE_BYTES',
  'SESSION_TOKEN',
  'PATH_STYLE',
];
let mock!: MockS3;

test.before(async () => {
  mock = await createMockS3();
  process.env.AC_DATA_DIR = dataDir;
  for (const prefix of PROVIDER_PREFIXES) {
    process.env[`${prefix}_ENDPOINT`] = mock.endpoint;
    process.env[`${prefix}_REGION`] = 'test-region';
    process.env[`${prefix}_BUCKET`] =
      prefix === 'AC_B2' ? 'test-b2' : prefix === 'AC_TIGRIS' ? 'test-tigris' : 'test-filebase';
    process.env[`${prefix}_ACCESS_KEY_ID`] = 'test-access';
    process.env[`${prefix}_SECRET_ACCESS_KEY`] = 'test-secret';
  }
  closeDb();
  db.upsertUser({ id: OWNER, email: 'security@example.test', name: 'Security', picture: null });
});

test.after(async () => {
  await mock.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function newProject(): string {
  const id = randomUUID();
  db.createProject({ id, ownerId: OWNER, title: 'security', sourceKind: 'upload' });
  return id;
}

test('multipart parts are bounded by the declared session size', async () => {
  const projectId = newProject();
  const session = await startMultipartStorageObject({
    ownerId: OWNER,
    projectId,
    kind: 'video',
    assetKey: `video:${projectId}:bounded`,
    key: `projects/${projectId}/clips/bounded.mp4`,
    contentType: 'video/mp4',
    expectedBytes: 1_000,
    partSize: 200,
    totalParts: 5,
  });

  await assert.rejects(
    () => uploadMultipartPart(projectId, session.uploadId, 6, new ArrayBuffer(10)),
    /beyond the 5 parts/,
    'a part past the declared count must be refused before it reaches the provider',
  );
  await assert.rejects(
    () => uploadMultipartPart(projectId, session.uploadId, 1, new ArrayBuffer(200 + 2_048)),
    /exceeds the 200-byte part size/,
  );
  await assert.rejects(
    () => uploadMultipartPart(projectId, session.uploadId, 0, new ArrayBuffer(10)),
    /Invalid upload part number/,
  );

  const part = await uploadMultipartPart(projectId, session.uploadId, 1, new ArrayBuffer(200));
  assert.equal(part.partNumber, 1);
  await abortMultipartStorageObject(projectId, session.uploadId);
});

test('a local upload session id cannot escape the uploads directory', async () => {
  const saved: [string, string | undefined][] = [];
  for (const prefix of PROVIDER_PREFIXES) {
    for (const suffix of PROVIDER_SUFFIXES) {
      const name = `${prefix}_${suffix}`;
      saved.push([name, process.env[name]]);
      delete process.env[name];
    }
  }
  try {
    assert.equal(storageProviders().length, 0, 'this test needs the local backend');
    const projectId = newProject();
    const sentinel = path.join(dataDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'keep me');

    const started = await startSourceUpload(projectId, OWNER, 'clip.mp4', 1_024);
    assert.equal(started.mode, 'local');

    await assert.rejects(
      () => uploadSourcePart(projectId, '../../escape', 1, new ArrayBuffer(16)),
      /Invalid upload session id/,
    );
    await assert.rejects(
      () => abortSourceUpload(projectId, '../..'),
      /Invalid upload session id/,
      'abort must not recursively delete a traversed directory',
    );
    assert.equal(fs.existsSync(sentinel), true, 'a traversal id must not delete sibling data');
    assert.equal(fs.existsSync(dataDir), true);

    const part = await uploadSourcePart(projectId, started.uploadId, 1, new ArrayBuffer(16));
    assert.equal(part.partNumber, 1, 'a server-generated session id still works');
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
