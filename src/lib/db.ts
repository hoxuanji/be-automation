import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "helios.db");

const globalForDb = global as unknown as { _heliosDb: Database.Database | undefined };

function openDb(): Database.Database {
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

// ─── Encryption helpers ──────────────────────────────────────────────────────

function encKey(): Buffer {
  const raw =
    process.env.ENCRYPTION_KEY ??
    "helios-dev-enc-key-change-in-production";
  return crypto.createHash("sha256").update(raw).digest();
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
