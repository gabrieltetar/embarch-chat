// The linker for the cards call (decisions 88, 112). Before the call the draft
// is matched here, locally, against every source's entries (the desk's issues
// and PRs first, refsDesk.ts; each later kind is one more source file): the
// entries the draft names exactly, then those whose words match the draft's
// significant words, scored among their own kind and merged best first. The
// best go into the cards prompt's <references> block — at most REFS_LINES
// lines and REFS_CHARS characters, REFS_PER_KIND lines of one kind before the
// best of the rest fill it, about 900 tokens, inside decision 27's 1–3K — so
// "the widget PR" can become the PR itself in the same single call: no extra
// wave, and no network on a keystroke (26). Ghost text never gets the block
// (26's latency).
//
// A title or a name is anyone's to write, so none reaches the draft through
// Haiku: each line has an id, Haiku answers a reference card by that id and the
// vague phrase it replaces, and the replacement is written here by the entry
// itself (`text`), clipped and cleaned. A line in the block or the draft
// carries no `<`, `>`, line break or character that shows nothing. Pure, so
// the node tests run it.

import type { RefIndex } from "../desk/client";
import { RefEntry, RefSource, clipTitle as clip, significantWords } from "./refsBase";
import { MatchOpts, deskSource } from "./refsDesk";

export { clipTitle, significantWords } from "./refsBase";
export type { RefEntry, RefSource } from "./refsBase";
export type { MatchOpts } from "./refsDesk";

/** At most this many lines in the block. */
export const REFS_LINES = 12;
/** About 900 tokens, at four characters a token. */
export const REFS_CHARS = 3600;
/** Lines of one kind before the best of the rest fill the block. */
export const REFS_PER_KIND = 4;
/** The longest vague phrase a reference card replaces. */
const FIND_CAP = 80;

/** What the prompt's rule says of a kind: the plural as the block's header names it, the singular as the draft points at it, and an example line. */
interface KindInfo {
  plural: string[];
  singular: string[];
  example: { line: string; draft: string; find: string; title: string; why: string };
}

/** One row per kind; a kind with none is named by its tag. Each later kind adds its row (decision 112). */
const KINDS: Record<string, KindInfo> = {
  issue: {
    plural: ["issues", "PRs"],
    singular: ["an issue", "a PR"],
    example: {
      line: 'ABC-12 "Make the parser" Done · PR owner/repo#7 "Parser" merged',
      draft: "test it like the parser PR did",
      find: "the parser PR",
      title: "Name PR owner/repo#7",
      why: "The desk knows the parser PR",
    },
  },
  pr: {
    plural: ["PRs"],
    singular: ["a PR"],
    example: {
      line: 'PR owner/repo#7 "Parser" merged',
      draft: "test it like the parser PR did",
      find: "the parser PR",
      title: "Name PR owner/repo#7",
      why: "The desk knows the parser PR",
    },
  },
  branch: {
    plural: ["branches"],
    singular: ["a branch"],
    example: {
      line: "branch fix/abc-9-fan-curve",
      draft: "rebase it on the fan branch",
      find: "the fan branch",
      title: "Name branch fix/abc-9-fan-curve",
      why: "The repo has the branch fix/abc-9-fan-curve",
    },
  },
  worktree: {
    plural: ["worktrees"],
    singular: ["a worktree"],
    example: {
      line: "worktree /home/me/repo-fan (branch fix/abc-9-fan-curve)",
      draft: "finish it in the fan worktree",
      find: "the fan worktree",
      title: "Name worktree /home/me/repo-fan",
      why: "The repo has the worktree /home/me/repo-fan",
    },
  },
};

const kindInfo = (kind: string): KindInfo => KINDS[kind] ?? { plural: [`${kind}s`], singular: [`a ${kind}`], example: KINDS.issue.example };

/** The kinds a block holds, in the order its lines first show them. */
export function kindsOf(refs: Array<{ kind: string }>): string[] {
  return [...new Set(refs.map((r) => r.kind))];
}

const listed = (xs: string[], last: string): string => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${last} ${xs[xs.length - 1]}`);
const unique = (xs: string[]) => [...new Set(xs)];

/** What the kinds in a block are called, plural (the block's header, the rule): "issues and PRs". */
export function kindNouns(refs: Array<{ kind: string }>): string {
  return listed(unique(kindsOf(refs).flatMap((k) => kindInfo(k).plural)), "and");
}

/** What the draft may point at, singular: "an issue or a PR". */
export function kindPointers(refs: Array<{ kind: string }>): string {
  return listed(unique(kindsOf(refs).flatMap((k) => kindInfo(k).singular)), "or");
}

/** The rule's example: the first kind present with its line, the draft and the card it gets. */
export function kindExample(refs: Array<{ kind: string }>): KindInfo["example"] & { kind: string } {
  const kind = kindsOf(refs)[0];
  return { kind, ...kindInfo(kind).example };
}

/** One line of the <references> block. */
export interface DeskRef {
  /** Its id in the block, `r1`…: a reference card names its line by it. */
  id: string;
  kind: string;
  /** The line as the prompt shows it, after `[id] <kind>: `. */
  line: string;
  entry: RefEntry;
  /** The desk's kinds: the issue the line shows, and the PRs on it, the one the draft matched first. */
  issue?: RefEntry["issue"];
  prs: NonNullable<RefEntry["prs"]>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(s)}(?![\\p{L}\\p{N}_])`, "iu");

const idOf = (e: RefEntry) => `${e.kind}:${e.key.toLowerCase()}`;

interface Pool {
  n: number;
  /** How many entries of the pool hold each word: a word most hold tells little. */
  df: Map<string, number>;
}
/** A source's entries are replaced whole when it changes, so their counts are kept per array. */
const pools = new WeakMap<RefEntry[], Map<string, Pool>>();

function poolsOf(entries: RefEntry[]): Map<string, Pool> {
  const got = pools.get(entries);
  if (got) return got;
  const out = new Map<string, Pool>();
  for (const e of entries) {
    const key = e.pool ?? e.kind;
    const p = out.get(key) ?? { n: 0, df: new Map() };
    p.n++;
    for (const w of e.words) p.df.set(w, (p.df.get(w) ?? 0) + 1);
    out.set(key, p);
  }
  pools.set(entries, out);
  return out;
}

interface Scored {
  e: RefEntry;
  score: number;
  order: number;
}

/**
 * The draft's significant words against a source's entries: each word scores
 * by how few entries of its pool (its kind) hold it (log(1 + N/df)). An entry
 * counts when it shares a word few hold, two words, or all of its own; then
 * those within 40 % of the pool's best, best first, newest first among equals.
 */
function byWords(src: RefSource, draft: string, want: Set<string>, base: number): Scored[] {
  const stats = poolsOf(src.entries);
  const boost = src.boost?.(draft);
  const byPool = new Map<string, Scored[]>();
  src.entries.forEach((e, i) => {
    if (src.skip?.(e)) return;
    const pool = stats.get(e.pool ?? e.kind)!;
    const rare = Math.max(2, Math.ceil(pool.n * 0.03));
    let score = 0;
    let shared = 0;
    let distinct = false;
    for (const w of e.words) {
      if (!want.has(w)) continue;
      const df = pool.df.get(w) ?? 1;
      score += Math.log(1 + pool.n / df);
      shared++;
      if (df <= rare) distinct = true;
    }
    if (!shared || !(distinct || shared >= 2 || shared === e.words.size)) return;
    if (boost) score *= boost(e);
    const key = e.pool ?? e.kind;
    byPool.set(key, [...(byPool.get(key) ?? []), { e, score, order: base + i }]);
  });
  const out: Scored[] = [];
  for (const list of byPool.values()) {
    const best = Math.max(...list.map((s) => s.score));
    out.push(...list.filter((s) => s.score >= best * 0.4));
  }
  return out;
}

/** The entries a draft names by an exact string of theirs, in the draft's order. */
function byNames(src: RefSource, lower: string, draft: string): RefEntry[] {
  const hits: Array<{ at: number; e: RefEntry }> = [];
  for (const e of src.entries) {
    for (const n of e.names) {
      if (!n || !lower.includes(n.toLowerCase())) continue;
      const m = word(n).exec(draft);
      if (m) {
        hits.push({ at: m.index, e });
        break;
      }
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.e);
}

/**
 * The lines of the <references> block for a draft: what it names first, then
 * what its words match, merged best first; each entry once, at most
 * REFS_LINES lines and REFS_CHARS characters, REFS_PER_KIND of one kind
 * before the best of the rest fill it. A gated source (`cues`) offers words
 * only when the draft carries one of its cue words, and otherwise only the
 * entries the draft names.
 */
export function linkReferences(sources: Array<RefSource | null>, draft: string): DeskRef[] {
  const srcs = sources.filter((s): s is RefSource => !!s && s.entries.length > 0);
  if (!srcs.length || !draft.trim()) return [];
  const lower = draft.toLowerCase();
  const want = significantWords(draft);
  const cands: RefEntry[] = [];
  const scored: Scored[] = [];
  let base = 0;
  for (const src of srcs) {
    cands.push(...(src.find?.(draft) ?? []), ...byNames(src, lower, draft));
    const open = !src.cues || src.cues.some((c) => word(c).test(draft));
    if (open && want.size) scored.push(...byWords(src, draft, want, base));
    base += src.entries.length;
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  cands.push(...scored.map((s) => s.e));

  const shown = new Set<string>();
  const picked: Array<{ rank: number; e: RefEntry }> = [];
  const perKind = new Map<string, number>();
  let chars = 0;
  // An id is at most `r12`: its size is counted at the longest, so the block never outgrows its cap.
  const fits = (e: RefEntry) => picked.length < REFS_LINES && chars + `[r${REFS_LINES}] ${e.kind}: ${e.line}\n`.length <= REFS_CHARS;
  const take = (rank: number, c: RefEntry, capped: boolean): "taken" | "capped" | "skipped" => {
    // A PR whose issue the index has is shown on that issue's line, when that is not shown yet.
    const lead = c.lead?.() ?? null;
    const e = lead && !shown.has(idOf(lead)) ? lead : c;
    if (shown.has(idOf(e))) return "skipped";
    if (capped && (perKind.get(e.kind) ?? 0) >= REFS_PER_KIND) return "capped";
    if (!fits(e)) return "skipped";
    picked.push({ rank, e });
    perKind.set(e.kind, (perKind.get(e.kind) ?? 0) + 1);
    chars += `[r${REFS_LINES}] ${e.kind}: ${e.line}\n`.length;
    shown.add(idOf(e));
    for (const k of e.covers ?? []) shown.add(k);
    return "taken";
  };
  const over: Array<{ rank: number; c: RefEntry }> = [];
  for (const [rank, c] of cands.entries()) {
    if (picked.length >= REFS_LINES) break;
    if (take(rank, c, true) === "capped") over.push({ rank, c });
  }
  for (const { rank, c } of over) if (picked.length < REFS_LINES) take(rank, c, false);
  return picked
    .sort((a, b) => a.rank - b.rank)
    .map(({ e }, i) => ({ id: `r${i + 1}`, kind: e.kind, line: e.line, entry: e, issue: e.issue, prs: e.prs ?? [] }));
}

/** The desk's issues and PRs alone: the first source (decision 88). */
export function deskReferences(index: RefIndex | null, draft: string, opts: MatchOpts = {}): DeskRef[] {
  return linkReferences([deskSource(index, opts)], draft);
}

/** What a reference card puts in place of the vague phrase, written by the entry, never by Haiku. */
export function referenceText(ref: DeskRef, find: string): string {
  return ref.entry.text(find);
}

/** The reference card Haiku named by line id and phrase, as an edit to the draft; null when the id is not a line it was sent or the phrase is not the draft's. */
export function referenceEdit(refs: DeskRef[], id: unknown, find: unknown, draft: string): { op: "replace"; find: string; with: string } | null {
  if (typeof id !== "string" || typeof find !== "string") return null;
  const ref = refs.find((r) => r.id === id.replace(/[[\]\s]/g, ""));
  if (!ref || !find.trim() || find.length > FIND_CAP || !draft.includes(find)) return null;
  return { op: "replace", find, with: referenceText(ref, find) };
}

const lower = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Whether text a card would add copies a run of an entry's title words — four
 * in a row, or all of a shorter one of three — that the draft does not
 * already hold: a card other than a reference card never carries a title into
 * the draft (the titles are anyone's to write).
 */
export function copiesTitle(added: string, draft: string, refs: DeskRef[]): boolean {
  const a = ` ${lower(clip(added))} `;
  const d = ` ${lower(clip(draft))} `;
  for (const r of refs) {
    for (const t of r.entry.titles ?? []) {
      const w = t ? lower(clip(t)).split(" ").filter(Boolean) : [];
      if (w.length < 3) continue;
      const n = Math.min(4, w.length);
      for (let i = 0; i + n <= w.length; i++) {
        const run = ` ${w.slice(i, i + n).join(" ")} `;
        if (a.includes(run) && !d.includes(run)) return true;
      }
    }
  }
  return false;
}
