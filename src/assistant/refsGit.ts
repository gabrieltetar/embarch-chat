// The linker's branch and worktree source (decision 113): the local and
// `origin` branches and the worktrees of the chat folder's main clone, read
// from git. Gated: offered by words only when the draft carries a cue word; a
// branch or path the draft names exactly is offered with none. The reader
// asks git at most once a minute per folder, before a cards call. The parsing
// and the source are pure, so the node tests run them.

import type { IndexPr, RefIndex } from "../desk/client";
import { git, listWorktrees, mainRepo } from "../deskService";
import { RefEntry, RefSource, clipTitle, significantWords } from "./refsBase";

/** Newest branches read (embarch-promptu contract 15.2). */
export const BRANCHES_MAX = 300;
/** A git read is reused this long. */
export const GIT_REFRESH_MS = 60_000;
/** A branch name or path longer than this, or one with an unseen or `<`/`>` character, is not offered rather than offered cut. */
const NAME_CAP = 200;

/** The words that open the gate (whole word, any case). */
export const GIT_CUES = ["branch", "worktree", "checkout", "clone", "rebase", "merge"];

export interface GitSnap {
  /** Newest first, each name once whether local, remote or both. */
  branches: string[];
  worktrees: Array<{ path: string; branch: string | null }>;
  /** The chat's own: left out. */
  ownBranch: string;
  ownTop: string;
}

/** `git for-each-ref --format=%(refname)` over local and `origin` heads: names, newest first, a remote twin once, `origin/HEAD` none. */
export function parseBranches(out: string): string[] {
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const ref = line.trim();
    const name = ref.startsWith("refs/heads/") ? ref.slice(11) : ref.startsWith("refs/remotes/origin/") ? ref.slice(20) : "";
    if (name && name !== "HEAD") seen.add(name);
  }
  return [...seen];
}

/** `git worktree list --porcelain`: each worktree's path and branch (null when detached or bare). */
export function parseWorktrees(out: string): GitSnap["worktrees"] {
  const list: GitSnap["worktrees"] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) list.push({ path: line.slice(9), branch: null });
    else if (line.startsWith("branch ") && list.length) list[list.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return list;
}

/** A name or path exactly as git has it, or null when writing it would change it. */
const exact = (s: string): string | null => (s && clipTitle(s, NAME_CAP) === s ? s : null);

const slug = (s: string) => s.split(/[/_\-.]+/).join(" ");

/** The PR on a branch: the chat's own repo's first, else the index's first. */
function prOn(index: RefIndex | null, branch: string, repo: string | undefined): IndexPr | undefined {
  const hits = (index?.prs ?? []).filter((p) => p.branch === branch);
  return hits.find((p) => repo && p.repo.toLowerCase() === repo.toLowerCase()) ?? hits[0];
}

/** The branches and worktrees as a source; null with none. Gated. */
export function gitSource(snap: GitSnap | null, index: RefIndex | null, opts: { repo?: string | null } = {}): RefSource | null {
  if (!snap) return null;
  const entries: RefEntry[] = [];
  for (const raw of snap.branches) {
    const name = exact(raw);
    if (!name || raw === snap.ownBranch) continue;
    const pr = prOn(index, raw, opts.repo ?? undefined);
    const text = `branch ${name}${pr ? ` (PR ${pr.repo}#${pr.number})` : ""}`;
    entries.push({ kind: "branch", key: raw, words: significantWords(slug(raw)), names: [raw], line: text, text: () => text, titles: [slug(raw)] });
  }
  for (const w of snap.worktrees) {
    const path = exact(w.path);
    const branch = w.branch === null ? "detached" : exact(w.branch);
    if (!path || !branch || w.path === snap.ownTop) continue;
    const text = `worktree ${path} (${w.branch === null ? "detached" : `branch ${branch}`})`;
    const base = w.path.split("/").filter(Boolean).pop() ?? "";
    entries.push({ kind: "worktree", key: w.path, words: significantWords(`${slug(base)} ${slug(w.branch ?? "")}`), names: [w.path], line: text, text: () => text, titles: [slug(base)] });
  }
  return entries.length ? { entries, cues: GIT_CUES } : null;
}

interface Read {
  at: number;
  snap: GitSnap | null;
  loud: boolean;
}

/** Reads the chat folder's git, at most once a `GIT_REFRESH_MS` per folder; a failure leaves the kind empty and logs once. */
export class GitRefs {
  private reads = new Map<string, Read>();
  private busy = new Map<string, Promise<void>>();

  /** The last read for a folder; null before the first or after a failed one. */
  get(folder: string): GitSnap | null {
    return this.reads.get(folder)?.snap ?? null;
  }

  /** Reads again when the last read is over a minute old; calls in the meantime wait for the one running. */
  refresh(folder: string, log: (s: string) => void, now = Date.now()): Promise<void> {
    if (!folder) return Promise.resolve();
    const last = this.reads.get(folder);
    if (last && now - last.at < GIT_REFRESH_MS) return Promise.resolve();
    const running = this.busy.get(folder);
    if (running) return running;
    const p = this.read(folder, log, now).finally(() => this.busy.delete(folder));
    this.busy.set(folder, p);
    return p;
  }

  private async read(folder: string, log: (s: string) => void, now: number): Promise<void> {
    const main = await mainRepo(folder);
    const [refs, trees, ownBranch, ownTop] = await Promise.all([
      git(main, ["for-each-ref", "--sort=-committerdate", `--count=${BRANCHES_MAX}`, "--format=%(refname)", "refs/heads", "refs/remotes/origin"]),
      listWorktrees(main),
      git(folder, ["branch", "--show-current"]),
      git(folder, ["rev-parse", "--show-toplevel"]),
    ]);
    const prev = this.reads.get(folder);
    if (!refs && !trees) {
      if (!prev?.loud) log(`references: git could not be read in ${folder}; no branches or worktrees are offered`);
      this.reads.set(folder, { at: now, snap: null, loud: true });
      return;
    }
    this.reads.set(folder, { at: now, snap: { branches: parseBranches(refs), worktrees: parseWorktrees(trees), ownBranch, ownTop }, loud: false });
  }
}
