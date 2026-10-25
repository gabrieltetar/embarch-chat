// What the desk knows about the issues and PRs a chat may touch (embarch-chat
// decision 87): a step that names only a key or a number — a status move, a
// `gh pr merge 36` — takes its title and its link from here. The host hands
// the index over with `setRefs`; until it does the index is empty and a step
// shows what it carries itself. Pure, so the node tests run it.

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

/** The desk's index, whole each time; null empties it. */
export function setRefs(r: { issues: RefIssue[]; prs: RefPr[] } | null): void {
  issues = new Map((r?.issues ?? []).map((i) => [i.key.toUpperCase(), i]));
  prs = r?.prs ?? [];
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
 * A PR by its number, in `owner/repo` when the step names one. Without a
 * repo only a number no two repos share answers — a link to the wrong PR is
 * worse than none.
 */
export function prRef(number: number, repo?: string): RefPr | null {
  const r = repo?.toLowerCase();
  const hits = prs.filter((p) => p.number === number && (!r || p.repo.toLowerCase() === r));
  return hits.length === 1 ? hits[0] : null;
}
