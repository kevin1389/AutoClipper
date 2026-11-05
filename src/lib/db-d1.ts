import { randomUUID } from 'node:crypto';
import { normalizeEmail } from './email';
import { RESERVE_STORAGE_CAPACITY_SQL } from './storage-capacity-sql';
import type {
  AppUser,
  AuthTokenPurpose,
  ClipPatch,
  EmailUser,
  GoogleIdentity,
  Job,
  NewProjectInput,
  ProjectPatch,
  NewStorageObjectInput,
  StorageBytesByProvider,
  StorageBytesByProject,
  StorageObjectKind,
  StorageObjectPatch,
  StorageObjectRecord,
  StorageObjectStatus,
  NewStorageReservationInput,
  StorageProviderStateRecord,
  StorageReservationRecord,
  StorageReservationStatus,
  StorageReservationSummary,
} from './db-sqlite';
import type {
  Clip,
  ClipEdits,
  ClipEffects,
  ClipStatus,
  PipelineStage,
  Project,
  ProjectSourceKind,
  ProjectStatus,
  SelectedClip,
  TimedWord,
  Transcript,
  TranscriptSegment,
} from './types';

/**
 * Cloudflare D1 implementation of the account/project store.
 *
 * The Worker has no writable filesystem, so the Node SQLite implementation in
 * db-sqlite.ts is only loaded when no D1 binding is present. Statements are
 * ordinary SQLite SQL; D1's async prepared-statement API is wrapped here.
 */

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta?: { changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

type Row = Record<string, unknown>;

let database: D1Database | null = null;
let schemaPromise: Promise<void> | null = null;

const now = () => new Date().toISOString();

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_key_idx ON users (email_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, purpose)`,
  `CREATE INDEX IF NOT EXISTS auth_tokens_expiry_idx ON auth_tokens (expires_at)`,
  `CREATE TABLE IF NOT EXISTS projects (
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
  )`,
  `CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (owner_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS transcripts (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    language TEXT,
    timing TEXT NOT NULL,
    text TEXT NOT NULL,
    words_json TEXT NOT NULL,
    segments_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS clips (
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
  )`,
  `CREATE INDEX IF NOT EXISTS clips_project_idx ON clips (project_id, idx)`,
  `CREATE TABLE IF NOT EXISTS jobs (
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
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    version TEXT,
    pid INTEGER,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS storage_objects (
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
  )`,
  `CREATE INDEX IF NOT EXISTS storage_objects_project_idx ON storage_objects (project_id, status)`,
  `CREATE INDEX IF NOT EXISTS storage_objects_clip_idx ON storage_objects (clip_id, kind)`,
  `CREATE INDEX IF NOT EXISTS storage_objects_provider_idx ON storage_objects (provider_id, status)`,
  `CREATE INDEX IF NOT EXISTS storage_objects_upload_idx ON storage_objects (upload_id)`,
  `CREATE TABLE IF NOT EXISTS storage_reservations (
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
  )`,
  `CREATE INDEX IF NOT EXISTS storage_reservations_provider_idx ON storage_reservations (provider_id, status)`,
  `CREATE INDEX IF NOT EXISTS storage_reservations_project_idx ON storage_reservations (project_id, status)`,
  `CREATE INDEX IF NOT EXISTS storage_reservations_expiry_idx ON storage_reservations (status, expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS storage_reservations_active_object_idx
    ON storage_reservations (storage_object_id) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS storage_provider_state (
    provider_id TEXT PRIMARY KEY,
    listed_bytes INTEGER NOT NULL DEFAULT 0,
    external_bytes INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    measured_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  )`,
];

export function init(db: D1Database): void {
  database = db;
}

function d1(): D1Database {
  if (!database) throw new Error('D1 binding is not initialized');
  return database;
}

/** Runs once per isolate. CREATE IF NOT EXISTS makes this safe on redeploys. */
export function ensureSchema(): Promise<void> {
  schemaPromise ??= d1()
    .batch(SCHEMA.map((statement) => d1().prepare(statement)))
    .then(() => undefined);
  return schemaPromise;
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
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    fps: row.fps == null ? null : Number(row.fps),
    language: (row.language as string | null) ?? null,
    sourceFileName: (row.source_file_name as string | null) ?? null,
    sourceBytes: row.source_bytes == null ? null : Number(row.source_bytes),
    sourceMime: (row.source_mime as string | null) ?? null,
    transcriptionProvider: (row.transcription_provider as string | null) ?? null,
    selectionEngine: (row.selection_engine as string | null) ?? null,
    timingSource: (row.timing_source as 'provider' | 'estimated' | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

function toClip(row: Row): Clip {
  const nullableNumber = (key: string) =>
    row[key] == null ? null : Number(row[key]);
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

const PROJECT_SELECT = `SELECT id, title, source_kind, source_url, source_file_name, source_bytes, source_mime,
  status, stage, progress, status_detail, error, duration_ms, width, height, fps, language,
  transcription_provider, selection_engine, timing_source, created_at, updated_at FROM projects`;

export async function upsertUser(
  profile: Omit<AppUser, 'emailVerified'> & { emailVerified?: boolean },
): Promise<AppUser> {
  const timestamp = now();
  const emailKey = profile.email ? normalizeEmail(profile.email) : null;
  const verified = profile.emailVerified ?? true;
  await d1()
    .prepare(
      `INSERT INTO users (id, email, name, picture, email_key, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
         picture = excluded.picture, email_key = COALESCE(users.email_key, excluded.email_key),
         email_verified = MAX(users.email_verified, excluded.email_verified),
         updated_at = excluded.updated_at`,
    )
    .bind(profile.id, profile.email, profile.name, profile.picture, emailKey, verified ? 1 : 0, timestamp, timestamp)
    .run();
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    emailVerified: verified,
  };
}

export async function getUser(id: string): Promise<AppUser | null> {
  const row = await d1()
    .prepare('SELECT id, email, name, picture, email_verified FROM users WHERE id = ?')
    .bind(id)
    .first<Row>();
  return row ? rowToAppUser(row) : null;
}

export async function findUserByEmail(email: string): Promise<EmailUser | null> {
  const row = await d1()
    .prepare('SELECT * FROM users WHERE email_key = ?')
    .bind(normalizeEmail(email))
    .first<Row>();
  if (!row) return null;
  return { ...rowToAppUser(row), passwordHash: (row.password_hash as string | null) ?? null };
}

export async function createEmailUser(input: {
  email: string;
  name: string | null;
  passwordHash: string;
}): Promise<AppUser | null> {
  const email = input.email.trim();
  const emailKey = normalizeEmail(email);
  const id = randomUUID();
  const timestamp = now();
  const result = await d1()
    .prepare(
      `INSERT INTO users (id, email, name, picture, password_hash, email_key, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)
       ON CONFLICT(email_key) DO NOTHING`,
    )
    .bind(id, email, input.name, input.passwordHash, emailKey, timestamp, timestamp)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) return null;
  return { id, email, name: input.name, picture: null, emailVerified: false };
}

export async function findOrCreateGoogleUser(identity: GoogleIdentity): Promise<AppUser | null> {
  const timestamp = now();
  const bySub = await d1()
    .prepare('SELECT * FROM users WHERE google_sub = ?')
    .bind(identity.sub)
    .first<Row>();
  if (bySub) {
    await d1()
      .prepare(
        'UPDATE users SET email = ?, name = ?, picture = ?, email_verified = 1, updated_at = ? WHERE id = ?',
      )
      .bind(identity.email, identity.name, identity.picture, timestamp, String(bySub.id))
      .run();
    return rowToAppUser({
      ...bySub,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
      email_verified: 1,
    });
  }

  if (!identity.email || !identity.emailVerified) return null;
  const emailKey = normalizeEmail(identity.email);
  const byEmail = await d1()
    .prepare('SELECT * FROM users WHERE email_key = ?')
    .bind(emailKey)
    .first<Row>();
  if (byEmail) {
    const existingGoogleSub = (byEmail.google_sub as string | null) ?? null;
    if (existingGoogleSub && existingGoogleSub !== identity.sub) return null;
    await d1()
      .prepare(
        `UPDATE users SET google_sub = ?, picture = COALESCE(?, picture),
           name = COALESCE(name, ?), email_verified = 1, updated_at = ? WHERE id = ?`,
      )
      .bind(identity.sub, identity.picture, identity.name, timestamp, String(byEmail.id))
      .run();
    const linked = await d1().prepare('SELECT * FROM users WHERE id = ?').bind(String(byEmail.id)).first<Row>();
    return linked ? rowToAppUser(linked) : null;
  }

  const id = randomUUID();
  await d1()
    .prepare(
      `INSERT INTO users (id, email, name, picture, google_sub, email_key, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, identity.email, identity.name, identity.picture, identity.sub, emailKey, timestamp, timestamp)
    .run();
  return {
    id,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
    emailVerified: true,
  };
}

export async function createSessionRow(tokenHash: string, userId: string, expiresAt: string): Promise<void> {
  const timestamp = now();
  await d1().prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(timestamp).run();
  await d1()
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, userId, timestamp, expiresAt, timestamp)
    .run();
}

export async function getSessionUser(tokenHash: string): Promise<AppUser | null> {
  const row = await d1()
    .prepare(
      `SELECT u.id, u.email, u.name, u.picture, u.email_verified FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, now())
    .first<Row>();
  return row ? rowToAppUser(row) : null;
}

export async function deleteSessionRow(tokenHash: string): Promise<void> {
  await d1().prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await d1().prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

export async function createAuthToken(
  tokenHash: string,
  userId: string,
  purpose: AuthTokenPurpose,
  expiresAt: string,
): Promise<void> {
  const timestamp = now();
  await d1().batch([
    d1().prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').bind(timestamp),
    d1().prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').bind(userId, purpose),
    d1()
      .prepare(
        `INSERT INTO auth_tokens (token_hash, user_id, purpose, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(tokenHash, userId, purpose, timestamp, expiresAt),
  ]);
}

export async function consumeAuthToken(
  tokenHash: string,
  purpose: AuthTokenPurpose,
): Promise<{ userId: string } | null> {
  const row = await d1()
    .prepare(
      `UPDATE auth_tokens SET used_at = ?
       WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .bind(now(), tokenHash, purpose, now())
    .first<{ user_id: string }>();
  return row ? { userId: String(row.user_id) } : null;
}

export async function markEmailVerified(userId: string): Promise<void> {
  await d1().batch([
    d1().prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').bind(now(), userId),
    d1().prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'verify_email'").bind(userId),
  ]);
}

export async function setUserPassword(userId: string, passwordHash: string): Promise<void> {
  await d1()
    .prepare('UPDATE users SET password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?')
    .bind(passwordHash, now(), userId)
    .run();
}

export async function createProject(input: NewProjectInput): Promise<Project> {
  const timestamp = now();
  await d1()
    .prepare(
      `INSERT INTO projects (id, owner_id, title, source_kind, source_url, source_path, source_file_name,
         source_bytes, source_mime, status, stage, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    )
    .bind(
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
    )
    .run();
  const project = await getProject(input.id);
  if (!project) throw new Error('Project insert failed');
  return project;
}

export async function getProject(id: string): Promise<Project | null> {
  const row = await d1().prepare(`${PROJECT_SELECT} WHERE id = ?`).bind(id).first<Row>();
  return row ? toProject(row) : null;
}

export async function getProjectForOwner(id: string, ownerId: string): Promise<Project | null> {
  const row = await d1()
    .prepare(`${PROJECT_SELECT} WHERE id = ? AND owner_id = ?`)
    .bind(id, ownerId)
    .first<Row>();
  return row ? toProject(row) : null;
}

export async function assignUnownedProjects(ownerId: string): Promise<number> {
  const result = await d1()
    .prepare('UPDATE projects SET owner_id = ?, updated_at = ? WHERE owner_id IS NULL')
    .bind(ownerId, now())
    .run();
  return Number(result.meta?.changes ?? 0);
}

export async function countUnownedProjects(): Promise<number> {
  const row = await d1()
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id IS NULL')
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function getProjectSourcePath(id: string): Promise<string | null> {
  const row = await d1().prepare('SELECT source_path FROM projects WHERE id = ?').bind(id).first<Row>();
  return row?.source_path ? String(row.source_path) : null;
}

export async function listProjects(ownerId: string, limit = 50): Promise<Project[]> {
  const rows = await d1()
    .prepare(`${PROJECT_SELECT} WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(ownerId, limit)
    .all<Row>();
  return (rows.results ?? []).map(toProject);
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

export async function updateProject(id: string, patch: ProjectPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) => key in PROJECT_PATCH_COLUMNS);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${PROJECT_PATCH_COLUMNS[key as keyof ProjectPatch]} = ?`);
  const values = entries.map(([, value]) => (value === undefined ? null : (value as string | number | null)));
  await d1()
    .prepare(`UPDATE projects SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...values, now(), id)
    .run();
}

export async function deleteProject(id: string): Promise<void> {
  // Delete children explicitly as well as relying on the foreign-key cascade.
  // This keeps account/project records complete even if a deployment has
  // foreign-key enforcement disabled.
  await d1().batch([
    d1().prepare('DELETE FROM transcripts WHERE project_id = ?').bind(id),
    d1().prepare('DELETE FROM clips WHERE project_id = ?').bind(id),
    d1().prepare('DELETE FROM jobs WHERE project_id = ?').bind(id),
    d1().prepare('DELETE FROM storage_reservations WHERE project_id = ?').bind(id),
    d1().prepare('DELETE FROM storage_objects WHERE project_id = ?').bind(id),
    d1().prepare('DELETE FROM projects WHERE id = ?').bind(id),
  ]);
}

export async function saveTranscript(projectId: string, transcript: Transcript): Promise<void> {
  await d1()
    .prepare(
      `INSERT INTO transcripts (project_id, provider, language, timing, text, words_json, segments_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET provider = excluded.provider, language = excluded.language,
         timing = excluded.timing, text = excluded.text, words_json = excluded.words_json,
         segments_json = excluded.segments_json, created_at = excluded.created_at`,
    )
    .bind(
      projectId,
      transcript.provider,
      transcript.language,
      transcript.timing,
      transcript.text,
      JSON.stringify(transcript.words),
      JSON.stringify(transcript.segments),
      now(),
    )
    .run();
}

export async function getTranscript(projectId: string): Promise<Transcript | null> {
  const row = await d1()
    .prepare(
      'SELECT provider, language, timing, text, words_json, segments_json FROM transcripts WHERE project_id = ?',
    )
    .bind(projectId)
    .first<Row>();
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

export async function replaceClips(
  projectId: string,
  clips: (SelectedClip & { id: string })[],
): Promise<Clip[]> {
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    d1().prepare('DELETE FROM clips WHERE project_id = ?').bind(projectId),
  ];
  for (const [index, clip] of clips.entries()) {
    statements.push(
      d1()
        .prepare(
          `INSERT INTO clips (id, project_id, idx, title, reason, hook, start_ms, end_ms, score, status,
             score_breakdown_json, evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .bind(
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
        ),
    );
  }
  await d1().batch(statements);
  return getClips(projectId);
}

export async function getClips(projectId: string): Promise<Clip[]> {
  const rows = await d1()
    .prepare(
      `SELECT id, project_id, idx, title, reason, hook, start_ms, end_ms, score, status, error,
              file_path, poster_path, bytes, width, height, duration_ms, caption_mode, crop_strategy,
              score_breakdown_json, evidence_json, edits_json, effects_json
       FROM clips WHERE project_id = ? ORDER BY idx ASC`,
    )
    .bind(projectId)
    .all<Row>();
  return (rows.results ?? []).map(toClip);
}

export async function getClipForOwner(
  id: string,
  ownerId: string,
): Promise<(Clip & { filePath: string | null; posterPath: string | null }) | null> {
  const row = await d1()
    .prepare(
      `SELECT c.id, c.project_id, c.idx, c.title, c.reason, c.hook, c.start_ms, c.end_ms, c.score, c.status,
              c.error, c.file_path, c.poster_path, c.bytes, c.width, c.height, c.duration_ms, c.caption_mode,
              c.crop_strategy, c.score_breakdown_json, c.evidence_json, c.edits_json, c.effects_json
       FROM clips c JOIN projects p ON p.id = c.project_id
       WHERE c.id = ? AND p.owner_id = ?`,
    )
    .bind(id, ownerId)
    .first<Row>();
  return row
    ? {
        ...toClip(row),
        filePath: (row.file_path as string | null) ?? null,
        posterPath: (row.poster_path as string | null) ?? null,
      }
    : null;
}

export async function getClip(
  id: string,
): Promise<(Clip & { filePath: string | null; posterPath: string | null }) | null> {
  const row = await d1()
    .prepare(
      `SELECT id, project_id, idx, title, reason, hook, start_ms, end_ms, score, status, error,
              file_path, poster_path, bytes, width, height, duration_ms, caption_mode, crop_strategy,
              score_breakdown_json, evidence_json, edits_json, effects_json
       FROM clips WHERE id = ?`,
    )
    .bind(id)
    .first<Row>();
  return row
    ? {
        ...toClip(row),
        filePath: (row.file_path as string | null) ?? null,
        posterPath: (row.poster_path as string | null) ?? null,
      }
    : null;
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

export async function updateClip(id: string, patch: ClipPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) => key in CLIP_PATCH_COLUMNS);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${CLIP_PATCH_COLUMNS[key as keyof ClipPatch]} = ?`);
  const values = entries.map(([, value]) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') return JSON.stringify(value as ClipEdits | ClipEffects);
    return value as string | number;
  });
  await d1()
    .prepare(`UPDATE clips SET ${assignments.join(', ')} WHERE id = ?`)
    .bind(...values, id)
    .run();
}

function toStorageObject(row: Row): StorageObjectRecord {
  const nullableNumber = (key: string) =>
    row[key] == null ? null : Number(row[key]);
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

export async function getStorageObject(id: string): Promise<StorageObjectRecord | null> {
  const row = await d1().prepare('SELECT * FROM storage_objects WHERE id = ?').bind(id).first<Row>();
  return row ? toStorageObject(row) : null;
}

export async function getStorageObjectByIdempotencyKey(key: string): Promise<StorageObjectRecord | null> {
  const row = await d1()
    .prepare('SELECT * FROM storage_objects WHERE idempotency_key = ?')
    .bind(key)
    .first<Row>();
  return row ? toStorageObject(row) : null;
}

export async function getStorageObjectByUploadId(
  projectId: string,
  uploadId: string,
): Promise<StorageObjectRecord | null> {
  const row = await d1()
    .prepare(
      'SELECT * FROM storage_objects WHERE project_id = ? AND upload_id = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .bind(projectId, uploadId)
    .first<Row>();
  return row ? toStorageObject(row) : null;
}

export async function getStorageObjectsForProject(projectId: string): Promise<StorageObjectRecord[]> {
  const rows = await d1()
    .prepare('SELECT * FROM storage_objects WHERE project_id = ? ORDER BY created_at ASC')
    .bind(projectId)
    .all<Row>();
  return (rows.results ?? []).map(toStorageObject);
}

export async function getStorageObjectsForClip(clipId: string): Promise<StorageObjectRecord[]> {
  const rows = await d1()
    .prepare('SELECT * FROM storage_objects WHERE clip_id = ? ORDER BY updated_at DESC')
    .bind(clipId)
    .all<Row>();
  return (rows.results ?? []).map(toStorageObject);
}

export async function getLatestStorageObjectForClip(
  clipId: string,
  kind: StorageObjectKind,
  status: StorageObjectStatus = 'complete',
): Promise<StorageObjectRecord | null> {
  const row = await d1()
    .prepare(
      'SELECT * FROM storage_objects WHERE clip_id = ? AND kind = ? AND status = ? ORDER BY updated_at DESC LIMIT 1',
    )
    .bind(clipId, kind, status)
    .first<Row>();
  return row ? toStorageObject(row) : null;
}

export async function upsertStorageObject(input: NewStorageObjectInput): Promise<StorageObjectRecord> {
  const timestamp = now();
  const existing = await getStorageObjectByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    await d1()
      .prepare(
        `UPDATE storage_objects SET provider_id = ?, bucket = ?, key = ?, bytes = ?, content_type = ?,
           status = ?, attempts = ?, last_error = ?, upload_id = ?, part_size = ?, expected_bytes = ?,
           total_parts = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
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
      )
      .run();
    return (await getStorageObject(existing.id)) as StorageObjectRecord;
  }

  await d1()
    .prepare(
      `INSERT INTO storage_objects (id, idempotency_key, owner_id, project_id, clip_id, kind, provider_id,
         bucket, key, bytes, content_type, status, attempts, last_error, upload_id, part_size, expected_bytes,
         total_parts, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
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
    )
    .run();
  return (await getStorageObject(input.id)) as StorageObjectRecord;
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

export async function updateStorageObject(id: string, patch: StorageObjectPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([key]) => key in STORAGE_OBJECT_PATCH_COLUMNS);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${STORAGE_OBJECT_PATCH_COLUMNS[key as keyof StorageObjectPatch]} = ?`);
  const values = entries.map(([, value]) => (value === undefined ? null : value));
  await d1()
    .prepare(`UPDATE storage_objects SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...values, now(), id)
    .run();
}

export async function deleteStorageObject(id: string): Promise<void> {
  await d1().batch([
    d1().prepare('DELETE FROM storage_reservations WHERE storage_object_id = ?').bind(id),
    d1().prepare('DELETE FROM storage_objects WHERE id = ?').bind(id),
  ]);
}

export async function deleteStorageObjectsForProject(projectId: string): Promise<void> {
  await d1().batch([
    d1().prepare('DELETE FROM storage_reservations WHERE project_id = ?').bind(projectId),
    d1().prepare('DELETE FROM storage_objects WHERE project_id = ?').bind(projectId),
  ]);
}

export async function sumStorageObjectsByProvider(providerId: string): Promise<StorageBytesByProvider> {
  const row = await d1()
    .prepare(
      `SELECT provider_id, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n
       FROM storage_objects WHERE provider_id = ? AND status IN ('pending', 'uploading', 'complete')
       GROUP BY provider_id`,
    )
    .bind(providerId)
    .first<Row>();
  return { providerId, bytes: Number(row?.bytes ?? 0), objectCount: Number(row?.n ?? 0) };
}

export async function sumPendingStorageObjectsByProvider(providerId: string): Promise<StorageBytesByProvider> {
  const row = await d1()
    .prepare(
      `SELECT provider_id, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n
       FROM storage_objects WHERE provider_id = ? AND status IN ('pending', 'uploading')
       GROUP BY provider_id`,
    )
    .bind(providerId)
    .first<Row>();
  return { providerId, bytes: Number(row?.bytes ?? 0), objectCount: Number(row?.n ?? 0) };
}

export async function sumStorageObjectsByProject(projectIds: string[]): Promise<StorageBytesByProject[]> {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => '?').join(', ');
  const rows = await d1()
    .prepare(
      `SELECT project_id, kind, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n
       FROM storage_objects WHERE project_id IN (${placeholders}) AND status = 'complete'
       GROUP BY project_id, kind`,
    )
    .bind(...projectIds)
    .all<Row>();
  return (rows.results ?? []).map((row) => ({
    projectId: String(row.project_id),
    kind: String(row.kind) as StorageObjectKind,
    bytes: Number(row.bytes ?? 0),
    objectCount: Number(row.n ?? 0),
  }));
}

export async function getLatestStorageObjectByProject(
  projectId: string,
  kind: StorageObjectKind,
): Promise<StorageObjectRecord | null> {
  const row = await d1()
    .prepare(
      `SELECT * FROM storage_objects WHERE project_id = ? AND kind = ? AND status = 'complete'
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(projectId, kind)
    .first<Row>();
  return row ? toStorageObject(row) : null;
}

export async function storageFailureCounts(projectIds: string[]): Promise<{
  failedUploads: number;
  failedDeletions: number;
}> {
  if (projectIds.length === 0) return { failedUploads: 0, failedDeletions: 0 };
  const placeholders = projectIds.map(() => '?').join(', ');
  const row = await d1()
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_uploads,
         SUM(CASE WHEN status = 'delete_failed' THEN 1 ELSE 0 END) AS failed_deletions
       FROM storage_objects WHERE project_id IN (${placeholders})`,
    )
    .bind(...projectIds)
    .first<Row>();
  return {
    failedUploads: Number(row?.failed_uploads ?? 0),
    failedDeletions: Number(row?.failed_deletions ?? 0),
  };
}

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

export async function getStorageReservation(id: string): Promise<StorageReservationRecord | null> {
  const row = await d1().prepare('SELECT * FROM storage_reservations WHERE id = ?').bind(id).first<Row>();
  return row ? toStorageReservation(row) : null;
}

export async function getActiveStorageReservationForObject(
  objectId: string,
): Promise<StorageReservationRecord | null> {
  const row = await d1()
    .prepare("SELECT * FROM storage_reservations WHERE storage_object_id = ? AND status = 'active' LIMIT 1")
    .bind(objectId)
    .first<Row>();
  return row ? toStorageReservation(row) : null;
}

export async function tryReserveStorageCapacity(
  input: NewStorageReservationInput,
): Promise<StorageReservationRecord | null> {
  const timestamp = now();
  try {
    const result = await d1()
      .prepare(RESERVE_STORAGE_CAPACITY_SQL)
      .bind(
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
      )
      .run();
    if (Number(result.meta?.changes ?? 0) > 0) return getStorageReservation(input.id);
  } catch (error) {
    const active = await getActiveStorageReservationForObject(input.storageObjectId);
    if (active) return active;
    throw error;
  }
  return getActiveStorageReservationForObject(input.storageObjectId);
}

export async function releaseStorageReservation(id: string): Promise<void> {
  await d1()
    .prepare("UPDATE storage_reservations SET status = 'released', updated_at = ? WHERE id = ? AND status = 'active'")
    .bind(now(), id)
    .run();
}

export async function releaseActiveReservationsForObject(objectId: string): Promise<void> {
  await d1()
    .prepare(
      "UPDATE storage_reservations SET status = 'released', updated_at = ? WHERE storage_object_id = ? AND status = 'active'",
    )
    .bind(now(), objectId)
    .run();
}

export async function getExpiredStorageReservations(
  expiredBefore: string,
  limit = 25,
): Promise<StorageReservationRecord[]> {
  const rows = await d1()
    .prepare(
      "SELECT * FROM storage_reservations WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?",
    )
    .bind(expiredBefore, limit)
    .all<Row>();
  return (rows.results ?? []).map(toStorageReservation);
}

export async function sumActiveStorageReservationsByProvider(
  providerId: string,
): Promise<StorageReservationSummary> {
  const row = await d1()
    .prepare(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM storage_reservations WHERE provider_id = ? AND status = 'active'",
    )
    .bind(providerId)
    .first<Row>();
  return { bytes: Number(row?.bytes ?? 0), count: Number(row?.n ?? 0) };
}

export async function sumActiveStorageReservations(): Promise<StorageReservationSummary> {
  const row = await d1()
    .prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM storage_reservations WHERE status = 'active'")
    .first<Row>();
  return { bytes: Number(row?.bytes ?? 0), count: Number(row?.n ?? 0) };
}

export async function setStorageProviderState(input: {
  providerId: string;
  listedBytes: number;
  externalBytes: number;
  verified: boolean;
  measuredAt: string | null;
  lastError: string | null;
}): Promise<void> {
  await d1()
    .prepare(
      `INSERT INTO storage_provider_state
         (provider_id, listed_bytes, external_bytes, verified, measured_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET listed_bytes = excluded.listed_bytes,
         external_bytes = excluded.external_bytes, verified = excluded.verified,
         measured_at = excluded.measured_at, last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.providerId,
      Math.max(0, Math.round(input.listedBytes)),
      Math.max(0, Math.round(input.externalBytes)),
      input.verified ? 1 : 0,
      input.measuredAt,
      input.lastError,
      now(),
    )
    .run();
}

export async function getStorageProviderState(providerId: string): Promise<StorageProviderStateRecord | null> {
  const row = await d1()
    .prepare('SELECT * FROM storage_provider_state WHERE provider_id = ?')
    .bind(providerId)
    .first<Row>();
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

export async function enqueueJob(projectId: string, jobId: string): Promise<Job> {
  await d1()
    .prepare(`INSERT INTO jobs (id, project_id, status, attempts, created_at) VALUES (?, ?, 'queued', 0, ?)`)
    .bind(jobId, projectId, now())
    .run();
  await updateProject(projectId, {
    status: 'queued',
    stage: 'queued',
    progress: 0,
    error: null,
    statusDetail: null,
  });
  const row = await d1().prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<Row>();
  if (!row) throw new Error('Job insert failed');
  return toJob(row);
}

export async function getLatestJob(projectId: string): Promise<Job | null> {
  const row = await d1()
    .prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(projectId)
    .first<Row>();
  return row ? toJob(row) : null;
}

export async function hasActiveJob(projectId: string): Promise<boolean> {
  const row = await d1()
    .prepare("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1")
    .bind(projectId)
    .first<Row>();
  return Boolean(row);
}

export async function claimNextJob(workerId: string, staleAfterMs = 120_000): Promise<Job | null> {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const candidate = await d1()
    .prepare(
      `SELECT id FROM jobs
       WHERE status = 'queued' OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?))
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(cutoff)
    .first<{ id: string }>();
  if (!candidate) return null;
  const row = await d1()
    .prepare(
      `UPDATE jobs SET status = 'running', worker_id = ?, started_at = ?, heartbeat_at = ?,
         attempts = attempts + 1
       WHERE id = ? AND (status = 'queued' OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)))
       RETURNING *`,
    )
    .bind(workerId, now(), now(), candidate.id, cutoff)
    .first<Row>();
  return row ? toJob(row) : null;
}

export async function heartbeatJob(jobId: string): Promise<void> {
  await d1()
    .prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'")
    .bind(now(), jobId)
    .run();
}

export async function finishJob(jobId: string): Promise<void> {
  await d1()
    .prepare("UPDATE jobs SET status = 'done', finished_at = ?, last_error = NULL WHERE id = ?")
    .bind(now(), jobId)
    .run();
}

export async function failJob(jobId: string, message: string, logTail: string | null): Promise<void> {
  await d1()
    .prepare("UPDATE jobs SET status = 'failed', finished_at = ?, last_error = ?, log_tail = ? WHERE id = ?")
    .bind(now(), message.slice(0, 2000), logTail ? logTail.slice(-4000) : null, jobId)
    .run();
}

export async function requeueJob(jobId: string): Promise<void> {
  await d1()
    .prepare("UPDATE jobs SET status = 'queued', heartbeat_at = NULL, worker_id = NULL WHERE id = ?")
    .bind(jobId)
    .run();
}

export async function recordWorkerHeartbeat(workerId: string, version: string): Promise<void> {
  const timestamp = now();
  await d1()
    .prepare(
      `INSERT INTO workers (id, version, pid, started_at, heartbeat_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, version = excluded.version`,
    )
    .bind(workerId, version, timestamp, timestamp)
    .run();
}

export async function workerIsOnline(maxAgeMs = 30_000): Promise<boolean> {
  const row = await d1()
    .prepare('SELECT heartbeat_at FROM workers ORDER BY heartbeat_at DESC LIMIT 1')
    .first<{ heartbeat_at: string | null }>();
  if (!row?.heartbeat_at) return false;
  return Date.now() - new Date(row.heartbeat_at).getTime() < maxAgeMs;
}

export async function resetProjectForRun(projectId: string): Promise<void> {
  await d1().prepare('DELETE FROM clips WHERE project_id = ?').bind(projectId).run();
  await updateProject(projectId, {
    status: 'queued',
    stage: 'queued',
    progress: 0,
    error: null,
    statusDetail: 'Waiting for a processing worker',
  });
}
