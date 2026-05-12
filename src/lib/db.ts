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

  // Idempotent migration: deploy provider credentials (AES-256-GCM encrypted JSON blob)
  try {
    db.exec("ALTER TABLE users ADD COLUMN deploy_creds_enc TEXT");
  } catch {
    // Column already exists — no-op
  }

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

  const id = require("crypto").randomUUID() as string;
  // No real password — GitHub-only account
  const passwordHash = require("crypto").randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, github_id) VALUES (?, ?, ?, ?, ?)"
  ).run(id, email.toLowerCase(), name, passwordHash, githubId);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

export function findUserById(id: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
}

export function updateUserProfile(
  id: string,
  updates: { name?: string; email?: string; passwordHash?: string }
): void {
  const db = getDb();
  if (updates.name !== undefined)
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(updates.name, id);
  if (updates.email !== undefined)
    db.prepare("UPDATE users SET email = ? WHERE id = ?").run(updates.email, id);
  if (updates.passwordHash !== undefined)
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      updates.passwordHash,
      id
    );
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
