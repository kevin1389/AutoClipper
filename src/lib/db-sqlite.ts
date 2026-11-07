import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeEmail } from './email';
import { config } from './env';
import { RESERVE_STORAGE_CAPACITY_SQL } from './storage-capacity-sql';
import {
  CLAIM_STORAGE_RECONCILIATION_SQL,
  FINISH_STORAGE_RECONCILIATION_SQL,
} from './storage-reconcile-sql';
import { CONSUME_RATE_LIMIT_SQL } from './rate-limit-sql';
import { StorageUnavailableError } from './storage-error';
import type {
  Clip,
  ClipEdits,
  ClipEffects,
  ClipStatus,
  PipelineStage,
  Project,
  ProjectJob,
  ProjectSourceKind,
  ProjectStatus,
  SelectedClip,
  TimedWord,
  Transcript,
  TranscriptSegment,
} from './types';

const now = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  picture TEXT,
  password_hash TEXT,
  google_sub TEXT,
  email_key TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_started_at);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS auth_tokens_expiry_idx ON auth_tokens (expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_url TEXT,
  source_path TEXT,
  source_file_name TEXT,
  source_bytes INTEGER,
  source_mime TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  stage TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  status_detail TEXT,
  error TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  fps REAL,
  language TEXT,
  transcription_provider TEXT,
  selection_engine TEXT,
  timing_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  language TEXT,
  timing TEXT NOT NULL,
  text TEXT NOT NULL,
  words_json TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  reason TEXT,
  hook TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  file_path TEXT,
  poster_path TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  caption_mode TEXT,
  crop_strategy TEXT,
  score_breakdown_json TEXT,
  evidence_json TEXT,
  edits_json TEXT,
  effects_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_project_idx ON clips (project_id, idx);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  worker_id TEXT,
  last_error TEXT,
  log_tail TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, created_at);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  version TEXT,
  pid INTEGER,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  clip_id TEXT,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  upload_id TEXT,
  part_size INTEGER,
  expected_bytes INTEGER,
  total_parts INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS storage_objects_project_idx ON storage_objects (project_id, status);
CREATE INDEX IF NOT EXISTS storage_objects_clip_idx ON storage_objects (clip_id, kind);
CREATE INDEX IF NOT EXISTS storage_objects_provider_idx ON storage_objects (provider_id, status);
CREATE INDEX IF NOT EXISTS storage_objects_upload_idx ON storage_objects (upload_id);

CREATE TABLE IF NOT EXISTS storage_reservations (
  id TEXT PRIMARY KEY,
  reservation_key TEXT NOT NULL UNIQUE,
  storage_object_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS storage_reservations_provider_idx ON storage_reservations (provider_id, status);
CREATE INDEX IF NOT EXISTS storage_reservations_project_idx ON storage_reservations (project_id, status);
CREATE INDEX IF NOT EXISTS storage_reservations_expiry_idx ON storage_reservations (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS storage_reservations_active_object_idx
  ON storage_reservations (storage_object_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS storage_provider_state (
  provider_id TEXT PRIMARY KEY,
  listed_bytes INTEGER NOT NULL DEFAULT 0,
  external_bytes INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  measured_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_reconciliation (
  provider_id TEXT PRIMARY KEY,
  last_started_at TEXT NOT NULL,
  last_finished_at TEXT,
  last_success_at TEXT,
  next_attempt_at TEXT,
  lease_until TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

const g = globalThis as unknown as { __autoclipperDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (g.__autoclipperDb) return g.__autoclipperDb;
  const dataDir = config().dataDir;
  let db: DatabaseSync;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(path.join(dataDir, 'autoclipper.db'));
  } catch (error) {
    // Edge/serverless runtimes expose a read-only virtual filesystem. Keep the
    // platform error in the cause for operator logs, but never disguise it as
    // an invalid credential or return a fake session.
    const code = (error as NodeJS.ErrnoException).code ?? 'storage_error';
    throw new StorageUnavailableError(`could not open the database (${code})`, { cause: error });
  }
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  ensureUserColumns(db);
  ensureClipColumns(db);
  ensureProjectOwnerColumns(db);
  ensureStorageProviderColumns(db);
  g.__autoclipperDb = db;
  return db;
}

/**
 * Ownership was added after the first release. Existing projects keep their
 * rows and files but have no owner, so no account can see them until an
 * operator deliberately assigns them. They are never handed to a new user.
 */
function ensureProjectOwnerColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(projects)').all() as Row[]).map((row) => String(row.name)),
  );
  if (!existing.has('owner_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN owner_id TEXT');
  }
  // Must follow the ALTER: an index on a missing column fails an old database.
  db.exec('CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (owner_id, created_at)');
}

/**
 * Accounts predate the switch to email/password and Google sign-in. The new
 * columns are added in place, and the unique indexes are created only after the
 * ALTER statements so an existing database can never fail to open.
 */
function ensureUserColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as Row[]).map((row) => String(row.name)),
  );
  const additions: [string, string][] = [
    ['password_hash', 'TEXT'],
    ['google_sub', 'TEXT'],
    ['email_key', 'TEXT'],
  ];
  for (const [name, type] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  if (!existing.has('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    // Accounts created before email verification existed keep working. Only
    // rows present at migration time are grandfathered; new rows start at 0.
    db.exec(
      'UPDATE users SET email_verified = 1 WHERE password_hash IS NOT NULL OR google_sub IS NOT NULL',
    );
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_key_idx ON users (email_key)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub)');
}

/**
 * Existing databases predate the explainability/editing columns. Adding them in
 * place keeps a user's projects (and rendered files) intact across the upgrade.
 */
function ensureStorageProviderColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(storage_provider_state)').all() as Row[]).map((row) =>
      String(row.name),
    ),
  );
  if (!existing.has('listed_bytes')) {
    // A beta database created before the listing baseline was persisted.
    db.exec('ALTER TABLE storage_provider_state ADD COLUMN listed_bytes INTEGER NOT NULL DEFAULT 0');
  }
}

function ensureClipColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(clips)').all() as Row[]).map((row) => String(row.name)),
  );
  const additions: [string, string][] = [
    ['score_breakdown_json', 'TEXT'],
    ['evidence_json', 'TEXT'],
    ['edits_json', 'TEXT'],
    ['effects_json', 'TEXT'],
  ];
  for (const [name, type] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE clips ADD COLUMN ${name} ${type}`);
  }
}

/** Test helper: closes the cached connection so a fresh data dir can be used. */
export function closeDb(): void {
  if (!g.__autoclipperDb) return;
  try {
    g.__autoclipperDb.close();
  } finally {
    g.__autoclipperDb = undefined;
  }
}

type Row = Record<string, unknown>;

const PROJECT_SELECT = `
  SELECT id, title, source_kind, source_url, source_file_name, source_bytes, source_mime,
         status, stage, progress, status_detail, error, duration_ms, width, height, fps, language,
         transcription_provider, selection_engine, timing_source, created_at, updated_at
  FROM projects
`;

const OWNER_PROJECT_SELECT = `
  SELECT id, title, source_kind, source_url, source_file_name, source_bytes, source_mime,
         status, stage, progress, status_detail, error, duration_ms, width, height, fps, language,
         transcription_provider, selection_engine, timing_source, created_at, updated_at
  FROM projects WHERE owner_id = ?
`;

function toProject(row: Row): Project {
  return {
    id: String(row.id),
    title: String(row.title),
    sourceKind: String(row.source_kind) as ProjectSourceKind,
    sourceUrl: (row.source_url as string | null) ?? null,
    status: String(row.status) as ProjectStatus,
    stage: String(row.stage) as PipelineStage,
    progress: Number(row.progress ?? 0),
    statusDetail: (row.status_detail as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    fps: row.fps === null || row.fps === undefined ? null : Number(row.fps),
    language: (row.language as string | null) ?? null,
    sourceFileName: (row.source_file_name as string | null) ?? null,
    sourceBytes: row.source_bytes === null || row.source_bytes === undefined ? null : Number(row.source_bytes),
    sourceMime: (row.source_mime as string | null) ?? null,
    transcriptionProvider: (row.transcription_provider as string | null) ?? null,
    selectionEngine: (row.selection_engine as string | null) ?? null,
    timingSource: (row.timing_source as 'provider' | 'estimated' | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toClip(row: Row): Clip {
  const nullableNumber = (key: string) =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    index: Number(row.idx),
    title: String(row.title),
    reason: (row.reason as string | null) ?? null,
    hook: (row.hook as string | null) ?? null,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    score: Number(row.score ?? 0),
    status: String(row.status) as ClipStatus,
    error: (row.error as string | null) ?? null,
    bytes: nullableNumber('bytes'),
    width: nullableNumber('width'),
    height: nullableNumber('height'),
    durationMs: nullableNumber('duration_ms'),
    captionMode: (row.caption_mode as string | null) ?? null,
    cropStrategy: (row.crop_strategy as string | null) ?? null,
    scoreBreakdown: parseJson(row.score_breakdown_json),
    evidence: (parseJson(row.evidence_json) as string[] | null) ?? [],
    edits: parseJson(row.edits_json),
    effects: parseJson(row.effects_json),
  };
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export interface AppUser {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
}

/** Profile update used by Google sign-in and the test identity hook. */
export function upsertUser(
  profile: Omit<AppUser, 'emailVerified'> & { emailVerified?: boolean },
): AppUser {
  const timestamp = now();
  const emailKey = profile.email ? normalizeEmail(profile.email) : null;
  const verified = profile.emailVerified ?? true;
  getDb()
    .prepare(
      `INSERT INTO users (id, email, name, picture, email_key, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
         picture = excluded.picture,
         email_key = COALESCE(users.email_key, excluded.email_key),
         email_verified = MAX(users.email_verified, excluded.email_verified),
         updated_at = excluded.updated_at`,
    )
    .run(
      profile.id,
      profile.email,
      profile.name,
      profile.picture,
      emailKey,
      verified ? 1 : 0,
      timestamp,
      timestamp,
    );
  return { id: profile.id, email: profile.email, name: profile.name, picture: profile.picture, emailVerified: verified };
}

function rowToAppUser(row: Row): AppUser {
  return {
    id: String(row.id),
    email: (row.email as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    picture: (row.picture as string | null) ?? null,
    emailVerified: Number(row.email_verified ?? 0) === 1,
  };
}

export function getUser(id: string): AppUser | null {
  const row = getDb()
    .prepare('SELECT id, email, name, picture, email_verified FROM users WHERE id = ?')
    .get(id) as Row | undefined;
  return row ? rowToAppUser(row) : null;
}

export interface EmailUser extends AppUser {
  passwordHash: string | null;
}

/** Email accounts are unique case-insensitively; a missing user is normal. */
export function findUserByEmail(email: string): EmailUser | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE email_key = ?')
    .get(normalizeEmail(email)) as Row | undefined;
  if (!row) return null;
  return { ...rowToAppUser(row), passwordHash: (row.password_hash as string | null) ?? null };
}

/**
 * Creates an email/password account. Returns null when that address already
 * has an account, which is enforced by a unique index as well as this check.
 */
export function createEmailUser(input: {
  email: string;
  name: string | null;
  passwordHash: string;
}): AppUser | null {
  const db = getDb();
  const email = input.email.trim();
  const emailKey = normalizeEmail(email);
  const id = randomUUID();
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT id FROM users WHERE email_key = ?').get(emailKey) as
      | Row
      | undefined;
    if (existing) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare(
      `INSERT INTO users (id, email, name, picture, password_hash, email_key, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)`,
    ).run(id, email, input.name, input.passwordHash, emailKey, timestamp, timestamp);
    db.exec('COMMIT');
    return { id, email, name: input.name, picture: null, emailVerified: false };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction left to roll back.
    }
    throw error;
  }
}

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/**
 * Resolves a Google identity to an account. A Google account is linked to an
 * existing email account only when Google reports the email as verified; an
 * unverified address can never take over an account.
 */
export function findOrCreateGoogleUser(identity: GoogleIdentity): AppUser | null {
  const db = getDb();
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const bySub = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(identity.sub) as
      | Row
      | undefined;
    if (bySub) {
      db.prepare(
        'UPDATE users SET email = ?, name = ?, picture = ?, email_verified = 1, updated_at = ? WHERE id = ?',
      ).run(identity.email, identity.name, identity.picture, timestamp, String(bySub.id));
      db.exec('COMMIT');
      return rowToAppUser({
        ...bySub,
        email: identity.email,
        name: identity.name,
        picture: identity.picture,
        email_verified: 1,
      });
    }

    if (!identity.email || !identity.emailVerified) {
      db.exec('ROLLBACK');
      return null;
    }

    const emailKey = normalizeEmail(identity.email);
    const byEmail = db.prepare('SELECT * FROM users WHERE email_key = ?').get(emailKey) as
      | Row
      | undefined;
    if (byEmail) {
      const existingGoogleSub = (byEmail.google_sub as string | null) ?? null;
      if (existingGoogleSub && existingGoogleSub !== identity.sub) {
        db.exec('ROLLBACK');
        return null;
      }
      db.prepare(
        `UPDATE users SET google_sub = ?, picture = COALESCE(?, picture),
           name = COALESCE(name, ?), email_verified = 1, updated_at = ? WHERE id = ?`,
      ).run(identity.sub, identity.picture, identity.name, timestamp, String(byEmail.id));
      const linked = db.prepare('SELECT * FROM users WHERE id = ?').get(String(byEmail.id)) as Row;
      db.exec('COMMIT');
      return rowToAppUser(linked);
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO users (id, email, name, picture, google_sub, email_key, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      identity.email,
      identity.name,
      identity.picture,
      identity.sub,
      emailKey,
      timestamp,
      timestamp,
    );
    db.exec('COMMIT');
    return { id, email: identity.email, name: identity.name, picture: identity.picture, emailVerified: true };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction left to roll back.
    }
    throw error;
  }
}

/* ----------------------------------------------------------------------------
 * Sessions (only a SHA-256 hash of the cookie token is stored)
 * -------------------------------------------------------------------------- */

export function createSessionRow(tokenHash: string, userId: string, expiresAt: string): void {
  const db = getDb();
  const timestamp = now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(timestamp);
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, userId, timestamp, expiresAt, timestamp);
}

export function getSessionUser(tokenHash: string): AppUser | null {
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.name, u.picture, u.email_verified FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, now()) as Row | undefined;
  return row ? rowToAppUser(row) : null;
}

export function deleteSessionRow(tokenHash: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function revokeUserSessions(userId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/* ----------------------------------------------------------------------------
 * Email verification and password reset (single-use, hashed tokens)
 * -------------------------------------------------------------------------- */

export type AuthTokenPurpose = 'verify_email' | 'reset_password';

/** Invalidates any earlier token for the same purpose and stores a new hash. */
export function createAuthToken(
  tokenHash: string,
  userId: string,
  purpose: AuthTokenPurpose,
  expiresAt: string,
): void {
  const db = getDb();
  const timestamp = now();
  db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').run(timestamp);
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare(
    `INSERT INTO auth_tokens (token_hash, user_id, purpose, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, userId, purpose, timestamp, expiresAt);
}

/**
 * Atomically consumes a token. A token that was already used, expired, or was
 * issued for another purpose resolves to null, so links cannot be replayed.
 */
export function consumeAuthToken(
  tokenHash: string,
  purpose: AuthTokenPurpose,
): { userId: string } | null {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(
        `SELECT user_id FROM auth_tokens
         WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, purpose, now()) as Row | undefined;
    if (!row) {
      db.exec('ROLLBACK');
      return null;
    }
    db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?').run(now(), tokenHash);
    db.exec('COMMIT');
    return { userId: String(row.user_id) };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction left to roll back.
    }
    throw error;
  }
}

export function markEmailVerified(userId: string): void {
  const db = getDb();
  db.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').run(now(), userId);
  db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email'").run(userId);
}

export function setUserPassword(userId: string, passwordHash: string): void {
  getDb()
    .prepare('UPDATE users SET password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?')
    .run(passwordHash, now(), userId);
}

export type StorageObjectKind = 'source' | 'video' | 'poster';

export type StorageObjectStatus =
  | 'pending'
  | 'uploading'
  | 'complete'
  | 'failed'
  | 'deleting'
  | 'delete_failed';

export interface StorageObjectRecord {
  id: string;
  idempotencyKey: string;
  ownerId: string;
  projectId: string;
  clipId: string | null;
  kind: StorageObjectKind;
  providerId: string;
  bucket: string;
  key: string;
  bytes: number;
  contentType: string | null;
  status: StorageObjectStatus;
  attempts: number;
  lastError: string | null;
  uploadId: string | null;
  partSize: number | null;
  expectedBytes: number | null;
  totalParts: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface NewStorageObjectInput {
  id: string;
  idempotencyKey: string;
  ownerId: string;
  projectId: string;
  clipId?: string | null;
  kind: StorageObjectKind;
  providerId: string;
  bucket: string;
  key: string;
  bytes?: number;
  contentType?: string | null;
  status: StorageObjectStatus;
  attempts?: number;
  lastError?: string | null;
  uploadId?: string | null;
  partSize?: number | null;
  expectedBytes?: number | null;
  totalParts?: number | null;
  completedAt?: string | null;
}

export interface StorageObjectPatch {
  providerId?: string;
  bucket?: string;
  key?: string;
  bytes?: number;
  contentType?: string | null;
  status?: StorageObjectStatus;
  attempts?: number;
  lastError?: string | null;
  uploadId?: string | null;
  partSize?: number | null;
  expectedBytes?: number | null;
  totalParts?: number | null;
  completedAt?: string | null;
}

export interface StorageBytesByProvider {
  providerId: string;
  bytes: number;
  objectCount: number;
}

export type StorageReservationStatus = 'active' | 'released';

export interface NewStorageReservationInput {
  id: string;
  reservationKey: string;
  storageObjectId: string;
  projectId: string;
  providerId: string;
  bytes: number;
  expiresAt: string;
  providerSafeLimitBytes: number;
  targetBytes: number;
}

export interface StorageReservationRecord {
  id: string;
  reservationKey: string;
  storageObjectId: string;
  projectId: string;
  providerId: string;
  bytes: number;
  status: StorageReservationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageReservationSummary {
  bytes: number;
  count: number;
}

export interface StorageProviderStateRecord {
  providerId: string;
  listedBytes: number;
  externalBytes: number;
  verified: boolean;
  measuredAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/** Durable bookkeeping for the once-per-day provider reconciliation. */
export interface StorageReconciliationRecord {
  providerId: string;
  lastStartedAt: string;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface StorageBytesByProject {
  projectId: string;
  kind: StorageObjectKind;
  bytes: number;
  objectCount: number;
}

export interface NewProjectInput {
  id: string;
  ownerId: string;
  title: string;
  sourceKind: ProjectSourceKind;
  sourceUrl?: string | null;
  sourceFileName?: string | null;
  sourceBytes?: number | null;
  sourceMime?: string | null;
  status?: ProjectStatus;
  sourcePath?: string | null;
}

export function createProject(input: NewProjectInput): Project {
  const db = getDb();
  const timestamp = now();
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, source_kind, source_url, source_path, source_file_name, source_bytes,
       source_mime, status, stage, progress, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(
    input.id,
    input.ownerId,
    input.title,
    input.sourceKind,
    input.sourceUrl ?? null,
    input.sourcePath ?? null,
    input.sourceFileName ?? null,
    input.sourceBytes ?? null,
    input.sourceMime ?? null,
    input.status ?? 'draft',
    timestamp,
    timestamp,
  );
  const project = getProject(input.id);
  if (!project) throw new Error('Project insert failed');
  return project;
}

/** Internal worker lookup. HTTP routes must use `getProjectForOwner`. */
export function getProject(id: string): Project | null {
  const row = getDb().prepare(`${PROJECT_SELECT} WHERE id = ?`).get(id) as Row | undefined;
  return row ? toProject(row) : null;
}

/** The only lookup HTTP route handlers may use; a foreign id looks nonexistent. */
export function getProjectForOwner(id: string, ownerId: string): Project | null {
  const row = getDb().prepare(`${PROJECT_SELECT} WHERE id = ? AND owner_id = ?`).get(id, ownerId) as
    | Row
    | undefined;
  return row ? toProject(row) : null;
}

/** Operator-only migration: hands ownerless legacy rows to an explicit account. */
export function assignUnownedProjects(ownerId: string): number {
  const result = getDb()
    .prepare('UPDATE projects SET owner_id = ?, updated_at = ? WHERE owner_id IS NULL')
    .run(ownerId, now());
  return Number(result.changes ?? 0);
}

export function countUnownedProjects(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id IS NULL').get() as Row;
  return Number(row.n ?? 0);
}

export function getProjectSourcePath(id: string): string | null {
  const row = getDb().prepare('SELECT source_path FROM projects WHERE id = ?').get(id) as
    | Row
    | undefined;
  return row && row.source_path ? String(row.source_path) : null;
}

export function listProjects(ownerId: string, limit = 50): Project[] {
  const rows = getDb()
    .prepare(`${OWNER_PROJECT_SELECT} ORDER BY created_at DESC LIMIT ?`)
    .all(ownerId, limit) as Row[];
  return rows.map(toProject);
}

export interface ProjectPatch {
  title?: string;
  sourceUrl?: string | null;
  sourcePath?: string | null;
  sourceFileName?: string | null;
  sourceBytes?: number | null;
  sourceMime?: string | null;
  status?: ProjectStatus;
  stage?: PipelineStage;
  progress?: number;
  statusDetail?: string | null;
  error?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  language?: string | null;
  transcriptionProvider?: string | null;
  selectionEngine?: string | null;
  timingSource?: 'provider' | 'estimated' | null;
}

const PROJECT_PATCH_COLUMNS: Record<keyof ProjectPatch, string> = {
  title: 'title',
  sourceUrl: 'source_url',
  sourcePath: 'source_path',
  sourceFileName: 'source_file_name',
  sourceBytes: 'source_bytes',
  sourceMime: 'source_mime',
  status: 'status',
  stage: 'stage',
  progress: 'progress',
  statusDetail: 'status_detail',
  error: 'error',
  durationMs: 'duration_ms',
  width: 'width',
  height: 'height',
  fps: 'fps',
  language: 'language',
  transcriptionProvider: 'transcription_provider',
  selectionEngine: 'selection_engine',
  timingSource: 'timing_source',
};

export function updateProject(id: string, patch: ProjectPatch): void {
  const entries = Object.entries(patch).filter(([key]) => key in PROJECT_PATCH_COLUMNS);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${PROJECT_PATCH_COLUMNS[key as keyof ProjectPatch]} = ?`);
  const values = entries.map(([, value]) => (value === undefined ? null : (value as string | number | null)));
  getDb()
    .prepare(`UPDATE projects SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, now(), id);
}

export function deleteProject(id: string): void {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Explicit child deletes make the result independent of foreign-key
    // enforcement, while the transaction keeps the project from being half
    // removed.
    db.prepare('DELETE FROM transcripts WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM clips WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM storage_reservations WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM storage_objects WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function saveTranscript(projectId: string, transcript: Transcript): void {
  getDb()
    .prepare(
      `INSERT INTO transcripts (project_id, provider, language, timing, text, words_json, segments_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET provider = excluded.provider, language = excluded.language,
         timing = excluded.timing, text = excluded.text, words_json = excluded.words_json,
         segments_json = excluded.segments_json, created_at = excluded.created_at`,
    )
    .run(
      projectId,
      transcript.provider,
      transcript.language,
      transcript.timing,
      transcript.text,
      JSON.stringify(transcript.words),
      JSON.stringify(transcript.segments),
      now(),
    );
}

export function getTranscript(projectId: string): Transcript | null {
  const row = getDb()
    .prepare(
      'SELECT provider, language, timing, text, words_json, segments_json FROM transcripts WHERE project_id = ?',
    )
    .get(projectId) as Row | undefined;
  if (!row) return null;
  return {
    provider: String(row.provider),
    language: (row.language as string | null) ?? null,
    timing: String(row.timing) as 'provider' | 'estimated',
    text: String(row.text),
    words: JSON.parse(String(row.words_json)) as TimedWord[],
    segments: JSON.parse(String(row.segments_json)) as TranscriptSegment[],
  };
}

export function replaceClips(
  projectId: string,
  clips: (SelectedClip & { id: string })[],
): Clip[] {
  const db = getDb();
  db.prepare('DELETE FROM clips WHERE project_id = ?').run(projectId);
  const insert = db.prepare(
    `INSERT INTO clips (id, project_id, idx, title, reason, hook, start_ms, end_ms, score, status,
       score_breakdown_json, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  );
  const timestamp = now();
  clips.forEach((clip, index) => {
    insert.run(
      clip.id,
      projectId,
      index,
      clip.title,
      clip.reason,
      clip.hook,
      Math.round(clip.startMs),
      Math.round(clip.endMs),
      clip.score,
      clip.scoreBreakdown ? JSON.stringify(clip.scoreBreakdown) : null,
      clip.evidence ? JSON.stringify(clip.evidence) : null,
      timestamp,
    );
  });
  return getClips(projectId);
}

export function getClips(projectId: string): Clip[] {
  const rows = getDb()
    .prepare(
      `SELECT id, project_id, idx, title, reason, hook, start_ms, end_ms, score, status, error,
              file_path, poster_path, bytes, width, height, duration_ms, caption_mode, crop_strategy,
              score_breakdown_json, evidence_json, edits_json, effects_json
       FROM clips WHERE project_id = ? ORDER BY idx ASC`,
    )
    .all(projectId) as Row[];
  return rows.map(toClip);
}

/** Clip + file paths, but only when the clip belongs to a project owned by `ownerId`. */
export function getClipForOwner(
  id: string,
  ownerId: string,
): (Clip & { filePath: string | null; posterPath: string | null }) | null {
  const row = getDb()
    .prepare(
      `SELECT c.id, c.project_id, c.idx, c.title, c.reason, c.hook, c.start_ms, c.end_ms, c.score, c.status,
              c.error, c.file_path, c.poster_path, c.bytes, c.width, c.height, c.duration_ms, c.caption_mode,
              c.crop_strategy, c.score_breakdown_json, c.evidence_json, c.edits_json, c.effects_json
       FROM clips c JOIN projects p ON p.id = c.project_id
       WHERE c.id = ? AND p.owner_id = ?`,
    )
    .get(id, ownerId) as Row | undefined;
  if (!row) return null;
  return {
    ...toClip(row),
    filePath: (row.file_path as string | null) ?? null,
    posterPath: (row.poster_path as string | null) ?? null,
  };
}

export function getClip(id: string): (Clip & { filePath: string | null; posterPath: string | null }) | null {
  const row = getDb()
    .prepare(
      `SELECT id, project_id, idx, title, reason, hook, start_ms, end_ms, score, status, error,
              file_path, poster_path, bytes, width, height, duration_ms, caption_mode, crop_strategy,
              score_breakdown_json, evidence_json, edits_json, effects_json
       FROM clips WHERE id = ?`,
    )
    .get(id) as Row | undefined;
  if (!row) return null;
  return {
    ...toClip(row),
    filePath: (row.file_path as string | null) ?? null,
    posterPath: (row.poster_path as string | null) ?? null,
  };
}

export interface ClipPatch {
  status?: ClipStatus;
  error?: string | null;
  filePath?: string | null;
  posterPath?: string | null;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  captionMode?: string | null;
  cropStrategy?: string | null;
  title?: string;
  startMs?: number;
  endMs?: number;
  edits?: ClipEdits | null;
  effects?: ClipEffects | null;
}

const CLIP_PATCH_COLUMNS: Record<keyof ClipPatch, string> = {
  status: 'status',
  error: 'error',
  filePath: 'file_path',
  posterPath: 'poster_path',
  bytes: 'bytes',
  width: 'width',
  height: 'height',
  durationMs: 'duration_ms',
  captionMode: 'caption_mode',
  cropStrategy: 'crop_strategy',
  title: 'title',
  startMs: 'start_ms',
  endMs: 'end_ms',
  edits: 'edits_json',
  effects: 'effects_json',
};

export function updateClip(id: string, patch: ClipPatch): void {
  const entries = Object.entries(patch).filter(([key]) => key in CLIP_PATCH_COLUMNS);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${CLIP_PATCH_COLUMNS[key as keyof ClipPatch]} = ?`);
  const values = entries.map(([, value]) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') return JSON.stringify(value);
    return value as string | number;
  });
  getDb()
    .prepare(`UPDATE clips SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values, id);
}

function toStorageObject(row: Row): StorageObjectRecord {
  const nullableNumber = (key: string) =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    ownerId: String(row.owner_id),
    projectId: String(row.project_id),
    clipId: (row.clip_id as string | null) ?? null,
    kind: String(row.kind) as StorageObjectKind,
    providerId: String(row.provider_id),
    bucket: String(row.bucket),
    key: String(row.key),
    bytes: Number(row.bytes ?? 0),
    contentType: (row.content_type as string | null) ?? null,
    status: String(row.status) as StorageObjectStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: (row.last_error as string | null) ?? null,
    uploadId: (row.upload_id as string | null) ?? null,
    partSize: nullableNumber('part_size'),
    expectedBytes: nullableNumber('expected_bytes'),
    totalParts: nullableNumber('total_parts'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

export function getStorageObject(id: string): StorageObjectRecord | null {
  const row = getDb().prepare('SELECT * FROM storage_objects WHERE id = ?').get(id) as Row | undefined;
  return row ? toStorageObject(row) : null;
}

export function getStorageObjectByIdempotencyKey(key: string): StorageObjectRecord | null {
  const row = getDb().prepare('SELECT * FROM storage_objects WHERE idempotency_key = ?').get(key) as
    | Row
    | undefined;
  return row ? toStorageObject(row) : null;
}

export function getStorageObjectByUploadId(
  projectId: string,
  uploadId: string,
): StorageObjectRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM storage_objects WHERE project_id = ? AND upload_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(projectId, uploadId) as Row | undefined;
  return row ? toStorageObject(row) : null;
}

export function getStorageObjectsForProject(projectId: string): StorageObjectRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM storage_objects WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as Row[];
  return rows.map(toStorageObject);
}

export function getStorageObjectsForClip(clipId: string): StorageObjectRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM storage_objects WHERE clip_id = ? ORDER BY updated_at DESC')
    .all(clipId) as Row[];
  return rows.map(toStorageObject);
}

export function getLatestStorageObjectForClip(
  clipId: string,
  kind: StorageObjectKind,
  status: StorageObjectStatus = 'complete',
): StorageObjectRecord | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM storage_objects WHERE clip_id = ? AND kind = ? AND status = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .get(clipId, kind, status) as Row | undefined;
  return row ? toStorageObject(row) : null;
}

export function upsertStorageObject(input: NewStorageObjectInput): StorageObjectRecord {
  const timestamp = now();
  const existing = getStorageObjectByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE storage_objects SET provider_id = ?, bucket = ?, key = ?, bytes = ?, content_type = ?,
           status = ?, attempts = ?, last_error = ?, upload_id = ?, part_size = ?, expected_bytes = ?,
           total_parts = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.providerId,
        input.bucket,
        input.key,
        input.bytes ?? 0,
        input.contentType ?? null,
        input.status,
        input.attempts ?? existing.attempts,
        input.lastError ?? null,
        input.uploadId ?? null,
        input.partSize ?? null,
        input.expectedBytes ?? null,
        input.totalParts ?? null,
        input.completedAt ?? null,
        timestamp,
        existing.id,
      );
    return getStorageObject(existing.id) as StorageObjectRecord;
  }

  getDb()
    .prepare(
      `INSERT INTO storage_objects (id, idempotency_key, owner_id, project_id, clip_id, kind, provider_id,
         bucket, key, bytes, content_type, status, attempts, last_error, upload_id, part_size, expected_bytes,
         total_parts, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.idempotencyKey,
      input.ownerId,
      input.projectId,
      input.clipId ?? null,
      input.kind,
      input.providerId,
      input.bucket,
      input.key,
      input.bytes ?? 0,
      input.contentType ?? null,
      input.status,
      input.attempts ?? 0,
      input.lastError ?? null,
      input.uploadId ?? null,
      input.partSize ?? null,
      input.expectedBytes ?? null,
      input.totalParts ?? null,
      timestamp,
      timestamp,
      input.completedAt ?? null,
    );
  return getStorageObject(input.id) as StorageObjectRecord;
}

const STORAGE_OBJECT_PATCH_COLUMNS: Record<keyof StorageObjectPatch, string> = {
  providerId: 'provider_id',
  bucket: 'bucket',
  key: 'key',
  bytes: 'bytes',
  contentType: 'content_type',
  status: 'status',
  attempts: 'attempts',
  lastError: 'last_error',
  uploadId: 'upload_id',
  partSize: 'part_size',
  expectedBytes: 'expected_bytes',
  totalParts: 'total_parts',
  completedAt: 'completed_at',
};

export function updateStorageObject(id: string, patch: StorageObjectPatch): void {
  const entries = Object.entries(patch).filter(([key]) => key in STORAGE_OBJECT_PATCH_COLUMNS);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${STORAGE_OBJECT_PATCH_COLUMNS[key as keyof StorageObjectPatch]} = ?`);
  const values = entries.map(([, value]) => value === undefined ? null : value);
  getDb()
    .prepare(`UPDATE storage_objects SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, now(), id);
}

export function deleteStorageObject(id: string): void {
  getDb().prepare('DELETE FROM storage_reservations WHERE storage_object_id = ?').run(id);
  getDb().prepare('DELETE FROM storage_objects WHERE id = ?').run(id);
}

export function deleteStorageObjectsForProject(projectId: string): void {
  getDb().prepare('DELETE FROM storage_reservations WHERE project_id = ?').run(projectId);
  getDb().prepare('DELETE FROM storage_objects WHERE project_id = ?').run(projectId);
}

export function sumStorageObjectsByProvider(providerId: string): StorageBytesByProvider {
  const row = getDb()
    .prepare(
      `SELECT provider_id, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n
       FROM storage_objects WHERE provider_id = ? AND status IN ('pending', 'uploading', 'complete')
       GROUP BY provider_id`,
    )
    .get(providerId) as Row | undefined;
  return {
    providerId,
    bytes: Number(row?.bytes ?? 0),
    objectCount: Number(row?.n ?? 0),
  };
}

export function sumPendingStorageObjectsByProvider(providerId: string): StorageBytesByProvider {
  const row = getDb()
    .prepare(
      `SELECT provider_id, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n
       FROM storage_objects WHERE provider_id = ? AND status IN ('pending', 'uploading')
       GROUP BY provider_id`,
    )
    .get(providerId) as Row | undefined;
  return {
    providerId,
    bytes: Number(row?.bytes ?? 0),
    objectCount: Number(row?.n ?? 0),
  };
}

export function sumStorageObjectsByProject(projectIds: string[]): StorageBytesByProject[] {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT project_id, kind, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n
       FROM storage_objects WHERE project_id IN (${placeholders}) AND status = 'complete'
       GROUP BY project_id, kind`,
    )
    .all(...projectIds) as Row[];
  return rows.map((row) => ({
    projectId: String(row.project_id),
    kind: String(row.kind) as StorageObjectKind,
    bytes: Number(row.bytes ?? 0),
    objectCount: Number(row.n ?? 0),
  }));
}

export function getLatestStorageObjectByProject(
  projectId: string,
  kind: StorageObjectKind,
): StorageObjectRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM storage_objects WHERE project_id = ? AND kind = ? AND status = 'complete'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(projectId, kind) as Row | undefined;
  return row ? toStorageObject(row) : null;
}

export function storageFailureCounts(projectIds: string[]): {
  failedUploads: number;
  failedDeletions: number;
} {
  if (projectIds.length === 0) return { failedUploads: 0, failedDeletions: 0 };
  const placeholders = projectIds.map(() => '?').join(', ');
  const row = getDb()
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_uploads,
         SUM(CASE WHEN status = 'delete_failed' THEN 1 ELSE 0 END) AS failed_deletions
       FROM storage_objects WHERE project_id IN (${placeholders})`,
    )
    .get(...projectIds) as Row | undefined;
  return {
    failedUploads: Number(row?.failed_uploads ?? 0),
    failedDeletions: Number(row?.failed_deletions ?? 0),
  };
}

/* ----------------------------------------------------------------------------
 * Distributed storage capacity reservations
 * -------------------------------------------------------------------------- */

function toStorageReservation(row: Row): StorageReservationRecord {
  return {
    id: String(row.id),
    reservationKey: String(row.reservation_key),
    storageObjectId: String(row.storage_object_id),
    projectId: String(row.project_id),
    providerId: String(row.provider_id),
    bytes: Number(row.bytes ?? 0),
    status: String(row.status) as StorageReservationStatus,
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Reserves bytes at the same instant it checks both the provider cap and the
 * aggregate target. A process-local lock cannot coordinate separate Workers;
 * this INSERT ... SELECT relies on SQLite/D1's serialized writes instead.
 * Returns null when the provider or aggregate has insufficient capacity.
 */
export function tryReserveStorageCapacity(
  input: NewStorageReservationInput,
): StorageReservationRecord | null {
  const db = getDb();
  const timestamp = now();
  try {
    const result = db
      .prepare(RESERVE_STORAGE_CAPACITY_SQL)
      .run(
        input.id,
        input.reservationKey,
        input.storageObjectId,
        input.projectId,
        input.providerId,
        input.bytes,
        input.expiresAt,
        timestamp,
        timestamp,
        input.providerSafeLimitBytes,
        input.targetBytes,
      );
    if (Number(result.changes ?? 0) > 0) {
      return getStorageReservation(input.id);
    }
  } catch (error) {
    // Another Worker may have won the same object's active reservation. That
    // reservation is the correct answer for an idempotent retry.
    const active = getActiveStorageReservationForObject(input.storageObjectId);
    if (active) return active;
    throw error;
  }
  return getActiveStorageReservationForObject(input.storageObjectId);
}

export function getStorageReservation(id: string): StorageReservationRecord | null {
  const row = getDb().prepare('SELECT * FROM storage_reservations WHERE id = ?').get(id) as Row | undefined;
  return row ? toStorageReservation(row) : null;
}

export function getActiveStorageReservationForObject(objectId: string): StorageReservationRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM storage_reservations WHERE storage_object_id = ? AND status = 'active' LIMIT 1")
    .get(objectId) as Row | undefined;
  return row ? toStorageReservation(row) : null;
}

export function releaseStorageReservation(id: string): void {
  getDb()
    .prepare("UPDATE storage_reservations SET status = 'released', updated_at = ? WHERE id = ? AND status = 'active'")
    .run(now(), id);
}

export function releaseActiveReservationsForObject(objectId: string): void {
  getDb()
    .prepare(
      "UPDATE storage_reservations SET status = 'released', updated_at = ? WHERE storage_object_id = ? AND status = 'active'",
    )
    .run(now(), objectId);
}

export function getExpiredStorageReservations(
  expiredBefore: string,
  limit = 25,
): StorageReservationRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM storage_reservations WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?",
    )
    .all(expiredBefore, limit) as Row[];
  return rows.map(toStorageReservation);
}

export function sumActiveStorageReservationsByProvider(providerId: string): StorageReservationSummary {
  const row = getDb()
    .prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM storage_reservations WHERE provider_id = ? AND status = 'active'",
    )
    .get(providerId) as Row | undefined;
  return { bytes: Number(row?.bytes ?? 0), count: Number(row?.n ?? 0) };
}

export function sumActiveStorageReservations(): StorageReservationSummary {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM storage_reservations WHERE status = 'active'")
    .get() as Row | undefined;
  return { bytes: Number(row?.bytes ?? 0), count: Number(row?.n ?? 0) };
}

export function setStorageProviderState(input: {
  providerId: string;
  listedBytes: number;
  externalBytes: number;
  verified: boolean;
  measuredAt: string | null;
  lastError: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO storage_provider_state
         (provider_id, listed_bytes, external_bytes, verified, measured_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET listed_bytes = excluded.listed_bytes,
         external_bytes = excluded.external_bytes, verified = excluded.verified,
         measured_at = excluded.measured_at, last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.providerId,
      Math.max(0, Math.round(input.listedBytes)),
      Math.max(0, Math.round(input.externalBytes)),
      input.verified ? 1 : 0,
      input.measuredAt,
      input.lastError,
      now(),
    );
}

export function getStorageProviderState(providerId: string): StorageProviderStateRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM storage_provider_state WHERE provider_id = ?')
    .get(providerId) as Row | undefined;
  if (!row) return null;
  return {
    providerId: String(row.provider_id),
    listedBytes: Number(row.listed_bytes ?? 0),
    externalBytes: Number(row.external_bytes ?? 0),
    verified: Number(row.verified ?? 0) === 1,
    measuredAt: (row.measured_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    updatedAt: String(row.updated_at),
  };
}

/** Atomic fixed-window consume; returns the count this caller produced. */
export function consumeRateLimitRow(input: {
  key: string;
  now: string;
  resetBefore: string;
}): { count: number; windowStartedAt: string } | null {
  const row = getDb()
    .prepare(CONSUME_RATE_LIMIT_SQL)
    .get(
      input.key,
      input.now,
      input.now,
      input.resetBefore,
      input.resetBefore,
    ) as Row | undefined;
  if (!row) return null;
  return {
    count: Number(row.count ?? 0),
    windowStartedAt: String(row.window_started_at),
  };
}

export function resetRateLimitRow(key: string): void {
  getDb().prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
}

export function purgeRateLimitRows(before: string): number {
  const result = getDb().prepare('DELETE FROM rate_limits WHERE window_started_at < ?').run(before);
  return Number(result.changes ?? 0);
}

/**
 * Writes provider state only if nobody else changed it since `expectedUpdatedAt`
 * was read. A daily listing can take seconds, and applying it on top of a newer
 * measurement would resurrect stale usage numbers.
 */
export function compareAndSetStorageProviderState(input: {
  providerId: string;
  listedBytes: number;
  externalBytes: number;
  verified: boolean;
  measuredAt: string | null;
  lastError: string | null;
  expectedUpdatedAt: string | null;
}): boolean {
  const database = getDb();
  const timestamp = now();
  const listedBytes = Math.max(0, Math.round(input.listedBytes));
  const externalBytes = Math.max(0, Math.round(input.externalBytes));
  if (input.expectedUpdatedAt === null) {
    const result = database
      .prepare(
        `INSERT INTO storage_provider_state
           (provider_id, listed_bytes, external_bytes, verified, measured_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO NOTHING`,
      )
      .run(
        input.providerId,
        listedBytes,
        externalBytes,
        input.verified ? 1 : 0,
        input.measuredAt,
        input.lastError,
        timestamp,
      );
    return Number(result.changes ?? 0) > 0;
  }
  const result = database
    .prepare(
      `UPDATE storage_provider_state
       SET listed_bytes = ?, external_bytes = ?, verified = ?, measured_at = ?, last_error = ?, updated_at = ?
       WHERE provider_id = ? AND updated_at = ?`,
    )
    .run(
      listedBytes,
      externalBytes,
      input.verified ? 1 : 0,
      input.measuredAt,
      input.lastError,
      timestamp,
      input.providerId,
      input.expectedUpdatedAt,
    );
  return Number(result.changes ?? 0) > 0;
}

export function claimStorageReconciliation(input: {
  providerId: string;
  now: string;
  leaseUntil: string;
  force: boolean;
}): boolean {
  const result = getDb()
    .prepare(CLAIM_STORAGE_RECONCILIATION_SQL)
    .run(
      input.providerId,
      input.now,
      input.leaseUntil,
      input.now,
      input.force ? 1 : 0,
      input.now,
      input.now,
    );
  return Number(result.changes ?? 0) > 0;
}

export function finishStorageReconciliation(input: {
  providerId: string;
  finishedAt: string;
  success: boolean;
  nextAttemptAt: string;
  error: string | null;
}): void {
  getDb()
    .prepare(FINISH_STORAGE_RECONCILIATION_SQL)
    .run(
      input.finishedAt,
      input.success ? 1 : 0,
      input.finishedAt,
      input.nextAttemptAt,
      input.error,
      input.success ? 1 : 0,
      input.success ? 0 : 1,
      input.finishedAt,
      input.providerId,
    );
}

export function getStorageReconciliation(
  providerId: string,
): StorageReconciliationRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM storage_reconciliation WHERE provider_id = ?')
    .get(providerId) as Row | undefined;
  if (!row) return null;
  return {
    providerId: String(row.provider_id),
    lastStartedAt: String(row.last_started_at),
    lastFinishedAt: (row.last_finished_at as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    nextAttemptAt: (row.next_attempt_at as string | null) ?? null,
    leaseUntil: (row.lease_until as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
  };
}

/* ----------------------------------------------------------------------------
 * Jobs
 * -------------------------------------------------------------------------- */

export interface Job {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toJob(row: Row): Job {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: String(row.status) as Job['status'],
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

export function enqueueJob(projectId: string, jobId: string): Job {
  const db = getDb();
  db.prepare(
    `INSERT INTO jobs (id, project_id, status, attempts, created_at) VALUES (?, ?, 'queued', 0, ?)`,
  ).run(jobId, projectId, now());
  updateProject(projectId, { status: 'queued', stage: 'queued', progress: 0, error: null, statusDetail: null });
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Row;
  return toJob(row);
}

export function getLatestJob(projectId: string): Job | null {
  const row = getDb()
    .prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectId) as Row | undefined;
  return row ? toJob(row) : null;
}

export function hasActiveJob(projectId: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1")
    .get(projectId) as Row | undefined;
  return Boolean(row);
}

/** Atomically claims the oldest queued job, or a stale running job whose worker died. */
export function claimNextJob(workerId: string, staleAfterMs = 120_000): Job | null {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const row = getDb()
    .prepare(
      `UPDATE jobs
       SET status = 'running', worker_id = ?, started_at = ?, heartbeat_at = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE (status = 'queued')
            OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?))
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(workerId, now(), now(), cutoff) as Row | undefined;
  if (!row) return null;
  return toJob(row);
}

export function heartbeatJob(jobId: string): void {
  getDb().prepare('UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = ?').run(now(), jobId, 'running');
}

export function finishJob(jobId: string): void {
  getDb()
    .prepare("UPDATE jobs SET status = 'done', finished_at = ?, last_error = NULL WHERE id = ?")
    .run(now(), jobId);
}

export function failJob(jobId: string, message: string, logTail: string | null): void {
  getDb()
    .prepare("UPDATE jobs SET status = 'failed', finished_at = ?, last_error = ?, log_tail = ? WHERE id = ?")
    .run(now(), message.slice(0, 2000), logTail ? logTail.slice(-4000) : null, jobId);
}

export function requeueJob(jobId: string): void {
  getDb()
    .prepare("UPDATE jobs SET status = 'queued', heartbeat_at = NULL, worker_id = NULL WHERE id = ?")
    .run(jobId);
}

export function recordWorkerHeartbeat(workerId: string, version: string): void {
  const timestamp = now();
  getDb()
    .prepare(
      `INSERT INTO workers (id, version, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, version = excluded.version, pid = excluded.pid`,
    )
    .run(workerId, version, process.pid, timestamp, timestamp);
}

export function workerIsOnline(maxAgeMs = 30_000): boolean {
  const row = getDb()
    .prepare('SELECT heartbeat_at FROM workers ORDER BY heartbeat_at DESC LIMIT 1')
    .get() as Row | undefined;
  if (!row || !row.heartbeat_at) return false;
  return Date.now() - new Date(String(row.heartbeat_at)).getTime() < maxAgeMs;
}

/** Clears render results so a failed or finished project can run again. */
export function resetProjectForRun(projectId: string): void {
  getDb().prepare('DELETE FROM clips WHERE project_id = ?').run(projectId);
  updateProject(projectId, {
    status: 'queued',
    stage: 'queued',
    progress: 0,
    error: null,
    statusDetail: 'Waiting for a processing worker',
  });
}

export function toProjectJob(job: Job | null): ProjectJob | null {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}
