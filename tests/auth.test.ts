import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as db from '../src/lib/db-sqlite';
import { hashPassword, verifyPassword } from '../src/lib/password';

process.env.AC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-auth-'));
db.closeDb();

test('passwords are salted, hashed and verified in constant time', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);

  const second = await hashPassword('correct horse battery staple');
  assert.notEqual(hash, second);
  assert.equal(await verifyPassword('correct horse battery staple', second), true);
});

test('email accounts are unique regardless of letter case', () => {
  const first = db.createEmailUser({
    email: 'Alice@Example.test',
    name: 'Alice',
    passwordHash: 'scrypt$test',
  });
  assert.ok(first);
  assert.equal(
    db.createEmailUser({ email: 'alice@example.test', name: 'Other', passwordHash: 'scrypt$other' }),
    null,
  );
  assert.equal(db.findUserByEmail('ALICE@example.test')?.id, first?.id);
  assert.equal(db.findUserByEmail('missing@example.test'), null);
});

test('sessions resolve only while unexpired', () => {
  const user = db.createEmailUser({
    email: 'session@example.test',
    name: null,
    passwordHash: 'scrypt$test',
  });
  assert.ok(user);

  const tokenHash = createHash('sha256').update('token-one').digest('hex');
  db.createSessionRow(tokenHash, user.id, new Date(Date.now() + 60_000).toISOString());
  assert.equal(db.getSessionUser(tokenHash)?.id, user.id);
  db.deleteSessionRow(tokenHash);
  assert.equal(db.getSessionUser(tokenHash), null);

  const expired = createHash('sha256').update('token-two').digest('hex');
  db.createSessionRow(expired, user.id, new Date(Date.now() - 1_000).toISOString());
  assert.equal(db.getSessionUser(expired), null);
});

test('Google identities link only through a verified email', () => {
  const created = db.findOrCreateGoogleUser({
    sub: 'google-1',
    email: 'g@example.test',
    emailVerified: true,
    name: 'G',
    picture: null,
  });
  assert.ok(created);
  assert.equal(
    db.findOrCreateGoogleUser({
      sub: 'google-1',
      email: 'g@example.test',
      emailVerified: true,
      name: 'G',
      picture: null,
    })?.id,
    created.id,
  );

  assert.equal(
    db.findOrCreateGoogleUser({
      sub: 'google-2',
      email: 'unverified@example.test',
      emailVerified: false,
      name: 'U',
      picture: null,
    }),
    null,
  );

  const local = db.createEmailUser({
    email: 'local@example.test',
    name: null,
    passwordHash: 'scrypt$test',
  });
  assert.ok(local);
  const linked = db.findOrCreateGoogleUser({
    sub: 'google-3',
    email: 'LOCAL@example.test',
    emailVerified: true,
    name: 'Local',
    picture: null,
  });
  assert.equal(linked?.id, local.id);
});

test('verification tokens are hashed, single-use and purpose-bound', () => {
  const user = db.createEmailUser({
    email: 'verify-token@example.test',
    name: null,
    passwordHash: 'scrypt$test',
  });
  assert.ok(user);

  const tokenHash = createHash('sha256').update('verify-token-value').digest('hex');
  db.createAuthToken(tokenHash, user.id, 'verify_email', new Date(Date.now() + 60_000).toISOString());

  // The same value cannot be used for a password reset.
  assert.equal(db.consumeAuthToken(tokenHash, 'reset_password'), null);
  assert.deepEqual(db.consumeAuthToken(tokenHash, 'verify_email'), { userId: user.id });
  // And it cannot be replayed.
  assert.equal(db.consumeAuthToken(tokenHash, 'verify_email'), null);

  assert.equal(db.findUserByEmail('verify-token@example.test')?.emailVerified, false);
  db.markEmailVerified(user.id);
  assert.equal(db.findUserByEmail('verify-token@example.test')?.emailVerified, true);
});

test('expired verification tokens are refused', () => {
  const user = db.createEmailUser({
    email: 'expired-token@example.test',
    name: null,
    passwordHash: 'scrypt$test',
  });
  assert.ok(user);
  const tokenHash = createHash('sha256').update('expired-token-value').digest('hex');
  db.createAuthToken(tokenHash, user.id, 'verify_email', new Date(Date.now() - 1_000).toISOString());
  assert.equal(db.consumeAuthToken(tokenHash, 'verify_email'), null);
});

test('a password reset updates the hash, verifies the email and revokes sessions', async () => {
  const user = db.createEmailUser({
    email: 'reset-token@example.test',
    name: null,
    passwordHash: await hashPassword('old-password-123'),
  });
  assert.ok(user);

  const sessionHash = createHash('sha256').update('old-session').digest('hex');
  db.createSessionRow(sessionHash, user.id, new Date(Date.now() + 60_000).toISOString());
  assert.equal(db.getSessionUser(sessionHash)?.id, user.id);

  const tokenHash = createHash('sha256').update('reset-token-value').digest('hex');
  db.createAuthToken(tokenHash, user.id, 'reset_password', new Date(Date.now() + 60_000).toISOString());
  const consumed = db.consumeAuthToken(tokenHash, 'reset_password');
  assert.deepEqual(consumed, { userId: user.id });

  const nextHash = await hashPassword('new-password-123');
  db.setUserPassword(user.id, nextHash);
  db.revokeUserSessions(user.id);

  const updated = db.findUserByEmail('reset-token@example.test');
  assert.equal(updated?.emailVerified, true);
  assert.equal(await verifyPassword('new-password-123', updated?.passwordHash ?? ''), true);
  assert.equal(await verifyPassword('old-password-123', updated?.passwordHash ?? ''), false);
  assert.equal(db.getSessionUser(sessionHash), null);
  assert.equal(db.consumeAuthToken(tokenHash, 'reset_password'), null);
});
