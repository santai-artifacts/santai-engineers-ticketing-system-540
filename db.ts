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

// ---- One-time seed so the board looks alive on first run ----
const seeded = db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number };
if (seeded.n === 0) {
  const colors = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6"];
  const team = [
    ["arin", "Arin Patel"],
    ["mei", "Mei Chen"],
    ["dev", "Devon Brooks"],
    ["sol", "Sol Rivera"],
  ];
  const insUser = db.query(
    "INSERT INTO users (username, display_name, color) VALUES (?, ?, ?)"
  );
  const ids: number[] = [];
  team.forEach((t, i) => {
    const r = insUser.run(t[0], t[1], colors[i % colors.length]);
    ids.push(Number(r.lastInsertRowid));
  });

  const insTicket = db.query(`
    INSERT INTO tickets (title, description, status, priority, labels, reporter_id, assignee_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const rows: [string, string, string, string, string, number, number | null][] = [
    ["Login page throws 500 on empty password", "Submitting the form with a blank password field returns a server error instead of a validation message. Repro on staging.", "in_progress", "urgent", "bug,auth", ids[0], ids[1]],
    ["Add dark mode toggle to settings", "Users have asked for a dark theme. Persist the preference per account.", "todo", "medium", "feature,ui", ids[1], ids[2]],
    ["Slow dashboard query on large teams", "The tickets aggregation query takes >4s for orgs with 5k+ tickets. Needs an index and pagination.", "backlog", "high", "performance", ids[2], null],
    ["Onboarding email links point to localhost", "Welcome emails from the last release contain localhost URLs. Config bug in the email templater.", "done", "high", "bug", ids[3], ids[0]],
    ["Draft Q3 roadmap doc", "Collect input from the team and publish the Q3 roadmap for review.", "todo", "low", "planning", ids[0], ids[3]],
    ["Flaky test in billing suite", "billing.spec.ts fails intermittently in CI, roughly 1 in 8 runs. Suspect a timing issue.", "in_progress", "medium", "bug,ci", ids[1], ids[1]],
  ];
  for (const r of rows) insTicket.run(...r);

  db.query("INSERT INTO comments (ticket_id, user_id, body) VALUES (?, ?, ?)").run(
    1, ids[1], "Reproduced — it's an unhandled null in the auth controller. Fix incoming."
  );
}

export default db;
