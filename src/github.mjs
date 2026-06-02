// Thin GitHub REST helpers and the PR-comment fingerprint logic that lets us
// skip re-analysis when the net mix.lock diff hasn't changed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MARKER = "<!-- mix-lock-supply-chain-guard -->";

/** Read the GitHub Actions event payload. */
export function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    return JSON.parse(readFileSafe(path));
  } catch {
    return null;
  }
}

function readFileSafe(p) {
  return readFileSync(p, "utf8");
}

/**
 * Determine the base and head refs for the mix.lock diff.
 * For a pull_request event we diff base..head (the cumulative PR change).
 */
export function resolveRefs(event, overrideBase) {
  const pr = event?.pull_request;
  if (pr) {
    return {
      base: overrideBase || pr.base?.sha,
      head: pr.head?.sha || process.env.GITHUB_SHA,
      prNumber: pr.number,
      baseRef: pr.base?.ref,
    };
  }
  // push / fallback: diff against the previous commit.
  return {
    base: overrideBase || event?.before || `${process.env.GITHUB_SHA}^`,
    head: process.env.GITHUB_SHA,
    prNumber: null,
    baseRef: null,
  };
}

/** Read a file's contents at a given git ref. Returns "" if absent at that ref. */
export function gitShow(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/** List files changed between base and head (paths relative to repo root). */
export function listChangedFiles(base, head) {
  const range = head ? `${base}..${head}` : base;
  try {
    const out = execFileSync("git", ["diff", "--name-only", range], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Ensure a ref's object is present locally (PR base may be a shallow fetch). */
export function ensureRef(ref) {
  if (!ref) return;
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
      stdio: "ignore",
    });
  } catch {
    try {
      execFileSync("git", ["fetch", "--depth=1", "origin", ref], {
        stdio: "ignore",
      });
    } catch {
      // best-effort; gitShow will fall back to "" if still missing
    }
  }
}

function repoSlug() {
  return process.env.GITHUB_REPOSITORY; // "owner/repo"
}

async function ghApi(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mix-lock-supply-chain-guard",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Find an existing guard comment on the PR, returning {id, fingerprint} or null. */
export async function findExistingComment(prNumber) {
  if (!prNumber) return null;
  const slug = repoSlug();
  let page = 1;
  while (true) {
    const comments = await ghApi(
      "GET",
      `/repos/${slug}/issues/${prNumber}/comments?per_page=100&page=${page}`
    );
    if (!comments || comments.length === 0) break;
    const found = comments.find((c) => c.body?.includes(MARKER));
    if (found) {
      const m = found.body.match(/<!-- fingerprint:([a-f0-9]+) -->/);
      return { id: found.id, fingerprint: m ? m[1] : null };
    }
    if (comments.length < 100) break;
    page++;
  }
  return null;
}

/** Create or update the single guard comment. */
export async function upsertComment(prNumber, body) {
  if (!prNumber) return;
  const slug = repoSlug();
  const existing = await findExistingComment(prNumber);
  if (existing) {
    await ghApi("PATCH", `/repos/${slug}/issues/comments/${existing.id}`, {
      body,
    });
  } else {
    await ghApi("POST", `/repos/${slug}/issues/${prNumber}/comments`, { body });
  }
}

export { MARKER };
