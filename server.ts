import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import db from "./db";
import {
  githubConfigured,
  createIssue,
  updateIssueState,
  listIssues,
  GitHubError,
} from "./github";

const app = new Hono();
const publicDir = `${import.meta.dir}/public`;

// ---------- helpers ----------
const STATUSES = ["backlog", "todo", "in_progress", "done"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
function setSetting(key: string, value: string) {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
function currentUser(c: any) {
  const uid = Number(getCookie(c, "uid"));
  if (!uid) return null;
  return db.query("SELECT * FROM users WHERE id = ?").get(uid) as any;
}
function ticketWithPeople(id: number) {
  return db
    .query(
      `SELECT t.*,
              r.display_name AS reporter_name, r.color AS reporter_color, r.username AS reporter_username,
              a.display_name AS assignee_name, a.color AS assignee_color, a.username AS assignee_username
       FROM tickets t
       LEFT JOIN users r ON r.id = t.reporter_id
       LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.id = ?`
    )
    .get(id) as any;
}
function labelsArr(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// ---------- API: auth / users ----------
app.get("/api/me", (c) => {
  const user = currentUser(c);
  return c.json({ user, githubConnected: githubConfigured() });
});

app.get("/api/users", (c) => {
  const users = db.query("SELECT * FROM users ORDER BY display_name").all();
  return c.json(users);
});

app.post("/api/login", async (c) => {
  const { username } = await c.req.json<{ username: string }>();
  const uname = (username || "").trim().toLowerCase();
  if (!uname) return c.json({ error: "Username is required" }, 400);
  const user = db.query("SELECT * FROM users WHERE username = ?").get(uname) as any;
  if (!user) return c.json({ error: "No team member with that username" }, 404);
  setCookie(c, "uid", String(user.id), { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
  return c.json(user);
});

app.post("/api/users", async (c) => {
  const { username, display_name } = await c.req.json<{ username: string; display_name: string }>();
  const uname = (username || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = (display_name || "").trim();
  if (!uname || !name) return c.json({ error: "Username and display name are required" }, 400);
  const exists = db.query("SELECT id FROM users WHERE username = ?").get(uname);
  if (exists) return c.json({ error: "That username is taken" }, 409);
  const palette = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#8b5cf6", "#ef4444", "#0ea5e9", "#84cc16"];
  const count = (db.query("SELECT COUNT(*) AS n FROM users").get() as any).n;
  const color = palette[count % palette.length];
  const r = db.query("INSERT INTO users (username, display_name, color) VALUES (?, ?, ?)").run(uname, name, color);
  const user = db.query("SELECT * FROM users WHERE id = ?").get(Number(r.lastInsertRowid));
  return c.json(user, 201);
});

app.post("/api/logout", (c) => {
  setCookie(c, "uid", "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

// ---------- API: tickets ----------
app.get("/api/tickets", (c) => {
  const rows = db
    .query(
      `SELECT t.*,
              a.display_name AS assignee_name, a.color AS assignee_color, a.username AS assignee_username,
              r.display_name AS reporter_name
       FROM tickets t
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN users r ON r.id = t.reporter_id
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
         t.updated_at DESC`
    )
    .all();
  return c.json(rows);
});

app.get("/api/tickets/:id", (c) => {
  const id = Number(c.req.param("id"));
  const t = ticketWithPeople(id);
  if (!t) return c.json({ error: "Not found" }, 404);
  const comments = db
    .query(
      `SELECT cm.*, u.display_name, u.color, u.username
       FROM comments cm LEFT JOIN users u ON u.id = cm.user_id
       WHERE cm.ticket_id = ? ORDER BY cm.created_at ASC`
    )
    .all(id);
  return c.json({ ...t, comments });
});

app.post("/api/tickets", async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "Sign in first" }, 401);
  const b = await c.req.json<any>();
  const title = (b.title || "").trim();
  if (!title) return c.json({ error: "Title is required" }, 400);
  const status = STATUSES.includes(b.status) ? b.status : "backlog";
  const priority = PRIORITIES.includes(b.priority) ? b.priority : "medium";
  const labels = Array.isArray(b.labels) ? b.labels.join(",") : (b.labels || "");
  const r = db
    .query(
      `INSERT INTO tickets (title, description, status, priority, labels, reporter_id, assignee_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(title, b.description || "", status, priority, labels, me.id, b.assignee_id || null);
  return c.json(ticketWithPeople(Number(r.lastInsertRowid)), 201);
});

app.patch("/api/tickets/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = db.query("SELECT * FROM tickets WHERE id = ?").get(id) as any;
  if (!existing) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json<any>();
  const fields: Record<string, any> = {};
  if (typeof b.title === "string" && b.title.trim()) fields.title = b.title.trim();
  if (typeof b.description === "string") fields.description = b.description;
  if (STATUSES.includes(b.status)) fields.status = b.status;
  if (PRIORITIES.includes(b.priority)) fields.priority = b.priority;
  if (b.labels !== undefined) fields.labels = Array.isArray(b.labels) ? b.labels.join(",") : b.labels;
  if (b.assignee_id !== undefined) fields.assignee_id = b.assignee_id || null;

  if (Object.keys(fields).length) {
    const set = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    db.query(`UPDATE tickets SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(
      ...Object.values(fields),
      id
    );
  }

  // Keep a linked GitHub issue's open/closed state in sync when status changes.
  const repo = getSetting("github_repo");
  if (existing.github_number && repo && b.status && githubConfigured()) {
    const [owner, name] = repo.split("/");
    const ghState = b.status === "done" ? "closed" : "open";
    try {
      await updateIssueState(owner, name, existing.github_number, ghState);
    } catch (e) {
      // Non-fatal: local update already succeeded.
    }
  }
  return c.json(ticketWithPeople(id));
});

app.delete("/api/tickets/:id", (c) => {
  const id = Number(c.req.param("id"));
  db.query("DELETE FROM tickets WHERE id = ?").run(id);
  return c.json({ ok: true });
});

app.post("/api/tickets/:id/comments", async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "Sign in first" }, 401);
  const id = Number(c.req.param("id"));
  const { body } = await c.req.json<{ body: string }>();
  if (!body?.trim()) return c.json({ error: "Comment cannot be empty" }, 400);
  db.query("INSERT INTO comments (ticket_id, user_id, body) VALUES (?, ?, ?)").run(id, me.id, body.trim());
  db.query("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(id);
  return c.json({ ok: true }, 201);
});

// ---------- API: GitHub integration ----------
app.get("/api/github/settings", (c) => {
  return c.json({ connected: githubConfigured(), repo: getSetting("github_repo") });
});

app.post("/api/github/settings", async (c) => {
  const { repo } = await c.req.json<{ repo: string }>();
  const clean = (repo || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (clean && !/^[\w.-]+\/[\w.-]+$/.test(clean)) {
    return c.json({ error: "Use the form owner/repo, e.g. octocat/hello-world" }, 400);
  }
  setSetting("github_repo", clean);
  return c.json({ connected: githubConfigured(), repo: clean });
});

// Push a local ticket to GitHub as a new issue.
app.post("/api/tickets/:id/push", async (c) => {
  const id = Number(c.req.param("id"));
  const t = db.query("SELECT * FROM tickets WHERE id = ?").get(id) as any;
  if (!t) return c.json({ error: "Not found" }, 404);
  if (t.github_number) return c.json({ error: "Already linked to a GitHub issue" }, 409);
  const repo = getSetting("github_repo");
  if (!repo) return c.json({ error: "Set a target repository in Settings first" }, 400);
  const [owner, name] = repo.split("/");
  try {
    const issue = await createIssue(owner, name, {
      title: t.title,
      body: `${t.description || "_No description_"}\n\n---\n_Created from Tracktile ticket #${t.id}_`,
      labels: labelsArr(t.labels),
    });
    db.query("UPDATE tickets SET github_number = ?, github_url = ?, updated_at = datetime('now') WHERE id = ?").run(
      issue.number,
      issue.html_url,
      id
    );
    return c.json(ticketWithPeople(id));
  } catch (e) {
    const err = e as GitHubError;
    return c.json({ error: err.message }, (err.status as any) || 502);
  }
});

// Import issues from the configured repo as tickets.
app.post("/api/github/import", async (c) => {
  const me = currentUser(c);
  const repo = getSetting("github_repo");
  if (!repo) return c.json({ error: "Set a target repository in Settings first" }, 400);
  const [owner, name] = repo.split("/");
  try {
    const issues = await listIssues(owner, name);
    let imported = 0;
    const ins = db.query(
      `INSERT INTO tickets (title, description, status, priority, labels, reporter_id, github_number, github_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    for (const issue of issues) {
      const dup = db.query("SELECT id FROM tickets WHERE github_number = ?").get(issue.number);
      if (dup) continue;
      const labels = (issue.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)).join(",");
      const status = issue.state === "closed" ? "done" : "todo";
      ins.run(
        issue.title,
        issue.body || "",
        status,
        "medium",
        labels,
        me?.id || null,
        issue.number,
        issue.html_url
      );
      imported++;
    }
    return c.json({ imported, total: issues.length });
  } catch (e) {
    const err = e as GitHubError;
    return c.json({ error: err.message }, (err.status as any) || 502);
  }
});

// ---------- static files ----------
app.get("/*", async (c) => {
  const url = new URL(c.req.url);
  let path = decodeURIComponent(url.pathname);
  if (path === "/" || !path.includes(".")) path = "/index.html";
  const file = Bun.file(`${publicDir}${path}`);
  if (await file.exists()) return new Response(file);
  return new Response("Not found", { status: 404 });
});

export default { port: process.env.PORT || 3000, fetch: app.fetch };
