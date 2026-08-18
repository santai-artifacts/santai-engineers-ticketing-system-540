// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) =>
  (name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

// ---------- app state ----------
const state = {
  me: null,
  users: [],
  tickets: [],
  githubConnected: false,
  githubRepo: null,
  reviewPRs: [],
  linkedByIssue: {},
  ghSyncError: null,
  filter: { assignee: "", priority: "", search: "" },
};
let syncTimer = null;

const COLUMNS = [
  { key: "backlog", label: "Backlog", color: "#64748b" },
  { key: "todo", label: "To do", color: "#3b82f6" },
  { key: "in_progress", label: "In progress", color: "#f59e0b" },
  { key: "done", label: "Done", color: "#14b8a6" },
];
const PRIO_LABEL = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

// ---------- boot ----------
init();
async function init() {
  const me = await api("/api/me").catch(() => ({ user: null }));
  state.githubConnected = me.githubConnected;
  if (me.user) {
    state.me = me.user;
    await enterApp();
  } else {
    showLogin();
  }
}

// ---------- login ----------
async function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  state.users = await api("/api/users");
  const sel = $("#login-select");
  sel.innerHTML = state.users.length
    ? state.users.map((u) => `<option value="${u.username}">${esc(u.display_name)} (@${esc(u.username)})</option>`).join("")
    : `<option value="">No members yet — add yourself below</option>`;

  $("#login-btn").onclick = async () => {
    const username = sel.value;
    if (!username) return;
    try {
      state.me = await api("/api/login", { method: "POST", body: { username } });
      await enterApp();
    } catch (e) {
      $("#login-error").textContent = e.message;
    }
  };

  $("#new-user-btn").onclick = async () => {
    const username = $("#new-username").value;
    const display_name = $("#new-display").value;
    try {
      const user = await api("/api/users", { method: "POST", body: { username, display_name } });
      state.me = await api("/api/login", { method: "POST", body: { username: user.username } });
      await enterApp();
    } catch (e) {
      $("#login-error").textContent = e.message;
    }
  };
}

async function enterApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#me-name").textContent = state.me.display_name;
  const av = $("#me-avatar");
  av.textContent = initials(state.me.display_name);
  av.style.background = state.me.color;

  wireChrome();
  await Promise.all([loadUsers(), loadTickets(), loadGithub()]);
  syncGithub(); // pull PR state after the board is up
  clearInterval(syncTimer);
  syncTimer = setInterval(() => syncGithub(), 90000); // keep in sync every 90s
}

// ---------- data loads ----------
async function loadUsers() {
  state.users = await api("/api/users");
  const opts = state.users.map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join("");
  $("#filter-assignee").innerHTML = `<option value="">Everyone</option>` + opts;
  $("#nt-assignee").innerHTML = `<option value="">Unassigned</option>` + opts;
}

async function loadTickets() {
  state.tickets = await api("/api/tickets");
  renderBoard();
}

async function loadGithub() {
  const g = await api("/api/github/settings").catch(() => ({ connected: false, repo: null }));
  state.githubConnected = g.connected;
  state.githubRepo = g.repo;
  const pill = $("#gh-pill");
  if (g.connected) {
    pill.className = "pill pill-ok";
    pill.textContent = g.repo ? `GitHub: ${g.repo}` : "GitHub: connected";
  } else {
    pill.className = "pill pill-off";
    pill.textContent = "GitHub: not connected";
  }
}

async function syncGithub(showToast = false) {
  const btn = $("#sync-btn");
  if (btn) { btn.disabled = true; btn.textContent = "↻ Syncing…"; }
  try {
    const r = await api("/api/github/sync");
    state.reviewPRs = r.reviewPRs || [];
    state.linkedByIssue = r.linked || {};
    state.ghSyncError = r.error || null;
    if (r.autoMoved && r.autoMoved.length) {
      await loadTickets(); // reflects server-side auto-advance
      toast(`${r.autoMoved.length} ticket${r.autoMoved.length > 1 ? "s" : ""} moved to In progress (open PR found)`);
    } else {
      renderBoard();
    }
    if (showToast && !r.autoMoved?.length) {
      toast(r.error ? r.error : `Synced · ${state.reviewPRs.length} awaiting your review`, !!r.error);
    }
  } catch (e) {
    state.ghSyncError = e.message;
    renderBoard();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "↻ Sync"; }
  }
}

// ---------- board render ----------
function visibleTickets() {
  const { assignee, priority, search } = state.filter;
  const q = search.trim().toLowerCase();
  return state.tickets.filter((t) => {
    if (assignee && String(t.assignee_id) !== assignee) return false;
    if (priority && t.priority !== priority) return false;
    if (q && !(`${t.title} ${t.labels} ${t.assignee_name || ""}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderBoard() {
  const board = $("#board");
  const tickets = visibleTickets();
  board.innerHTML = COLUMNS.map((col) => {
    const items = tickets.filter((t) => t.status === col.key);
    return `
      <section class="column" data-status="${col.key}">
        <div class="col-head">
          <span class="col-dot" style="background:${col.color}"></span>
          ${col.label}
          <span class="col-count">${items.length}</span>
        </div>
        <div class="col-body" data-drop="${col.key}">
          ${items.map(cardHTML).join("") || `<div class="empty-col">Drop tickets here</div>`}
        </div>
      </section>`;
  }).join("");

  board.insertAdjacentHTML("beforeend", reviewColumnHTML());
  $("#counts").textContent = `${tickets.length} of ${state.tickets.length} tickets`;
  wireCards();
}

function reviewColumnHTML() {
  let body;
  if (!state.githubConnected) {
    body = `<div class="empty-col">Connect GitHub (deploy with a token) to see review requests.</div>`;
  } else if (!state.me.github_login) {
    body = `<div class="empty-col">Set your GitHub username in ⚙ Settings to see PRs assigned to you.</div>`;
  } else if (state.ghSyncError) {
    body = `<div class="empty-col">${esc(state.ghSyncError)}</div>`;
  } else if (!state.reviewPRs.length) {
    body = `<div class="empty-col">🎉 Nothing awaiting your review.</div>`;
  } else {
    body = state.reviewPRs.map(prCardHTML).join("");
  }
  return `
    <section class="column review-column">
      <div class="col-head">
        <span class="col-dot" style="background:#a855f7"></span>
        Needs my review
        <span class="col-count">${state.githubConnected && state.me.github_login ? state.reviewPRs.length : "–"}</span>
      </div>
      <div class="col-body">${body}</div>
    </section>`;
}

function prCardHTML(pr) {
  return `
    <a class="card pr-card" href="${esc(pr.url)}" target="_blank" rel="noopener">
      <div class="card-top">
        <span class="id-chip">PR #${pr.number}</span>
        ${pr.draft ? `<span class="tag">draft</span>` : ""}
        <span class="gh-badge" style="margin-left:auto">${esc(pr.author || "")}</span>
      </div>
      <div class="card-title">${esc(pr.title)}</div>
      <div class="card-meta"><span class="hint" style="margin:0">opened ${esc(fmt(pr.created_at))}</span></div>
    </a>`;
}

function cardHTML(t) {
  const labels = t.labels ? t.labels.split(",").filter(Boolean) : [];
  const assignee = t.assignee_name
    ? `<span class="avatar avatar-sm" style="background:${t.assignee_color}" title="${esc(t.assignee_name)}">${initials(t.assignee_name)}</span>`
    : `<span class="avatar avatar-sm" style="background:#334155" title="Unassigned">–</span>`;
  const prs = t.github_number ? state.linkedByIssue[t.github_number] : null;
  const gh = t.github_number
    ? `<a class="gh-badge" href="${esc(t.github_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="View issue on GitHub">⎇ #${t.github_number}</a>`
    : "";
  const prBadge = prs && prs.length
    ? `<a class="pr-pill" href="${esc(prs[0].url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${prs.length} open PR${prs.length > 1 ? "s" : ""} linked">⇄ PR${prs.length > 1 ? ` ×${prs.length}` : ` #${prs[0].number}`}</a>`
    : "";
  return `
    <article class="card" draggable="true" data-id="${t.id}">
      <div class="card-top">
        <span class="id-chip">TKT-${t.id}</span>
        <span class="prio prio-${t.priority}">${PRIO_LABEL[t.priority]}</span>
        ${gh}
      </div>
      <div class="card-title">${esc(t.title)}</div>
      ${labels.length ? `<div class="card-labels">${labels.map((l) => `<span class="tag">${esc(l)}</span>`).join("")}</div>` : ""}
      <div class="card-meta">${assignee}${prBadge}</div>
    </article>`;
}

function wireCards() {
  let dragId = null;
  $$(".card").forEach((card) => {
    card.onclick = () => openTicket(Number(card.dataset.id));
    card.ondragstart = (e) => {
      dragId = Number(card.dataset.id);
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    };
    card.ondragend = () => card.classList.remove("dragging");
  });

  $$(".col-body").forEach((body) => {
    const col = body.closest(".column");
    body.ondragover = (e) => { e.preventDefault(); col.classList.add("drag-over"); };
    body.ondragleave = () => col.classList.remove("drag-over");
    body.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const status = body.dataset.drop;
      const t = state.tickets.find((x) => x.id === dragId);
      if (!t || t.status === status) return;
      const prev = t.status;
      t.status = status; // optimistic
      renderBoard();
      try {
        await api(`/api/tickets/${dragId}`, { method: "PATCH", body: { status } });
        if (t.github_number) toast(`Moved to ${status.replace("_", " ")} · GitHub issue synced`);
      } catch (err) {
        t.status = prev;
        renderBoard();
        toast(err.message, true);
      }
    };
  });
}

// ---------- ticket detail ----------
async function openTicket(id) {
  const t = await api(`/api/tickets/${id}`);
  const overlay = $("#ticket-modal");
  const box = $("#ticket-modal-inner");
  box.classList.add("modal-lg");

  const userOpts = (selId) =>
    `<option value="">Unassigned</option>` +
    state.users.map((u) => `<option value="${u.id}" ${u.id === selId ? "selected" : ""}>${esc(u.display_name)}</option>`).join("");
  const prioOpts = (sel) =>
    Object.entries(PRIO_LABEL).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v}</option>`).join("");
  const statusOpts = (sel) =>
    COLUMNS.map((c) => `<option value="${c.key}" ${c.key === sel ? "selected" : ""}>${c.label}</option>`).join("");

  const ghSection = t.github_number
    ? `<a class="gh-link" href="${esc(t.github_url)}" target="_blank" rel="noopener">⎇ Issue #${t.github_number} on GitHub ↗</a>`
    : `<button class="btn" id="td-push" style="width:100%">⎇ Push to GitHub</button>`;

  box.innerHTML = `
    <div class="td-head">
      <input class="input td-title-input" id="td-title" value="${esc(t.title)}" />
      <button class="btn-icon" id="td-close">✕</button>
    </div>
    <div class="td-cols">
      <div class="td-main">
        <span class="id-chip">TKT-${t.id}</span>
        <label class="field-label">Description</label>
        <div class="desc-view ${t.description ? "" : "empty"}" id="td-desc-view">${t.description ? esc(t.description) : "Add a description…"}</div>
        <textarea class="input hidden" id="td-desc-edit" rows="5">${esc(t.description)}</textarea>

        <div class="comments">
          <h3>Activity</h3>
          <div id="td-comments">${(t.comments || []).map(commentHTML).join("") || `<p class="hint">No comments yet.</p>`}</div>
          <div class="comment-form">
            <input class="input" id="td-comment" placeholder="Leave a comment…" />
            <button class="btn btn-primary" id="td-comment-send">Send</button>
          </div>
        </div>
      </div>
      <div class="td-side">
        <label class="field-label">Status</label>
        <select class="input" id="td-status">${statusOpts(t.status)}</select>
        <label class="field-label">Priority</label>
        <select class="input" id="td-priority">${prioOpts(t.priority)}</select>
        <label class="field-label">Assignee</label>
        <select class="input" id="td-assignee">${userOpts(t.assignee_id)}</select>
        <label class="field-label">Labels</label>
        <input class="input" id="td-labels" value="${esc(t.labels)}" placeholder="comma, separated" />
        <label class="field-label">Reporter</label>
        <div class="hint" style="margin:0">${esc(t.reporter_name || "—")}</div>
        <label class="field-label">GitHub</label>
        ${ghSection}
        <div style="margin-top:auto;padding-top:16px">
          <button class="btn btn-danger" id="td-delete" style="width:100%">Delete ticket</button>
        </div>
      </div>
    </div>`;

  overlay.classList.remove("hidden");

  const patch = async (body) => {
    try {
      await api(`/api/tickets/${id}`, { method: "PATCH", body });
      await loadTickets();
    } catch (e) { toast(e.message, true); }
  };

  $("#td-close").onclick = closeTicket;
  overlay.onclick = (e) => { if (e.target === overlay) closeTicket(); };

  // title (save on blur if changed)
  const titleEl = $("#td-title");
  titleEl.onblur = () => { if (titleEl.value.trim() && titleEl.value !== t.title) patch({ title: titleEl.value.trim() }); };

  // description inline edit
  const dv = $("#td-desc-view"), de = $("#td-desc-edit");
  dv.onclick = () => { dv.classList.add("hidden"); de.classList.remove("hidden"); de.focus(); };
  de.onblur = async () => {
    de.classList.add("hidden"); dv.classList.remove("hidden");
    if (de.value !== t.description) { await patch({ description: de.value }); t.description = de.value; }
    dv.textContent = de.value || "Add a description…";
    dv.classList.toggle("empty", !de.value);
  };

  $("#td-status").onchange = (e) => patch({ status: e.target.value });
  $("#td-priority").onchange = (e) => patch({ priority: e.target.value });
  $("#td-assignee").onchange = (e) => patch({ assignee_id: e.target.value ? Number(e.target.value) : null });
  $("#td-labels").onblur = (e) => { if (e.target.value !== t.labels) patch({ labels: e.target.value }); };

  $("#td-delete").onclick = async () => {
    if (!confirm("Delete this ticket permanently?")) return;
    await api(`/api/tickets/${id}`, { method: "DELETE" });
    closeTicket();
    await loadTickets();
    toast("Ticket deleted");
  };

  const sendComment = async () => {
    const inp = $("#td-comment");
    if (!inp.value.trim()) return;
    await api(`/api/tickets/${id}/comments`, { method: "POST", body: { body: inp.value } });
    inp.value = "";
    openTicket(id); // refresh detail
    loadTickets();
  };
  $("#td-comment-send").onclick = sendComment;
  $("#td-comment").onkeydown = (e) => { if (e.key === "Enter") sendComment(); };

  const pushBtn = $("#td-push");
  if (pushBtn) pushBtn.onclick = async () => {
    if (!state.githubConnected) return toast("Connect GitHub first (Settings). The token is set when the app is deployed.", true);
    if (!state.githubRepo) return toast("Set a target repo in Settings first", true);
    pushBtn.disabled = true; pushBtn.textContent = "Pushing…";
    try {
      await api(`/api/tickets/${id}/push`, { method: "POST" });
      toast("Pushed to GitHub ✓");
      openTicket(id);
      loadTickets();
    } catch (e) {
      toast(e.message, true);
      pushBtn.disabled = false; pushBtn.textContent = "⎇ Push to GitHub";
    }
  };
}

function commentHTML(c) {
  return `
    <div class="comment">
      <span class="avatar avatar-sm" style="background:${c.color || "#334155"}">${initials(c.display_name)}</span>
      <div class="comment-body">
        <div class="comment-meta"><b>${esc(c.display_name || "Someone")}</b> · ${esc(fmt(c.created_at))}</div>
        <div class="comment-text">${esc(c.body)}</div>
      </div>
    </div>`;
}
function closeTicket() { $("#ticket-modal").classList.add("hidden"); }

function fmt(s) {
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(d)) return s;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------- chrome: new ticket, settings, filters ----------
function wireChrome() {
  // filters
  $("#filter-assignee").onchange = (e) => { state.filter.assignee = e.target.value; renderBoard(); };
  $("#filter-priority").onchange = (e) => { state.filter.priority = e.target.value; renderBoard(); };
  $("#search").oninput = (e) => { state.filter.search = e.target.value; renderBoard(); };

  $("#logout-btn").onclick = async () => { await api("/api/logout", { method: "POST" }); location.reload(); };
  $("#sync-btn").onclick = () => syncGithub(true);

  // new ticket
  $("#new-ticket-btn").onclick = () => {
    $("#nt-title").value = ""; $("#nt-desc").value = ""; $("#nt-labels").value = "";
    $("#nt-status").value = "backlog"; $("#nt-priority").value = "medium"; $("#nt-assignee").value = "";
    $("#nt-error").textContent = "";
    $("#new-modal").classList.remove("hidden");
    $("#nt-title").focus();
  };
  $$("[data-close-new]").forEach((b) => (b.onclick = () => $("#new-modal").classList.add("hidden")));
  $("#nt-create").onclick = async () => {
    const body = {
      title: $("#nt-title").value,
      description: $("#nt-desc").value,
      status: $("#nt-status").value,
      priority: $("#nt-priority").value,
      assignee_id: $("#nt-assignee").value ? Number($("#nt-assignee").value) : null,
      labels: $("#nt-labels").value,
    };
    if (!body.title.trim()) { $("#nt-error").textContent = "Title is required"; return; }
    try {
      await api("/api/tickets", { method: "POST", body });
      $("#new-modal").classList.add("hidden");
      await loadTickets();
      toast("Ticket created");
    } catch (e) { $("#nt-error").textContent = e.message; }
  };

  // settings
  $("#settings-btn").onclick = () => openSettings();
  $$("[data-close-settings]").forEach((b) => (b.onclick = () => $("#settings-modal").classList.add("hidden")));
  $("#gh-save").onclick = async () => {
    try {
      const r = await api("/api/github/settings", { method: "POST", body: { repo: $("#gh-repo").value } });
      state.githubRepo = r.repo;
      $("#gh-error").textContent = "";
      toast("Repository saved");
      await loadGithub();
      openSettings();
    } catch (e) { $("#gh-error").textContent = e.message; }
  };
  $("#gh-import").onclick = async () => {
    const btn = $("#gh-import");
    btn.disabled = true; btn.textContent = "Importing…";
    try {
      const r = await api("/api/github/import", { method: "POST" });
      toast(r.imported ? `Imported ${r.imported} issue${r.imported === 1 ? "" : "s"}` : "No new issues to import");
      $("#settings-modal").classList.add("hidden");
      await loadTickets();
    } catch (e) { $("#gh-error").textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = "↓ Import issues"; }
  };

  // balance reviews
  $("#balance-btn").onclick = () => openBalance();
  $$("[data-close-balance]").forEach((b) => (b.onclick = () => $("#balance-modal").classList.add("hidden")));
  $$("#bal-window .seg-btn").forEach((b) => (b.onclick = () => {
    $$("#bal-window .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    loadBalance(b.dataset.win);
  }));
  $("#bal-auto-all").onclick = autoAssignAll;

  // esc closes topmost modal
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const id of ["#ticket-modal", "#new-modal", "#settings-modal", "#balance-modal"]) {
      if (!$(id).classList.contains("hidden")) { $(id).classList.add("hidden"); break; }
    }
  });
}

// ---------- balance reviews ----------
let balState = { window: "24h", load: [], candidates: [] };

function openBalance() {
  if (!state.githubConnected) {
    toast("Connect GitHub (deploy with a token) to assign reviewers.", true);
  }
  $("#bal-error").textContent = "";
  $("#balance-modal").classList.remove("hidden");
  loadBalance(balState.window);
}

async function loadBalance(win) {
  balState.window = win;
  $("#bal-load").innerHTML = `<p class="hint">Loading…</p>`;
  $("#bal-candidates").innerHTML = "";
  try {
    const r = await api(`/api/reviews/load?window=${win}`);
    balState.load = r.load || [];
    balState.candidates = r.candidates || [];
    renderBalance();
  } catch (e) {
    $("#bal-error").textContent = e.message;
  }
}

function renderBalance() {
  const max = Math.max(1, ...balState.load.map((u) => u.count));
  const eligible = balState.load.filter((u) => u.github_login);
  $("#bal-load").innerHTML = balState.load.length
    ? balState.load.map((u) => `
        <div class="load-row ${u.github_login ? "" : "load-dim"}">
          <span class="avatar avatar-sm" style="background:${u.color}">${initials(u.display_name)}</span>
          <span class="load-name">${esc(u.display_name)}${u.github_login ? `<span class="load-handle">@${esc(u.github_login)}</span>` : `<span class="load-handle load-warn">no GitHub username</span>`}</span>
          <span class="load-bar"><span class="load-fill" style="width:${(u.count / max) * 100}%"></span></span>
          <span class="load-count">${u.count}</span>
        </div>`).join("")
    : `<p class="hint">No team members yet.</p>`;

  const options = eligible.map((u) => `<option value="${u.id}">${esc(u.display_name)} (${u.count})</option>`).join("");
  $("#bal-candidates").innerHTML = balState.candidates.length
    ? balState.candidates.map((pr) => `
        <div class="cand-row" data-pr="${pr.number}">
          <div class="cand-main">
            <span class="id-chip">PR #${pr.number}</span> ${pr.draft ? `<span class="tag">draft</span>` : ""}
            <span class="cand-title">${esc(pr.title)}</span>
            <span class="hint" style="margin:0">by ${esc(pr.author || "?")}</span>
          </div>
          <div class="cand-actions">
            <select class="input input-sm cand-pick">${options}</select>
            <button class="btn btn-sm cand-assign" data-author="${esc(pr.author || "")}">Assign</button>
          </div>
        </div>`).join("")
    : `<p class="hint">${state.githubConnected ? "Every open PR already has a reviewer. 🎉" : "Deploy with a GitHub token to see open PRs here."}</p>`;

  $$(".cand-row").forEach((row) => {
    const num = Number(row.dataset.pr);
    row.querySelector(".cand-assign").onclick = () =>
      assignReviewer(num, Number(row.querySelector(".cand-pick").value));
  });
}

async function assignReviewer(pr_number, reviewer_id, silent = false) {
  try {
    const r = await api("/api/reviews/assign", { method: "POST", body: { pr_number, reviewer_id } });
    if (!silent) toast(`PR #${pr_number} → ${r.reviewer.display_name}`);
    return true;
  } catch (e) {
    if (!silent) $("#bal-error").textContent = e.message;
    return false;
  }
}

// Assign every reviewer-less PR to the least-loaded eligible member (server picks),
// excluding each PR's author. Sequential so the ledger balances as it goes.
async function autoAssignAll() {
  const btn = $("#bal-auto-all");
  btn.disabled = true; btn.textContent = "Assigning…";
  $("#bal-error").textContent = "";
  let done = 0;
  for (const row of $$(".cand-row")) {
    const num = Number(row.dataset.pr);
    const author = row.querySelector(".cand-assign").dataset.author;
    try {
      await api("/api/reviews/assign", { method: "POST", body: { pr_number: num, exclude_login: author || null } });
      done++;
    } catch (e) { $("#bal-error").textContent = e.message; }
  }
  btn.disabled = false; btn.textContent = "⚡ Auto-assign all";
  toast(done ? `Assigned ${done} PR${done > 1 ? "s" : ""} to the lightest-loaded reviewers` : "Nothing to assign", !done);
  loadBalance(balState.window);
  syncGithub();
}

function openSettings() {
  const box = $("#gh-status-box");
  if (state.githubConnected) {
    box.className = "status-box ok";
    box.textContent = "✓ GitHub token detected. You can push tickets and import issues.";
  } else {
    box.className = "status-box off";
    box.innerHTML = "GitHub token not set. Set the <b>GITHUB_TOKEN</b> secret and deploy — the value is injected into the live app. You can still configure the repo below.";
  }
  $("#gh-repo").value = state.githubRepo || "";
  const loginEl = $("#gh-login");
  loginEl.value = state.me.github_login || "";
  loginEl.onblur = async () => {
    if ((loginEl.value.trim() || "") === (state.me.github_login || "")) return;
    try {
      state.me = await api("/api/me/github", { method: "POST", body: { github_login: loginEl.value } });
      toast("GitHub username saved");
      syncGithub();
    } catch (e) { $("#gh-error").textContent = e.message; }
  };
  $("#gh-error").textContent = "";
  $("#settings-modal").classList.remove("hidden");
}
