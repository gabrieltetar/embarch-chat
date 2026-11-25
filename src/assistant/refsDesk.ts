// The desk's own source for the linker (decisions 88, 112): its issues and PRs,
// mirrored by the host as the reference index. An issue's line carries the
// PRs that name it; a PR the draft matches whose issue the index has is
// shown on that issue's line, first among its PRs. Issues and PRs are two
// kinds in one scoring pool, as 88 scores them. Pure, so the node tests run it.

import type { IndexIssue, IndexPr, RefIndex } from "../desk/client";
import { RefEntry, RefSource, clipTitle, significantWords } from "./refsBase";

/** PRs shown on one issue's line. */
const PRS_PER_LINE = 2;
const POOL = "desk";

/** A PR as the prompt names it: `PR owner/repo#36 "Widget" merged`. */
export function prLine(p: { repo: string; number: number; title?: string; state: string; draft?: boolean }): string {
  const state = p.draft && p.state === "open" ? "draft" : p.state;
  return `PR ${p.repo}#${p.number}${p.title?.trim() ? ` "${clipTitle(p.title)}"` : ""} ${state}`;
}

function issueLine(i: IndexIssue): string {
  return `${i.key} "${clipTitle(i.title)}" ${i.state}`.trimEnd();
}

const prId = (p: { repo: string; number: number }) => `${p.repo.toLowerCase()}#${p.number}`;
const title = (t: string | undefined) => (t && clipTitle(t) ? ` "${clipTitle(t)}"` : "");
const prText = (p: IndexPr) => `PR ${p.repo}#${p.number}${title(p.title)}`;

interface Prepared {
  issues: Map<string, IndexIssue>;
  /** The PRs that name each issue key, newest first. */
  prsOf: Map<string, IndexPr[]>;
  issueEntries: Map<string, RefEntry>;
  prEntries: Map<string, RefEntry>;
  entries: RefEntry[];
  index: RefIndex;
}

/** The index is replaced whole when it changes, so its preparation is kept per object. */
const prepared = new WeakMap<RefIndex, Prepared>();

/** An issue's line with the PRs on it: those given first, then the issue's own newest. */
function issueEntry(idx: Prepared, i: IndexIssue, first?: IndexPr): RefEntry {
  const K = i.key.toUpperCase();
  const prs = [...(first ? [first] : []), ...(idx.prsOf.get(K) ?? []).filter((p) => !first || prId(p) !== prId(first))].slice(0, PRS_PER_LINE);
  return {
    kind: "issue",
    key: i.key,
    words: significantWords(i.title),
    names: [],
    line: [issueLine(i), ...prs.map(prLine)].join(" · "),
    // The PR first, as `PR owner/repo#36 "Widget" (ABC-154)`; the issue first when the phrase says issue, ticket or card, or the line has no PR.
    text(find) {
      const pr = prs[0];
      if (!pr || /\b(?:issues?|tickets?|cards?)\b/i.test(find)) return `${i.key}${title(i.title)}${pr ? ` (${prText(pr)})` : ""}`;
      return `${prText(pr)} (${i.key})`;
    },
    titles: [i.title, ...prs.map((p) => p.title)],
    pool: POOL,
    covers: prs.map((p) => `pr:${prId(p)}`),
    issue: i,
    prs,
  };
}

function prepare(index: RefIndex): Prepared {
  const got = prepared.get(index);
  if (got) return got;
  const idx: Prepared = { issues: new Map(), prsOf: new Map(), issueEntries: new Map(), prEntries: new Map(), entries: [], index };
  for (const i of index.issues) idx.issues.set(i.key.toUpperCase(), i);
  for (const p of index.prs) {
    for (const k of p.keys ?? []) {
      const K = k.toUpperCase();
      idx.prsOf.set(K, [...(idx.prsOf.get(K) ?? []), p]);
    }
  }
  for (const i of index.issues) {
    const e = issueEntry(idx, i);
    idx.issueEntries.set(i.key.toUpperCase(), e);
    idx.entries.push(e);
  }
  for (const p of index.prs) {
    const e: RefEntry = {
      kind: "pr",
      key: prId(p),
      words: significantWords(p.title),
      names: [],
      line: prLine(p),
      text: () => prText(p),
      titles: [p.title],
      pool: POOL,
      prs: [p],
      lead() {
        const issue = (p.keys ?? []).map((k) => idx.issues.get(k.toUpperCase())).find(Boolean);
        return issue ? issueEntry(idx, issue, p) : null;
      },
    };
    idx.prEntries.set(prId(p), e);
    idx.entries.push(e);
  }
  prepared.set(index, idx);
  return idx;
}

export interface MatchOpts {
  /** The chat's own work item: its card is already in the prompt, so its words find nothing. */
  ownKey?: string;
  ownPrs?: Array<{ repo: string; number: number }>;
  /** The chat's folder's GitHub repo (githubRepo.ts): "PR 36" with no repo written is that repo's. */
  repo?: string | null;
}

/**
 * The entries the draft names itself, in its order: keys, `owner/repo#N`
 * and a PR's link, and "PR 36" or "pull request #36" in the chat's own repo.
 * A bare `#36` is none — "step #3" is no PR (as in prose, refprose.ts).
 */
function named(draft: string, idx: Prepared, opts: MatchOpts): RefEntry[] {
  const hits: Array<{ at: number; e: RefEntry }> = [];
  const pr = (repo: string, n: string): RefEntry | undefined => idx.prEntries.get(`${repo.toLowerCase()}#${Number(n)}`);
  for (const m of draft.matchAll(/(?<![\w/.-])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?![\w-])/g)) {
    const e = idx.issueEntries.get(m[1].toUpperCase());
    if (e) hits.push({ at: m.index!, e });
  }
  for (const m of draft.matchAll(/(?<![\w.-])([\w.-]+\/[\w.-]+)#(\d{1,7})\b|github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})\b/g)) {
    const [repo, n] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    const e = pr(repo, n);
    if (e) hits.push({ at: m.index!, e });
  }
  const own = opts.repo?.toLowerCase();
  for (const m of own ? draft.matchAll(/(?<![\w/.#-])(?:PR|pull request) ?#?(\d{1,7})(?![\w-])/gi) : []) {
    const e = pr(own!, m[1]);
    if (e) hits.push({ at: m.index!, e });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.e);
}

/** The desk's issues and PRs as a source; null with no index or nothing in it. Not gated. */
export function deskSource(index: RefIndex | null, opts: MatchOpts = {}): RefSource | null {
  if (!index || (!index.issues.length && !index.prs.length)) return null;
  const idx = prepare(index);
  const own = new Set((opts.ownPrs ?? []).map(prId));
  const ownKey = opts.ownKey?.toUpperCase();
  return {
    entries: idx.entries,
    find: (draft) => named(draft, idx, opts),
    skip: (e) => (e.kind === "issue" ? e.key.toUpperCase() === ownKey : !!e.prs && (own.has(prId(e.prs[0])) || (!!ownKey && e.prs[0].keys.some((k) => k.toUpperCase() === ownKey)))),
    boost(draft) {
      const prWord = /\b(?:PRs?|pull requests?)\b/i.test(draft);
      const issueWord = /\b(?:issues?|tickets?)\b/i.test(draft);
      return (e) => ((prWord && e.kind === "pr") || (issueWord && e.kind === "issue") ? 1.25 : 1);
    },
  };
}
