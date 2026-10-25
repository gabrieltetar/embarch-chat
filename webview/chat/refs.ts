// What the desk knows about the issues and PRs a chat may touch (embarch-chat
// decision 87): a step that names only a key or a number — a status move, a
// `gh pr merge 36` — takes its title and its link from here, but only once
// its repo is known: the one the command or gh's output names, else the
// chat's folder's own GitHub repo (`setChatRepo`, from the host). The host
// hands the index over with `setRefs`; until it does the index is empty and
// a step shows what it carries itself. Pure, so the node tests run it.

export interface RefIssue {
  key: string;
  title: string;
  state?: string;
  url: string;
}

export interface RefPr {
  repo: string;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  url: string;
  branch?: string;
  /** The Linear issues it names. */
  keys: string[];
}

let issues = new Map<string, RefIssue>();
let prs: RefPr[] = [];
let version = 0;
let chatRepoNow: string | null = null;

/** The desk's index, whole each time; null empties it. */
export function setRefs(r: { issues: RefIssue[]; prs: RefPr[] } | null): void {
  issues = new Map((r?.issues ?? []).map((i) => [i.key.toUpperCase(), i]));
  prs = r?.prs ?? [];
  version++;
}

/** Bumped by each `setRefs`: what was read from the index before is stale. */
export function refsVersion(): number {
  return version;
}

/**
 * The GitHub repo the chat's folder is a clone of, `owner/repo` (the host
 * reads it from the folder's git remote, github.com only): what a `gh pr`
 * run there acts on when it names no repo, and what a bare "PR #36" in
 * Claude's prose means (decision 88). Null when it has none, or more than
 * one gh could pick.
 */
export function setChatRepo(repo: string | null | undefined): void {
  chatRepoNow = repo ?? null;
}

export function chatRepo(): string | null {
  return chatRepoNow;
}

/** Whether the host has handed over an index with anything in it. */
export function hasRefs(): boolean {
  return issues.size > 0 || prs.length > 0;
}

/** An issue by its key, in any case. */
export function issueRef(key: string): RefIssue | null {
  return issues.get(key.trim().toUpperCase()) ?? null;
}

/**
 * A PR by its number in its repo. Never by the number alone: that a number
 * is unique in the desk's index does not make it the PR a step acted on —
 * a link to the wrong PR is worse than none.
 */
export function prRef(number: number, repo: string): RefPr | null {
  const r = repo.toLowerCase();
  return prs.find((p) => p.number === number && p.repo.toLowerCase() === r) ?? null;
}
