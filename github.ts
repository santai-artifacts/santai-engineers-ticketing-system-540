// Server-side GitHub REST helper. The token never reaches the browser.
const API = "https://api.github.com";

export function githubConfigured(): boolean {
  return !!process.env.GITHUB_TOKEN;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "tracktile-app",
    "Content-Type": "application/json",
  };
}

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function gh(path: string, init?: RequestInit) {
  if (!githubConfigured()) {
    throw new GitHubError(
      "GitHub is not connected. Ask an admin to set the GITHUB_TOKEN secret, then deploy.",
      503
    );
  }
  const res = await fetch(`${API}${path}`, { ...init, headers: headers() });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string };
      detail = j.message || "";
    } catch {}
    throw new GitHubError(
      `GitHub API error (${res.status})${detail ? `: ${detail}` : ""}`,
      res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502
    );
  }
  return res.json();
}

export async function createIssue(
  owner: string,
  repo: string,
  data: { title: string; body?: string; labels?: string[] }
) {
  return gh(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify(data),
  }) as Promise<{ number: number; html_url: string }>;
}

export async function updateIssueState(
  owner: string,
  repo: string,
  number: number,
  state: "open" | "closed"
) {
  return gh(`/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state }),
  });
}

export async function listOpenPRs(owner: string, repo: string) {
  return (await gh(
    `/repos/${owner}/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`
  )) as any[];
}

export async function requestReviewers(
  owner: string,
  repo: string,
  number: number,
  reviewers: string[]
) {
  return gh(`/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, {
    method: "POST",
    body: JSON.stringify({ reviewers }),
  });
}

export async function listIssues(owner: string, repo: string) {
  const issues = (await gh(
    `/repos/${owner}/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`
  )) as any[];
  // Filter out pull requests, which the issues endpoint also returns.
  return issues.filter((i) => !i.pull_request);
}
