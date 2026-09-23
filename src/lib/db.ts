import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { assertProdSecretsReady, getEncryptionKey } from "./env";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "helios.db");

const globalForDb = global as unknown as { _heliosDb: Database.Database | undefined };

let _envChecked = false;

function openDb(): Database.Database {
  if (!_envChecked) {
    // In production, throw immediately if JWT_SECRET or ENCRYPTION_KEY are
    // missing / match the dev fallback. This turns a silent security
    // downgrade into a loud boot failure that CI/deploy logs will catch.
    assertProdSecretsReady();
    if (process.env.NODE_ENV === "production") {
      if (!process.env.ANTHROPIC_API_KEY) {
        console.error("[Helios] ANTHROPIC_API_KEY not set — AI features will return 503");
      }
    }
    _envChecked = true;
  }

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      llm_api_key_enc TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      data        TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
  `);

  // Idempotent migration: add github_id if the column doesn't exist yet
  try {
    db.exec("ALTER TABLE users ADD COLUMN github_id TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL");
  } catch {
    // Column already exists — no-op
  }

  // Idempotent migration: bitbucket_id (mirror of github_id). Helios has
  // moved to SSO-only auth, so users may sign in with either provider.
  try {
    db.exec("ALTER TABLE users ADD COLUMN bitbucket_id TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bitbucket_id ON users(bitbucket_id) WHERE bitbucket_id IS NOT NULL");
  } catch {
    // Column already exists — no-op
  }

  // Idempotent migration: deploy provider credentials (AES-256-GCM encrypted JSON blob)
  try {
    db.exec("ALTER TABLE users ADD COLUMN deploy_creds_enc TEXT");
  } catch {
    // Column already exists — no-op
  }

  // Idempotent migration: sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      jti        TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  // Helios is SSO-only — no password reset table is created. Existing dbs may
  // still have a `password_reset_tokens` row from before the migration; it's
  // harmless and unused.

  // Idempotent migration: teams
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS team_invites (
      token        TEXT PRIMARY KEY,
      team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      email        TEXT,
      invited_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   INTEGER NOT NULL,
      accepted_at  INTEGER,
      accepted_by  TEXT REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_team_invites_team ON team_invites(team_id);
  `);

  // Idempotent migration: public stack gallery
  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_stacks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      language    TEXT NOT NULL,
      framework   TEXT NOT NULL,
      use_case    TEXT,
      author      TEXT,
      stack_url   TEXT NOT NULL,
      stars       INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_language ON gallery_stacks(language);
    CREATE INDEX IF NOT EXISTS idx_gallery_stars ON gallery_stacks(stars DESC);
  `);

  // Idempotent migration: gallery owner + rate_limits
  try { db.exec("ALTER TABLE gallery_stacks ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL"); } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_reports (
      id          TEXT PRIMARY KEY,
      stack_id    TEXT REFERENCES gallery_stacks(id) ON DELETE CASCADE,
      reporter_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      reason      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_reports_stack ON gallery_reports(stack_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key      TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 1,
      reset_at INTEGER NOT NULL
    );
  `);

  // Project sharing — explicit row per (project, principal). Principal is
  // either a single user or a whole team; the CHECK enforces exactly one.
  // Permission is the access level granted; ownership is still derived from
  // projects.user_id (no row in this table for the owner).
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_shares (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      team_id    TEXT REFERENCES teams(id) ON DELETE CASCADE,
      user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK (permission IN ('view','edit')),
      granted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK ((team_id IS NULL) <> (user_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_project_shares_project ON project_shares(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_shares_team    ON project_shares(team_id);
    CREATE INDEX IF NOT EXISTS idx_project_shares_user    ON project_shares(user_id);
  `);

  return db;
}

function getDb(): Database.Database {
  if (!globalForDb._heliosDb) {
    globalForDb._heliosDb = openDb();
  }
  return globalForDb._heliosDb;
}

// ─── User helpers ───────────────────────────────────────────────────────────

export type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  llm_api_key_enc: string | null;
  github_id: string | null;
  bitbucket_id: string | null;
  created_at: number;
};

export function createUser(
  id: string,
  email: string,
  name: string,
  passwordHash: string
): void {
  getDb()
    .prepare(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)"
    )
    .run(id, email, name, passwordHash);
}

export function findUserByEmail(email: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email) as UserRow | undefined;
}

export function findUserByGithubId(githubId: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE github_id = ?")
    .get(githubId) as UserRow | undefined;
}

export function upsertUserByGithub(
  githubId: string,
  email: string,
  name: string
): UserRow {
  const db = getDb();
  // Link to existing email account if present
  const existing =
    (db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as UserRow | undefined) ??
    (email ? (db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | undefined) : undefined);

  if (existing) {
    if (!existing.github_id) {
      db.prepare("UPDATE users SET github_id = ? WHERE id = ?").run(githubId, existing.id);
    }
    return { ...existing, github_id: githubId };
  }

  const id = crypto.randomUUID();
  // No real password — GitHub-only account
  const passwordHash = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, github_id) VALUES (?, ?, ?, ?, ?)"
  ).run(id, email.toLowerCase(), name, passwordHash, githubId);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

// Mirrors upsertUserByGithub: link an existing email-matched account to a
// Bitbucket account, or create a fresh row when neither bitbucket_id nor a
// matching email is on file. Helios is SSO-only so the password_hash column
// is left as a random throwaway (kept NOT NULL for backward compatibility
// with the original schema; nothing reads it).
export function upsertUserByBitbucket(
  bitbucketId: string,
  email: string,
  name: string
): UserRow {
  const db = getDb();
  const existing =
    (db.prepare("SELECT * FROM users WHERE bitbucket_id = ?").get(bitbucketId) as UserRow | undefined) ??
    (email ? (db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | undefined) : undefined);

  if (existing) {
    if (!existing.bitbucket_id) {
      db.prepare("UPDATE users SET bitbucket_id = ? WHERE id = ?").run(bitbucketId, existing.id);
    }
    return { ...existing, bitbucket_id: bitbucketId };
  }

  const id = crypto.randomUUID();
  const passwordHash = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, bitbucket_id) VALUES (?, ?, ?, ?, ?)"
  ).run(id, email.toLowerCase(), name, passwordHash, bitbucketId);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

export function findUserById(id: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
}

export function updateUserProfile(
  id: string,
  updates: { name?: string; email?: string }
): void {
  const db = getDb();
  if (updates.name !== undefined)
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(updates.name, id);
  if (updates.email !== undefined)
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(updates.email, id);
}

export function updateUserApiKey(
  userId: string,
  encrypted: string | null
): void {
  getDb()
    .prepare("UPDATE users SET llm_api_key_enc = ? WHERE id = ?")
    .run(encrypted, userId);
}

// ─── Project helpers ─────────────────────────────────────────────────────────

export type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  data: string;
  created_at: number;
  updated_at: number;
};

export function createProject(
  id: string,
  userId: string,
  name: string,
  data: string
): void {
  getDb()
    .prepare(
      "INSERT INTO projects (id, user_id, name, data) VALUES (?, ?, ?, ?)"
    )
    .run(id, userId, name, data);
}

export function listUserProjects(userId: string): ProjectRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC"
    )
    .all(userId) as ProjectRow[];
}

export function getProjectById(
  id: string,
  userId: string
): ProjectRow | undefined {
  return getDb()
    .prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?")
    .get(id, userId) as ProjectRow | undefined;
}

// Returns a project regardless of ownership. Callers MUST have already
// verified access via getProjectAccess() before calling this — never expose
// it on a route without a permission check.
export function getProjectByIdRaw(id: string): ProjectRow | undefined {
  return getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
}

// Update without an ownership filter — used by routes after the caller has
// already verified the user has at least edit access via getProjectAccess.
export function updateProjectRaw(
  id: string,
  name: string,
  data: string
): void {
  getDb()
    .prepare(
      "UPDATE projects SET name = ?, data = ?, updated_at = unixepoch() WHERE id = ?"
    )
    .run(name, data, id);
}

export function updateProject(
  id: string,
  userId: string,
  name: string,
  data: string
): void {
  getDb()
    .prepare(
      "UPDATE projects SET name = ?, data = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?"
    )
    .run(name, data, id, userId);
}

export function deleteProjectById(id: string, userId: string): void {
  getDb()
    .prepare("DELETE FROM projects WHERE id = ? AND user_id = ?")
    .run(id, userId);
}

// ─── Deploy credentials helpers ──────────────────────────────────────────────

export type DeployCredsMap = Record<string, Record<string, string>>;

export function getDeployCreds(userId: string): DeployCredsMap {
  const row = getDb()
    .prepare("SELECT deploy_creds_enc FROM users WHERE id = ?")
    .get(userId) as { deploy_creds_enc: string | null } | undefined;
  if (!row?.deploy_creds_enc) return {};
  try {
    return JSON.parse(decryptApiKey(row.deploy_creds_enc)) as DeployCredsMap;
  } catch {
    return {};
  }
}

export function setDeployCreds(userId: string, creds: DeployCredsMap): void {
  const enc = encryptApiKey(JSON.stringify(creds));
  getDb()
    .prepare("UPDATE users SET deploy_creds_enc = ? WHERE id = ?")
    .run(enc, userId);
}

// ─── Encryption helpers ──────────────────────────────────────────────────────

function encKey(): Buffer {
  return crypto.createHash("sha256").update(getEncryptionKey()).digest();
}

export function encryptApiKey(key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("hex"),
    tag.toString("hex"),
    enc.toString("hex"),
  ].join(":");
}

export function decryptApiKey(enc: string): string {
  const [ivHex, tagHex, encHex] = enc.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return (
    decipher.update(Buffer.from(encHex, "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}

// ─── Session helpers ──────────────────────────────────────────────────────────

export function createSession(jti: string, userId: string, expiresAt: number): void {
  getDb().prepare("INSERT OR IGNORE INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)").run(jti, userId, expiresAt);
}

export function sessionExists(jti: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM sessions WHERE jti = ? AND expires_at > unixepoch()").get(jti);
  return !!row;
}

export function deleteSession(jti: string): void {
  getDb().prepare("DELETE FROM sessions WHERE jti = ?").run(jti);
}

export function deleteUserSessions(userId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function pruneExpiredSessions(): void {
  getDb().prepare("DELETE FROM sessions WHERE expires_at <= unixepoch()").run();
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

export function countAllProjects(): number {
  const row = getDb().prepare("SELECT COUNT(*) as n FROM projects").get() as { n: number };
  return row.n;
}

// ─── Team helpers ─────────────────────────────────────────────────────────────

export type TeamRow = { id: string; name: string; owner_id: string; created_at: number };
export type TeamMemberRow = { team_id: string; user_id: string; role: string; joined_at: number; name?: string; email?: string };
export type TeamInviteRow = { token: string; team_id: string; email: string | null; invited_by: string; expires_at: number; accepted_at: number | null; accepted_by: string | null };

export function createTeam(id: string, name: string, ownerId: string): void {
  const db = getDb();
  db.prepare("INSERT INTO teams (id, name, owner_id) VALUES (?, ?, ?)").run(id, name, ownerId);
  db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')").run(id, ownerId);
}

export function getTeam(teamId: string): TeamRow | undefined {
  return getDb().prepare("SELECT * FROM teams WHERE id = ?").get(teamId) as TeamRow | undefined;
}

export function listUserTeams(userId: string): (TeamRow & { role: string; memberCount: number })[] {
  return getDb().prepare(`
    SELECT t.*, tm.role,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS memberCount
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
    ORDER BY t.created_at DESC
  `).all(userId) as (TeamRow & { role: string; memberCount: number })[];
}

export function listTeamMembers(teamId: string): TeamMemberRow[] {
  return getDb().prepare(`
    SELECT tm.*, u.name, u.email
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY tm.role DESC, tm.joined_at ASC
  `).all(teamId) as TeamMemberRow[];
}

export function getTeamMember(teamId: string, userId: string): TeamMemberRow | undefined {
  return getDb().prepare("SELECT * FROM team_members WHERE team_id = ? AND user_id = ?").get(teamId, userId) as TeamMemberRow | undefined;
}

export function addTeamMember(teamId: string, userId: string, role: string): void {
  getDb().prepare("INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)").run(teamId, userId, role);
}

export function removeTeamMember(teamId: string, userId: string): void {
  getDb().prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND role != 'owner'").run(teamId, userId);
}

export function deleteTeam(teamId: string, ownerId: string): void {
  getDb().prepare("DELETE FROM teams WHERE id = ? AND owner_id = ?").run(teamId, ownerId);
}

export function createTeamInvite(token: string, teamId: string, email: string | null, invitedBy: string, expiresAt: number): void {
  getDb().prepare("INSERT INTO team_invites (token, team_id, email, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)").run(token, teamId, email, invitedBy, expiresAt);
}

export function getTeamInvite(token: string): TeamInviteRow | undefined {
  return getDb().prepare("SELECT * FROM team_invites WHERE token = ?").get(token) as TeamInviteRow | undefined;
}

export function acceptTeamInvite(token: string, userId: string): void {
  getDb().prepare("UPDATE team_invites SET accepted_at = unixepoch(), accepted_by = ? WHERE token = ?").run(userId, token);
}

export function listTeamInvites(teamId: string): TeamInviteRow[] {
  return getDb().prepare("SELECT * FROM team_invites WHERE team_id = ? ORDER BY expires_at DESC").all(teamId) as TeamInviteRow[];
}

// ─── Gallery helpers ──────────────────────────────────────────────────────────

export type GalleryRow = {
  id: string;
  title: string;
  description: string | null;
  language: string;
  framework: string;
  use_case: string | null;
  author: string | null;
  owner_id: string | null;
  stack_url: string;
  stars: number;
  created_at: number;
};

export function createGalleryStack(row: Omit<GalleryRow, "stars" | "created_at">): void {
  getDb()
    .prepare(
      `INSERT INTO gallery_stacks (id, title, description, language, framework, use_case, author, stack_url, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.title, row.description ?? null, row.language, row.framework, row.use_case ?? null, row.author ?? null, row.stack_url, row.owner_id ?? null);
}

export function listGalleryStacks(opts: { language?: string; q?: string; limit?: number; offset?: number } = {}): GalleryRow[] {
  const { language, q, limit = 24, offset = 0 } = opts;
  let sql = "SELECT * FROM gallery_stacks WHERE 1=1";
  const params: (string | number)[] = [];
  if (language) {
    sql += " AND language = ?";
    params.push(language);
  }
  if (q) {
    sql += " AND (title LIKE ? OR description LIKE ? OR framework LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += " ORDER BY stars DESC, created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return getDb().prepare(sql).all(...params) as GalleryRow[];
}

export function starGalleryStack(id: string): void {
  getDb()
    .prepare("UPDATE gallery_stacks SET stars = stars + 1 WHERE id = ?")
    .run(id);
}

export function deleteGalleryStack(id: string, ownerId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM gallery_stacks WHERE id = ? AND owner_id = ?")
    .run(id, ownerId);
  return result.changes > 0;
}

export function reportGalleryStack(id: string, stackId: string, reporterId: string, reason?: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO gallery_reports (id, stack_id, reporter_id, reason) VALUES (?, ?, ?, ?)")
    .run(id, stackId, reporterId, reason ?? null);
}

// ─── Account deletion ─────────────────────────────────────────────────────────

export function deleteUser(userId: string): void {
  // ON DELETE CASCADE removes sessions, projects, team ownerships, and team memberships
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
}

// ─── Team project helpers ─────────────────────────────────────────────────────

export type TeamProjectRow = ProjectRow & { user_name: string };

export function listProjectsForTeamMembers(teamId: string): TeamProjectRow[] {
  return getDb().prepare(`
    SELECT p.*, u.name AS user_name
    FROM projects p
    JOIN users u ON u.id = p.user_id
    JOIN team_members tm ON tm.user_id = p.user_id
    WHERE tm.team_id = ?
    ORDER BY p.updated_at DESC
    LIMIT 50
  `).all(teamId) as TeamProjectRow[];
}

// ─── Project share helpers ───────────────────────────────────────────────────

export type ProjectShareRow = {
  id: string;
  project_id: string;
  team_id: string | null;
  user_id: string | null;
  permission: "view" | "edit";
  granted_by: string;
  created_at: number;
};

export type SharedProjectRow = ProjectRow & {
  permission: "view" | "edit";
  shared_via: "user" | "team";
  shared_team_id: string | null;
  owner_name: string;
};

export function createProjectShare(
  id: string,
  projectId: string,
  principal: { type: "user"; userId: string } | { type: "team"; teamId: string },
  permission: "view" | "edit",
  grantedBy: string
): void {
  getDb()
    .prepare(
      `INSERT INTO project_shares
         (id, project_id, team_id, user_id, permission, granted_by)
         VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      projectId,
      principal.type === "team" ? principal.teamId : null,
      principal.type === "user" ? principal.userId : null,
      permission,
      grantedBy
    );
}

export function deleteProjectShare(id: string, projectId: string): void {
  // project_id is included in the WHERE so a hostile share id from another
  // project can't be deleted by passing the wrong project context.
  getDb()
    .prepare("DELETE FROM project_shares WHERE id = ? AND project_id = ?")
    .run(id, projectId);
}

export function listProjectShares(projectId: string): ProjectShareRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM project_shares WHERE project_id = ? ORDER BY created_at DESC"
    )
    .all(projectId) as ProjectShareRow[];
}

/**
 * Returns the highest permission level the user has on a project. The order
 * is owner > edit > view. Used by routes and the permissions helper to
 * decide what to allow.
 */
export function getProjectAccessRow(
  projectId: string,
  userId: string
): { level: "owner" | "edit" | "view" } | null {
  const db = getDb();

  // Owner check is cheapest — projects.user_id is indexed.
  const owner = db
    .prepare("SELECT 1 FROM projects WHERE id = ? AND user_id = ?")
    .get(projectId, userId) as { 1: number } | undefined;
  if (owner) return { level: "owner" };

  // Direct user share OR membership in any shared team. The MAX(...) trick
  // collapses both rows into the highest permission.
  const row = db
    .prepare(
      `SELECT
         MAX(CASE WHEN permission = 'edit' THEN 2 ELSE 1 END) AS rank
       FROM project_shares ps
       LEFT JOIN team_members tm
         ON tm.team_id = ps.team_id AND tm.user_id = ?
       WHERE ps.project_id = ?
         AND (ps.user_id = ? OR tm.user_id IS NOT NULL)`
    )
    .get(userId, projectId, userId) as { rank: number | null } | undefined;

  if (!row || row.rank === null) return null;
  return { level: row.rank === 2 ? "edit" : "view" };
}

/**
 * Lists projects shared with a user (directly or via team membership), with
 * the effective permission and owner name attached. Used by the
 * `/api/shared-with-me` endpoint.
 */
export function listSharedWithUser(userId: string): SharedProjectRow[] {
  // We deliberately UNION direct shares and team shares rather than join in
  // both directions — the rank arithmetic stays simple and the query plan is
  // legible when we add new principal types later.
  const rows = getDb()
    .prepare(
      `SELECT
         p.*,
         MAX(CASE WHEN ps.permission = 'edit' THEN 2 ELSE 1 END) AS rank,
         u.name AS owner_name,
         CASE WHEN ps.user_id IS NOT NULL THEN 'user' ELSE 'team' END AS shared_via,
         ps.team_id AS shared_team_id
       FROM project_shares ps
       JOIN projects p ON p.id = ps.project_id
       JOIN users u    ON u.id = p.user_id
       LEFT JOIN team_members tm
         ON tm.team_id = ps.team_id AND tm.user_id = ?
       WHERE (ps.user_id = ? OR tm.user_id IS NOT NULL)
         AND p.user_id <> ?
       GROUP BY p.id
       ORDER BY p.updated_at DESC
       LIMIT 100`
    )
    .all(userId, userId, userId) as Array<
    ProjectRow & {
      rank: number;
      owner_name: string;
      shared_via: "user" | "team";
      shared_team_id: string | null;
    }
  >;

  return rows.map((r) => ({
    ...r,
    permission: r.rank === 2 ? "edit" : "view",
  }));
}

// ─── Rate limit helpers (SQLite-backed, survives restarts) ────────────────────

export function checkRateLimitDb(key: string, limit: number, windowMs = 60_000): boolean {
  const db = getDb();
  const now = Date.now();
  const row = db.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?").get(key) as { count: number; reset_at: number } | undefined;
  if (!row || row.reset_at < now) {
    db.prepare("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)").run(key, now + windowMs);
    return true;
  }
  if (row.count >= limit) return false;
  db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").run(key);
  return true;
}

export function pruneRateLimits(): void {
  getDb().prepare("DELETE FROM rate_limits WHERE reset_at < ?").run(Date.now());
}
