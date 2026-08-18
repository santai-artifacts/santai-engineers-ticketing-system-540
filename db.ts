import Database from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.DATABASE_URL || "./data/app.db";
// Ensure the containing directory exists so a fresh deploy can't fail to open the DB.
try { mkdirSync(dirname(dbPath), { recursive: true }); } catch {}

const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    color        TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'backlog',
    priority      TEXT NOT NULL DEFAULT 'medium',
    labels        TEXT NOT NULL DEFAULT '',
    reporter_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assignee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    github_number INTEGER,
    github_url    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS review_assignments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number      INTEGER NOT NULL,
    reviewer_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewer_login TEXT NOT NULL,
    assigned_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- lightweight migrations ----
const userCols = db.query("PRAGMA table_info(users)").all() as { name: string }[];
if (!userCols.some((c) => c.name === "github_login")) {
  db.exec("ALTER TABLE users ADD COLUMN github_login TEXT");
}

export default db;
