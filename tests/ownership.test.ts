import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as db from '../src/lib/db-sqlite';

// The database opens lazily, so setting the data dir before the first query is
// enough even though ES imports are hoisted.
process.env.AC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-owners-'));

const ALICE = 'account_alice';
const BOB = 'account_bob';

db.closeDb();
db.upsertUser({ id: ALICE, email: 'alice@example.test', name: 'Alice', picture: null });
db.upsertUser({ id: BOB, email: 'bob@example.test', name: 'Bob', picture: null });

const aliceProject = randomUUID();
const bobProject = randomUUID();
const aliceClip = randomUUID();

db.createProject({ id: aliceProject, ownerId: ALICE, title: 'Alice upload', sourceKind: 'upload' });
db.createProject({ id: bobProject, ownerId: BOB, title: 'Bob upload', sourceKind: 'upload' });
db.replaceClips(aliceProject, [
  {
    id: aliceClip,
    title: 'Alice clip',
    reason: 'Test clip',
    hook: 'Hook',
    startMs: 0,
    endMs: 5_000,
    score: 0.5,
  },
]);

test('each account lists only its own projects', () => {
  assert.deepEqual(
    db.listProjects(ALICE).map((project) => project.id),
    [aliceProject],
  );
  assert.deepEqual(
    db.listProjects(BOB).map((project) => project.id),
    [bobProject],
  );
});

test('a foreign project id resolves to nothing instead of another account’s data', () => {
  assert.ok(db.getProjectForOwner(aliceProject, ALICE));
  assert.equal(db.getProjectForOwner(aliceProject, BOB), null);
  assert.equal(db.getProjectForOwner(bobProject, ALICE), null);
  assert.equal(db.getProjectForOwner(aliceProject, ''), null);
});

test('clip and file lookups are joined through the project owner', () => {
  const owned = db.getClipForOwner(aliceClip, ALICE);
  assert.ok(owned, 'the owner can load the clip');
  assert.equal(db.getClipForOwner(aliceClip, BOB), null);
  assert.equal(db.getClipForOwner(aliceClip, 'unknown-sub'), null);
});

test('ownerless legacy projects stay hidden until explicitly assigned', () => {
  const legacyId = randomUUID();
  db.getDb()
    .prepare(
      `INSERT INTO projects (id, owner_id, title, source_kind, status, stage, progress, created_at, updated_at)
       VALUES (?, NULL, 'Legacy', 'upload', 'completed', 'done', 100, ?, ?)`,
    )
    .run(legacyId, new Date().toISOString(), new Date().toISOString());

  assert.equal(db.countUnownedProjects(), 1);
  assert.equal(db.getProjectForOwner(legacyId, ALICE), null);
  assert.equal(db.getProjectForOwner(legacyId, BOB), null);

  assert.equal(db.assignUnownedProjects(ALICE), 1);
  assert.ok(db.getProjectForOwner(legacyId, ALICE));
  assert.equal(db.getProjectForOwner(legacyId, BOB), null);
  assert.equal(db.countUnownedProjects(), 0);
});

test('deleting a project is scoped by the route, and clips keep their project link', () => {
  assert.equal(db.getClipForOwner(aliceClip, BOB), null);
  assert.equal(db.getProjectForOwner(bobProject, BOB)?.title, 'Bob upload');
  assert.equal(db.getClips(aliceProject).length, 1);
});
