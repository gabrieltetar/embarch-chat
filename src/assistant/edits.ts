// What the assistant does to the draft, as pure functions the host and the
// chat webview share (embarch-chat-assistant-proposal.md): every card is an
// edit to the draft, previewed in place as a word diff (decision 37); the
// compact card's first line is sent before the rest (36); the handoff card
// turns the draft into a request for a handoff (36); the instant wave's
// prefix match over the owner's own past prompts (26).

/** An edit a card makes. `handoff` is computed from the draft as it is when applied. */
export type DraftEdit =
  | { op: "append"; text: string }
  | { op: "prepend"; text: string }
  | { op: "replace"; find: string; with: string }
  | { op: "handoff" };

/** The 💡's submenus (38): missing context and improvements (28), context handling (36). */
export type CardCategory = "missing" | "improve" | "context";
export type ContextKind = "compact" | "handoff" | "background";

export interface Card {
  id: string;
  category: CardCategory;
  title: string;
  /** One line on why, for the tooltip. */
  why?: string;
  kind?: ContextKind;
  edit: DraftEdit;
}

export const CATEGORIES: Array<{ id: CardCategory; label: string }> = [
  { id: "missing", label: "Missing context" },
  { id: "improve", label: "Improvements" },
  { id: "context", label: "Context handling" },
];

/** A reply chip (25): Haiku's, the CLI's own guess, or the handoff's fresh chat (36). */
export interface Chip {
  text: string;
  source: "haiku" | "cli" | "handoff";
  action?: "freshChat";
}

// ------------------------------------------------------------ context cards

/** The compact card's first line (36): Claude cannot run /compact itself, so the panel sends it first. */
export function compactLine(focus: string): string {
  return `/compact focus on: ${focus.replace(/\s+/g, " ").trim()}`;
}

export const BACKGROUND_INSTRUCTION =
  "Run this as a background subagent (the Agent tool with run_in_background) so this chat stays free, and report back here when it is done.";

/** The fence the handoff request asks for, so the fresh chat gets the handoff alone. */
export const HANDOFF_FENCE = "handoff";

/** The handoff card turns the draft into a request that this chat write a handoff (36): its model has the whole context. */
export function handoffRequest(draft: string): string {
  const next = draft.trim();
  return [
    "Write a handoff for a fresh chat that will take this work over. It starts with none of this conversation, so cover the goal, what is done (files, commits, results), what is left, the decisions made and still open, and anything that went wrong on the way.",
    `Put the handoff alone in one fenced block that opens with \`\`\`${HANDOFF_FENCE}, so it can be passed on as it is.`,
    ...(next ? ["", `What the fresh chat should do next: ${next}`] : []),
  ].join("\n");
}

/** The handoff a turn wrote: the fenced block when there is one, else the whole reply. */
export function extractHandoff(reply: string): string {
  const m = new RegExp("```" + HANDOFF_FENCE + "[^\\n]*\\n([\\s\\S]*?)\\n?```").exec(reply);
  return (m ? m[1] : reply).trim();
}

/** A draft whose first line is a /compact and that has more after it: sent as two messages (36). */
export function splitCompact(text: string): { compact: string; rest: string } | null {
  const m = /^(\/compact\b[^\n]*)\n+([\s\S]*)$/.exec(text.trim());
  if (!m || !m[2].trim()) return null;
  return { compact: m[1].trim(), rest: m[2].trim() };
}

/** The edit a context card makes, from the kind Haiku judged and what the draft is about. */
export function contextEdit(kind: ContextKind, focus: string): DraftEdit {
  if (kind === "compact") return { op: "prepend", text: compactLine(focus) + "\n" };
  if (kind === "handoff") return { op: "handoff" };
  return { op: "append", text: "\n\n" + BACKGROUND_INSTRUCTION };
}

// ------------------------------------------------------------ applying

/** The draft after an edit, or null when the edit no longer applies (its text is gone). */
export function applyEdit(draft: string, e: DraftEdit): string | null {
  switch (e.op) {
    case "append": {
      if (!e.text.trim()) return null;
      if (draft.includes(e.text.trim())) return null;
      const body = draft.replace(/\s+$/, "");
      if (!body) return e.text.trim();
      const sep = /^\s/.test(e.text) ? "" : " ";
      return body + sep + e.text.replace(/\s+$/, "");
    }
    case "prepend": {
      if (!e.text.trim()) return null;
      const head = e.text.trim();
      if (draft.trimStart().startsWith(head)) return null;
      const sep = /\s$/.test(e.text) ? e.text.slice(e.text.trimEnd().length) : " ";
      return head + sep + draft.replace(/^\s+/, "");
    }
    case "replace":
      if (!e.find || !draft.includes(e.find) || e.find === e.with) return null;
      return draft.replace(e.find, e.with);
    case "handoff":
      return draft.startsWith(handoffRequest("").split("\n")[0]) ? null : handoffRequest(draft);
  }
}

// ------------------------------------------------------------ the preview

export interface DiffPart {
  t: "same" | "add" | "del";
  s: string;
}

function tokens(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/** A word diff from `a` to `b`: added words show in ghost grey, removed ones struck through (37). */
export function wordDiff(a: string, b: string): DiffPart[] {
  const x = tokens(a);
  const y = tokens(b);
  // The common head and tail first: most edits touch one end.
  let lo = 0;
  while (lo < x.length && lo < y.length && x[lo] === y[lo]) lo++;
  let hx = x.length;
  let hy = y.length;
  while (hx > lo && hy > lo && x[hx - 1] === y[hy - 1]) {
    hx--;
    hy--;
  }
  const xm = x.slice(lo, hx);
  const ym = y.slice(lo, hy);
  const n = xm.length;
  const m = ym.length;
  const parts: DiffPart[] = [];
  const push = (t: DiffPart["t"], s: string) => {
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.s += s;
    else parts.push({ t, s });
  };
  x.slice(0, lo).forEach((s) => push("same", s));
  if (n * m > 250_000) {
    xm.forEach((s) => push("del", s));
    ym.forEach((s) => push("add", s));
  } else {
    // Longest common subsequence over the middle.
    const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xm[i] === ym[j]) {
        push("same", xm[i]);
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) push("del", xm[i++]);
      else push("add", ym[j++]);
    }
    while (i < n) push("del", xm[i++]);
    while (j < m) push("add", ym[j++]);
  }
  x.slice(hx).forEach((s) => push("same", s));
  return parts;
}

// ------------------------------------------------------------ the instant wave

/** One of the owner's own past prompts, deduplicated: how often and when last. */
export interface PastPrompt {
  text: string;
  n: number;
  lastMs: number;
}

/**
 * The instant wave's completion (26): the rest of the owner's most-sent past
 * prompt that starts with the draft (case aside), to the end of its line.
 */
export function prefixMatch(prompts: PastPrompt[], draft: string): string | null {
  if (!draft.trim() || draft.includes("\n")) return null;
  const d = draft.toLowerCase();
  let best: PastPrompt | null = null;
  for (const p of prompts) {
    if (p.text.length <= draft.length || !p.text.toLowerCase().startsWith(d)) continue;
    if (!best || p.n > best.n || (p.n === best.n && p.lastMs > best.lastMs)) best = p;
  }
  if (!best) return null;
  const rest = best.text.slice(draft.length).split("\n")[0];
  return rest.trim() ? rest : null;
}

/** The completion still to show once the owner has typed past `base`: type-through (26). */
export function ghostRest(text: string, base: string, completion: string): string | null {
  if (!completion || !text.startsWith(base)) return null;
  const typed = text.slice(base.length);
  if (!completion.startsWith(typed)) return null;
  const rest = completion.slice(typed.length);
  return rest ? rest : null;
}
