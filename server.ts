import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import db, { uploadsDir } from "./db";
import { unlink } from "node:fs/promises";
import {
  githubConfigured,
  createIssue,
  updateIssueState,
  listIssues,
  listOpenPRs,
  requestReviewers,
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

// Set the current user's GitHub handle (used to match review requests).
app.post("/api/me/github", async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "Sign in first" }, 401);
  const { github_login } = await c.req.json<{ github_login: string }>();
  const login = (github_login || "").trim().replace(/^@/, "");
  db.query("UPDATE users SET github_login = ? WHERE id = ?").run(login || null, me.id);
  return c.json(db.query("SELECT * FROM users WHERE id = ?").get(me.id));
});

app.delete("/api/users/:id", (c) => {
  const me = currentUser(c);
  const id = Number(c.req.param("id"));
  if (me && me.id === id) return c.json({ error: "You can't remove yourself while signed in. Switch users first." }, 400);
  const u = db.query("SELECT id FROM users WHERE id = ?").get(id);
  if (!u) return c.json({ error: "Not found" }, 404);
  // Tickets/comments/assignments reference users with ON DELETE SET NULL, so they survive.
  db.query("DELETE FROM users WHERE id = ?").run(id);
  return c.json({ ok: true });
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
              r.display_name AS reporter_name,
              (SELECT COUNT(*) FROM attachments at WHERE at.ticket_id = t.id) AS attachment_count
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
  const attachments = db
    .query("SELECT id, original, mime, size, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(id);
  return c.json({ ...t, comments, attachments });
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

// ---------- API: attachments (images) ----------
const IMG_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MAX_IMG = 8 * 1024 * 1024; // 8 MB

app.post("/api/tickets/:id/attachments", async (c) => {
  const me = currentUser(c);
  if (!me) return c.json({ error: "Sign in first" }, 401);
  const id = Number(c.req.param("id"));
  if (!db.query("SELECT id FROM tickets WHERE id = ?").get(id)) return c.json({ error: "Not found" }, 404);

  let form: FormData;
  try { form = await c.req.formData(); } catch { return c.json({ error: "Expected multipart form data" }, 400); }
  const files = form.getAll("images").filter((f): f is File => f instanceof File);
  if (!files.length) return c.json({ error: "No image provided" }, 400);

  const saved = [];
  for (const file of files) {
    if (!IMG_TYPES[file.type]) return c.json({ error: `Unsupported file type: ${file.type || "unknown"}. Images only.` }, 400);
    if (file.size > MAX_IMG) return c.json({ error: `${file.name} is larger than 8 MB` }, 400);
    const stored = `${crypto.randomUUID()}.${IMG_TYPES[file.type]}`;
    await Bun.write(`${uploadsDir}/${stored}`, file);
    const r = db
      .query("INSERT INTO attachments (ticket_id, stored_name, original, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, stored, file.name, file.type, file.size, me.id);
    saved.push({ id: Number(r.lastInsertRowid), original: file.name, mime: file.type, size: file.size });
  }
  db.query("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(id);
  return c.json(saved, 201);
});

app.get("/api/attachments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const a = db.query("SELECT stored_name, mime FROM attachments WHERE id = ?").get(id) as any;
  if (!a) return c.json({ error: "Not found" }, 404);
  const file = Bun.file(`${uploadsDir}/${a.stored_name}`);
  if (!(await file.exists())) return c.json({ error: "File missing" }, 404);
  return new Response(file, { headers: { "Content-Type": a.mime, "Cache-Control": "private, max-age=86400" } });
});

app.delete("/api/attachments/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const a = db.query("SELECT stored_name FROM attachments WHERE id = ?").get(id) as any;
  if (!a) return c.json({ error: "Not found" }, 404);
  db.query("DELETE FROM attachments WHERE id = ?").run(id);
  try { await unlink(`${uploadsDir}/${a.stored_name}`); } catch {}
  return c.json({ ok: true });
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

// Sync with GitHub PRs: auto-advance tickets that have an open PR, and
// surface the PRs awaiting the current user's review.
app.get("/api/github/sync", async (c) => {
  const me = currentUser(c);
  const repo = getSetting("github_repo");
  const base = { connected: githubConfigured(), repo, reviewPRs: [] as any[], linked: {} as Record<string, any[]>, autoMoved: [] as number[], login: me?.github_login || null };
  if (!githubConfigured() || !repo) return c.json(base);

  const [owner, name] = repo.split("/");
  try {
    const prs = await listOpenPRs(owner, name);

    // Map issue number -> open PRs that declare they close/fix/resolve it.
    const closingRe = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
    const linked: Record<string, any[]> = {};
    for (const pr of prs) {
      const text = `${pr.title}\n${pr.body || ""}`;
      const nums = new Set<number>();
      let m: RegExpExecArray | null;
      closingRe.lastIndex = 0;
      while ((m = closingRe.exec(text))) nums.add(Number(m[1]));
      for (const n of nums) {
        (linked[n] ||= []).push({ number: pr.number, title: pr.title, url: pr.html_url, draft: pr.draft });
      }
    }

    // Auto-advance any backlog/todo ticket that now has an open PR.
    const autoMoved: number[] = [];
    for (const issueNum of Object.keys(linked)) {
      const rows = db.query("SELECT id, status FROM tickets WHERE github_number = ?").all(Number(issueNum)) as any[];
      for (const t of rows) {
        if (t.status === "backlog" || t.status === "todo") {
          db.query("UPDATE tickets SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(t.id);
          autoMoved.push(t.id);
        }
      }
    }

    // PRs where the current user is a requested reviewer.
    let reviewPRs: any[] = [];
    const login = me?.github_login;
    if (login) {
      reviewPRs = prs
        .filter((pr) => (pr.requested_reviewers || []).some((r: any) => (r.login || "").toLowerCase() === login.toLowerCase()))
        .map((pr) => ({ number: pr.number, title: pr.title, url: pr.html_url, author: pr.user?.login, draft: pr.draft, created_at: pr.created_at }));
    }

    return c.json({ ...base, linked, autoMoved, reviewPRs, login: login || null });
  } catch (e) {
    const err = e as GitHubError;
    return c.json({ ...base, error: err.message });
  }
});

// Review load per member + PRs that currently have no reviewer.
app.get("/api/reviews/load", async (c) => {
  const w = c.req.query("window") === "7d" ? "7d" : "24h";
  const since = w === "7d" ? "-7 days" : "-1 day";
  const load = db
    .query(
      `SELECT u.id, u.display_name, u.color, u.github_login,
              (SELECT COUNT(*) FROM review_assignments ra
               WHERE ra.reviewer_id = u.id AND ra.assigned_at >= datetime('now', ?)) AS count
       FROM users u ORDER BY count DESC, u.display_name`
    )
    .all(since) as any[];

  let candidates: any[] = [];
  const repo = getSetting("github_repo");
  if (githubConfigured() && repo) {
    const [owner, name] = repo.split("/");
    try {
      const prs = await listOpenPRs(owner, name);
      candidates = prs
        .filter((p) => !(p.requested_reviewers || []).length)
        .map((p) => ({ number: p.number, title: p.title, url: p.html_url, author: p.user?.login, draft: p.draft }));
    } catch {}
  }
  return c.json({ window: w, load, candidates, connected: githubConfigured(), repo });
});

// Assign a reviewer to a PR: least-loaded eligible member unless one is named.
app.post("/api/reviews/assign", async (c) => {
  const { pr_number, reviewer_id, exclude_login } = await c.req.json<any>();
  if (!pr_number) return c.json({ error: "pr_number is required" }, 400);
  const repo = getSetting("github_repo");
  if (!githubConfigured() || !repo) return c.json({ error: "Connect GitHub first" }, 400);
  const [owner, name] = repo.split("/");

  let reviewer: any;
  if (reviewer_id) {
    reviewer = db.query("SELECT * FROM users WHERE id = ?").get(reviewer_id);
  } else {
    // Least-loaded eligible reviewer over the last 24h; oldest-assigned breaks ties.
    const rows = db
      .query(
        `SELECT u.*,
                (SELECT COUNT(*) FROM review_assignments ra WHERE ra.reviewer_id = u.id AND ra.assigned_at >= datetime('now','-1 day')) AS n,
                COALESCE((SELECT MAX(assigned_at) FROM review_assignments ra WHERE ra.reviewer_id = u.id), '0') AS last_at
         FROM users u
         WHERE u.github_login IS NOT NULL AND u.github_login <> ''
           AND (? IS NULL OR lower(u.github_login) <> lower(?))
         ORDER BY n ASC, last_at ASC`
      )
      .all(exclude_login || null, exclude_login || null) as any[];
    reviewer = rows[0];
  }
  if (!reviewer || !reviewer.github_login) {
    return c.json({ error: "No eligible reviewer — add team members with GitHub usernames set" }, 400);
  }
  try {
    await requestReviewers(owner, name, pr_number, [reviewer.github_login]);
    db.query("INSERT INTO review_assignments (pr_number, reviewer_id, reviewer_login) VALUES (?, ?, ?)").run(
      pr_number,
      reviewer.id,
      reviewer.github_login
    );
    return c.json({ ok: true, reviewer: { id: reviewer.id, display_name: reviewer.display_name, github_login: reviewer.github_login } });
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
