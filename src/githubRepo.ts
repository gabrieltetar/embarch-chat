// The GitHub repo a chat's folder is a clone of (decision 88): what a bare
// "PR #36" in Claude's prose or the owner's draft means — never what a `gh`
// step naming no repo acted on, as where its shell was is not known (87).
// Read from the folder's git config on disk — a few stats and, when it
// changed, one small file, never a `git` run on each snapshot or cards
// call — and picked as gh picks it with no terminal to ask on: the remote
// `gh repo set-default` marked, else the first of upstream, github, origin,
// then the rest by name.
// github.com only: another host's repo is no link of ours. None, or one that
// cannot be read, is null, and a PR named without its repo stays unlinked.
// It runs on the extension host, so a file it reads must not hold it up: a
// FIFO, a device or a file past 64 KB where `.git`, `commondir` or the
// config should be is read as none — a config's first 64 KB could pick
// another remote than the whole, as a late `[remote "upstream"]` would.

import * as fs from "fs";
import * as path from "path";

export interface Remote {
  name: string;
  url: string;
  /** gh's `remote.<name>.gh-resolved`: `base`, or the `owner/repo` it stands for. */
  resolved?: string;
}

/** `owner/repo` of a github.com remote URL — https, ssh or scp-like — else null. */
export function githubRepoOfUrl(url: string): string | null {
  const u = url.trim();
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(u);
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(u);
  const m = full ?? scp;
  if (!m || m[1].toLowerCase() !== "github.com") return null;
  return m[2];
}

/** The remotes of a git config file's text. */
export function parseRemotes(config: string): Remote[] {
  const out: Remote[] = [];
  let cur: Remote | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[\s*([\w.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (sec) {
      cur = sec[1].toLowerCase() === "remote" && sec[2] !== undefined ? { name: sec[2], url: "" } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].replace(/^"(.*)"$/, "$1").trim();
    if (key === "url" && !cur.url) cur.url = value;
    else if (key === "gh-resolved") cur.resolved = value;
  }
  return out.filter((r) => r.url);
}

const RANK: Record<string, number> = { upstream: 3, github: 2, origin: 1 };

/** The repo gh acts on with no terminal to ask on, among the remotes: github.com's only. */
export function pickGithubRepo(remotes: Remote[]): string | null {
  const marked = remotes.find((r) => r.resolved);
  if (marked) {
    const named = marked.resolved !== "base" && /^[\w.-]+\/[\w.-]+$/.test(marked.resolved ?? "") ? marked.resolved! : null;
    return named && githubRepoOfUrl(marked.url) ? named : githubRepoOfUrl(marked.url);
  }
  const sorted = [...remotes].sort((a, b) => (RANK[b.name] ?? 0) - (RANK[a.name] ?? 0) || a.name.localeCompare(b.name));
  for (const r of sorted) {
    const repo = githubRepoOfUrl(r.url);
    if (repo) return repo;
  }
  return null;
}

/** The most a git file is read for: a config, a worktree's `.git` file, a `commondir`. */
const CAP = 64 * 1024;

/**
 * A regular file's text and its stat, when it is at most `CAP` bytes; null
 * for anything else — a FIFO, a device, a file past `CAP`, whose part is not
 * the file. Opened without blocking and checked on the open file, so a FIFO
 * swapped in after a stat cannot hang the extension host on its read.
 */
function readSmall(file: string): { text: string; st: fs.Stats } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > CAP) return null;
    // A byte past the most it takes: a file grown past it since the stat is cut too.
    const buf = Buffer.alloc(CAP + 1);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return got > CAP ? null : { text: buf.subarray(0, got).toString("utf8"), st };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The config file of the repo `cwd` is in: a worktree's `.git` file points at its git dir, whose `commondir` holds it. */
function configOf(cwd: string): string | null {
  let d = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotgit = path.join(d, ".git");
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotgit);
    } catch {
      /* not here */
    }
    if (st?.isDirectory()) return path.join(dotgit, "config");
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readSmall(dotgit)?.text ?? "");
      if (!m) return null;
      const gitdir = path.resolve(d, m[1].trim());
      // None, or not a file: a plain git dir.
      const common = readSmall(path.join(gitdir, "commondir"))?.text.trim();
      return path.join(common ? path.resolve(gitdir, common) : gitdir, "config");
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** Each config file's repo, as of its last change. */
const read = new Map<string, { mtimeMs: number; size: number; repo: string | null }>();

/** The GitHub repo of the folder `cwd`, `owner/repo`, or null. */
export function githubRepo(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const config = configOf(cwd);
    if (!config) return null;
    const st = fs.statSync(config);
    if (!st.isFile()) return null;
    const hit = read.get(config);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.repo;
    const got = readSmall(config);
    if (!got) return null;
    const repo = pickGithubRepo(parseRemotes(got.text));
    read.set(config, { mtimeMs: got.st.mtimeMs, size: got.st.size, repo });
    return repo;
  } catch {
    return null;
  }
}
