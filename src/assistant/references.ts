// The desk's references for the cards call (decision 88). Before the call
// the draft is matched here, locally, against the window's desk's reference
// index (its issues and PRs, mirrored by the host): the draft's significant
// words against their titles, plus any key or PR number it already names.
// The best few go into the cards prompt's <desk_references> block — at most
// 8 lines, about 600 tokens, inside decision 27's 1–3K — so "the widget PR"
// can become the PR itself in the same single call: no extra wave, and no
// network on a keystroke (26). Ghost text never gets the block (26's
// latency). Pure, so the node tests run it.

import type { IndexIssue, IndexPr, RefIndex } from "../desk/client";

/** At most this many lines in the block. */
export const REFS_LINES = 8;
/** About 600 tokens, at four characters a token. */
export const REFS_CHARS = 2400;
const TITLE_CAP = 90;
/** PRs shown on one issue's line. */
const PRS_PER_LINE = 2;
/** PRs a bare number names when repos share it. */
const SAME_NUMBER = 3;

/** Function words and the words a request is written in: never what tells one title from another. */
const STOP = new Set(
  `a an the and or but nor so yet for of to in on at by with from into onto over under about after before than then
  this that these those it its is are was were be been being am do does did done doing have has had having
  i me my we us our you your he she they them their his her
  can could would should will shall may might must need needs let lets please just like same similar also too
  what when where which who whom whose why how all any some each every both more most other such only own very
  not no yes now here there again once still even ever already
  make made get got put set use used using want see look go went way thing things stuff something
  include add fix create update remove implement write check run try keep follow start finish change move
  pr prs pull request requests issue issues ticket tickets linear github card item work`
    .split(/\s+/)
    .filter(Boolean),
);

/** A word as titles and drafts are compared: lower case, no possessive, a plural as its singular. */
function norm(w: string): string {
  let s = w.toLowerCase().replace(/['’]s$/, "").replace(/['’]/g, "");
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** The significant words of a text, once each. */
export function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9'’]+/)) {
    const w = norm(raw);
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

interface Doc {
  issue?: IndexIssue;
  pr?: IndexPr;
  words: Set<string>;
  /** Its place in the index: issues newest first, then PRs newest first per repo. */
  order: number;
}

interface Prepared {
  docs: Doc[];
  /** How many titles hold each word: a word most titles hold tells little. */
  df: Map<string, number>;
  issues: Map<string, IndexIssue>;
  /** The PRs that name each issue key, newest first. */
  prsOf: Map<string, IndexPr[]>;
}

/** The index is replaced whole when it changes, so its preparation is kept per object. */
const prepared = new WeakMap<RefIndex, Prepared>();

function prepare(index: RefIndex): Prepared {
  const got = prepared.get(index);
  if (got) return got;
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  const issues = new Map<string, IndexIssue>();
  const prsOf = new Map<string, IndexPr[]>();
  for (const i of index.issues) {
    issues.set(i.key.toUpperCase(), i);
    docs.push({ issue: i, words: significantWords(i.title), order: docs.length });
  }
  for (const p of index.prs) {
    docs.push({ pr: p, words: significantWords(p.title), order: docs.length });
    for (const k of p.keys ?? []) {
      const K = k.toUpperCase();
      prsOf.set(K, [...(prsOf.get(K) ?? []), p]);
    }
  }
  for (const d of docs) for (const w of d.words) df.set(w, (df.get(w) ?? 0) + 1);
  const p = { docs, df, issues, prsOf };
  prepared.set(index, p);
  return p;
}

function clipTitle(t: string): string {
  const s = t.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return s.length <= TITLE_CAP ? s : s.slice(0, TITLE_CAP - 1) + "…";
}

/** A PR as the prompt names it: `PR owner/repo#36 "Widget" merged`. */
export function prLine(p: { repo: string; number: number; title?: string; state: string; draft?: boolean }): string {
  const state = p.draft && p.state === "open" ? "draft" : p.state;
  return `PR ${p.repo}#${p.number}${p.title?.trim() ? ` "${clipTitle(p.title)}"` : ""} ${state}`;
}

function issueLine(i: IndexIssue): string {
  return `${i.key} "${clipTitle(i.title)}" ${i.state}`.trimEnd();
}

const prId = (p: { repo: string; number: number }) => `${p.repo.toLowerCase()}#${p.number}`;

export interface MatchOpts {
  /** The chat's own work item: its card is already in the prompt, so its words find nothing. */
  ownKey?: string;
  ownPrs?: Array<{ repo: string; number: number }>;
}

type Cand = { issue: IndexIssue } | { pr: IndexPr };

/** The references the draft names itself, in its order: keys, `owner/repo#N`, `#N` and `PR N`. */
function named(draft: string, idx: Prepared, index: RefIndex): Cand[] {
  const hits: Array<{ at: number; c: Cand[] }> = [];
  for (const m of draft.matchAll(/(?<![\w/.-])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?![\w-])/g)) {
    const i = idx.issues.get(m[1].toUpperCase());
    if (i) hits.push({ at: m.index!, c: [{ issue: i }] });
  }
  for (const m of draft.matchAll(/(?<![\w.-])([\w.-]+\/[\w.-]+)#(\d{1,7})\b|github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})\b/g)) {
    const [repo, n] = m[1] ? [m[1], m[2]] : [m[3], m[4]];
    const p = index.prs.find((x) => x.number === Number(n) && x.repo.toLowerCase() === repo.toLowerCase());
    if (p) hits.push({ at: m.index!, c: [{ pr: p }] });
  }
  for (const m of draft.matchAll(/(?<![\w/.&-])#(\d{1,7})\b|\b(?:PR|pull request)\s*#?(\d{1,7})\b/gi)) {
    const n = Number(m[1] ?? m[2]);
    const same = index.prs.filter((x) => x.number === n).slice(0, SAME_NUMBER);
    if (same.length) hits.push({ at: m.index!, c: same.map((pr) => ({ pr })) });
  }
  return hits.sort((a, b) => a.at - b.at).flatMap((h) => h.c);
}

/**
 * The draft's significant words against every title: each word scores by
 * how few titles hold it (log(1 + N/df)). A title counts when it shares a
 * word few titles have, two words, or all of its own; then those within
 * 40 % of the best, best first, newest first among equals. "PR" in the
 * draft favours PRs, "issue" or "ticket" issues.
 */
function byWords(draft: string, idx: Prepared, opts: MatchOpts): Cand[] {
  const want = significantWords(draft);
  if (!want.size) return [];
  const n = idx.docs.length;
  const rare = Math.max(2, Math.ceil(n * 0.03));
  const prWord = /\b(?:PRs?|pull requests?)\b/i.test(draft);
  const issueWord = /\b(?:issues?|tickets?)\b/i.test(draft);
  const own = new Set((opts.ownPrs ?? []).map(prId));
  const ownKey = opts.ownKey?.toUpperCase();
  const scored: Array<{ d: Doc; score: number }> = [];
  for (const d of idx.docs) {
    if (d.issue && d.issue.key.toUpperCase() === ownKey) continue;
    if (d.pr && (own.has(prId(d.pr)) || (ownKey && d.pr.keys.some((k) => k.toUpperCase() === ownKey)))) continue;
    let score = 0;
    let shared = 0;
    let distinct = false;
    for (const w of d.words) {
      if (!want.has(w)) continue;
      const df = idx.df.get(w) ?? 1;
      score += Math.log(1 + n / df);
      shared++;
      if (df <= rare) distinct = true;
    }
    if (!shared || !(distinct || shared >= 2 || shared === d.words.size)) continue;
    if ((prWord && d.pr) || (issueWord && d.issue)) score *= 1.25;
    scored.push({ d, score });
  }
  if (!scored.length) return [];
  const best = Math.max(...scored.map((s) => s.score));
  return scored
    .filter((s) => s.score >= best * 0.4)
    .sort((a, b) => b.score - a.score || a.d.order - b.d.order)
    .map(({ d }) => (d.issue ? { issue: d.issue } : { pr: d.pr! }));
}

/**
 * The lines of the <desk_references> block for a draft: what it names
 * first, then what its words match, each an issue with the PRs that name
 * it — `ABC-154 "Create the Widget" Done · PR owner/repo#36 "Widget"
 * merged` — or a PR alone; each issue and PR once, at most REFS_LINES lines
 * and REFS_CHARS characters.
 */
export function deskReferences(index: RefIndex | null, draft: string, opts: MatchOpts = {}): string[] {
  if (!index || (!index.issues.length && !index.prs.length) || !draft.trim()) return [];
  const idx = prepare(index);
  const shownIssues = new Set<string>();
  const shownPrs = new Set<string>();
  const lines: string[] = [];
  let chars = 0;
  const add = (line: string): boolean => {
    if (lines.length >= REFS_LINES || chars + line.length + 1 > REFS_CHARS) return false;
    lines.push(line);
    chars += line.length + 1;
    return true;
  };
  for (const c of [...named(draft, idx, index), ...byWords(draft, idx, opts)]) {
    if (lines.length >= REFS_LINES) break;
    // A PR that names an issue the index has is shown on that issue's line, first among its PRs.
    const pr = "pr" in c ? c.pr : null;
    const issue = "issue" in c ? c.issue : (pr?.keys ?? []).map((k) => idx.issues.get(k.toUpperCase())).find(Boolean);
    if (issue && !shownIssues.has(issue.key.toUpperCase())) {
      const prs = [...(pr ? [pr] : []), ...(idx.prsOf.get(issue.key.toUpperCase()) ?? []).filter((p) => !pr || prId(p) !== prId(pr))].slice(0, PRS_PER_LINE);
      if (!add([issueLine(issue), ...prs.map(prLine)].join(" · "))) continue;
      shownIssues.add(issue.key.toUpperCase());
      for (const p of prs) shownPrs.add(prId(p));
    } else if (pr && !shownPrs.has(prId(pr))) {
      if (add(prLine(pr))) shownPrs.add(prId(pr));
    }
  }
  return lines;
}
