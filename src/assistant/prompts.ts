// What the Haiku assistant is asked and how its answers are read. It sees
// the draft, Claude's last reply, the work item's card, the library's entry
// names and the chat's context usage — 1–3K tokens (decision 27) — and
// answers one JSON object: a completion (24), cards (28, 36), or chips and a
// name (25, 12).

import { Card, CardCategory, ContextKind, DraftEdit, applyEdit, contextEdit } from "./edits";

export interface AssistInput {
  draft: string;
  /** Claude's last reply, text only. */
  lastReply: string;
  item: { key?: string; title: string; state?: string; prs?: string[] } | null;
  /** Library entry names (decision 7). */
  library: string[];
  context: { percentage: number; totalTokens: number; maxTokens: number } | null;
  /** The CLI's own guess at the next prompt (`--prompt-suggestions`), when it has one. */
  cliSuggestion?: string | null;
}

export const SYSTEM =
  "You are the input assistant of a Claude Code chat panel that an embedded-firmware engineer uses to talk to Claude, a coding agent working in their repository. " +
  "You never talk to the engineer and never do the work: you help write the next message to Claude. " +
  "Answer with exactly one JSON object and nothing else — no prose, no code fence.";

const REPLY_CAP = 4000;

function clip(s: string, n: number): string {
  return s.length <= n ? s : "…" + s.slice(s.length - n);
}

/** The context every call shares (27). */
export function contextBlock(i: AssistInput, opts: { draft?: boolean } = {}): string {
  const lines: string[] = [];
  if (i.item) {
    const head = [i.item.key, i.item.title].filter(Boolean).join(" ");
    const tail = [i.item.state, ...(i.item.prs ?? [])].filter(Boolean).join(" · ");
    lines.push(`<work_item>${head}${tail ? ` · ${tail}` : ""}</work_item>`);
  } else lines.push("<work_item>none (untracked chat)</work_item>");
  if (i.context) lines.push(`<context_usage>${Math.round(i.context.percentage)}% of ${Math.round(i.context.maxTokens / 1000)}K tokens used</context_usage>`);
  if (i.library.length) lines.push(`<library_commands>${i.library.map((n) => "/" + n).join(", ")}</library_commands>`);
  lines.push(i.lastReply.trim() ? `<claude_last_reply>\n${clip(i.lastReply.trim(), REPLY_CAP)}\n</claude_last_reply>` : "<claude_last_reply>none yet: this is the chat's first message</claude_last_reply>");
  if (opts.draft !== false) lines.push(`<draft>${i.draft}</draft>`);
  return lines.join("\n");
}

/** The second wave: ghost text after a 300 ms pause (24, 26). */
export function ghostPrompt(i: AssistInput): string {
  return [
    "TASK: ghost",
    "Continue the engineer's draft from exactly where it stops, as they would go on writing it to Claude.",
    'Return {"completion": "<the text that comes right after the draft>"}. Start it with a space when a new word begins. At most one short sentence; stop at a natural end. Return {"completion": ""} when the draft reads as finished or you cannot tell where it goes.',
    "Never repeat the draft. Never invent facts (board names, issue keys, file names) that are not in the context.",
    "",
    contextBlock(i),
  ].join("\n");
}

/** The third wave: cards on a 2 s pause or just before send (26, 28, 36). */
export function cardsPrompt(i: AssistInput): string {
  return [
    "TASK: cards",
    "Judge the draft as a finished message to Claude. Suggest at most 3 cards, only where one clearly helps; most drafts need none.",
    'Return {"cards": [...]} — an empty list when the draft is fine. Each card is one of:',
    '- {"category": "missing", "title": "<6 words at most>", "why": "<one line>", "edit": <edit>} — something Claude will need that the draft lacks (which board, which issue, which file, what "working" means). The edit adds it when the context names it, else a short question for the engineer in brackets, like [which board?].',
    '- {"category": "improve", "title": "<6 words at most>", "why": "<one line>", "edit": <edit>} — the prompt put better: clearer, more specific, the expected result stated.',
    '- {"category": "context", "kind": "compact" | "handoff" | "background", "title": "<6 words at most>", "why": "<one line>", "focus": "<what the draft is about, 3 to 8 words>"} — compact when the context is filling (above about 60%) and the draft moves to new work; handoff when the context is nearly full (above about 80%) or the draft starts unrelated work; background when the draft asks for a long, self-contained job (a long build or test run, a sweep, research) that Claude can do while the chat stays free.',
    'An edit is {"op": "append", "text": "..."}, {"op": "prepend", "text": "..."}, or {"op": "replace", "find": "<an exact substring of the draft>", "with": "..."}.',
    "Keep the engineer's words and voice; change only what the card is about. Never invent facts that are not in the context.",
    "",
    contextBlock(i),
  ].join("\n");
}

/** After a turn: two to four reply chips (25) and, after the first turn, a name for the chat (12). */
export function turnPrompt(i: AssistInput, want: { chips: boolean; name: boolean }): string {
  const asks: string[] = [];
  if (want.chips) {
    asks.push(
      '"chips": 2 to 4 replies the engineer is likely to send next, each at most 8 words. Most of their replies are one or two words ("done", "continue", "yes", "go", "push"), so offer those when they fit, and a specific one when Claude asked a question or offered options.' +
        (i.cliSuggestion ? ` Claude Code itself guessed "${i.cliSuggestion}"; leave it out, it is shown anyway.` : ""),
    );
  }
  if (want.name) asks.push('"name": a title for this chat in 3 to 6 words, plain text, naming the work rather than the first message (not "Read the issue").');
  return [
    "TASK: turn",
    "Claude's turn just ended.",
    `Return one JSON object with ${asks.map((a) => a).join(" and ")}`,
    "",
    contextBlock(i, { draft: false }),
  ].join("\n");
}

// ------------------------------------------------------------ reading answers

/** The JSON object in an answer, tolerating a code fence or a stray word around it. */
export function parseObject(text: string): Record<string, unknown> | null {
  const s = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The "completion" string of a JSON answer still streaming: what can show as ghost text so far. */
export function partialCompletion(text: string): string | null {
  const m = /"completion"\s*:\s*"/.exec(text);
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = text[i + 1];
    if (n === undefined) return out;
    if (n === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
      i++;
    }
  }
  return out;
}

/** The completion, cleaned: never a repeat of the draft, never past one line of trailing newlines. */
export function cleanCompletion(draft: string, completion: string): string {
  let c = completion.replace(/\s+$/, "");
  const tail = draft.trimEnd();
  if (tail && c.trimStart().startsWith(tail)) c = c.trimStart().slice(tail.length);
  if (/\s$/.test(draft)) c = c.replace(/^\s+/, "");
  return c;
}

const CATS: CardCategory[] = ["missing", "improve", "context"];
const KINDS: ContextKind[] = ["compact", "handoff", "background"];

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function editOf(v: unknown): DraftEdit | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if ((e.op === "append" || e.op === "prepend") && typeof e.text === "string" && e.text.trim()) return { op: e.op, text: e.text };
  if (e.op === "replace" && typeof e.find === "string" && e.find && typeof e.with === "string") return { op: "replace", find: e.find, with: e.with };
  return null;
}

/** Cards that apply to the draft they were judged on; malformed ones are dropped. */
export function parseCards(o: Record<string, unknown> | null, draft: string, idBase: string): Card[] {
  const raw = Array.isArray(o?.cards) ? (o!.cards as unknown[]) : [];
  const out: Card[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const c = r as Record<string, unknown>;
    const category = CATS.find((x) => x === c.category);
    const title = str(c.title, 80);
    if (!category || !title) continue;
    let card: Card;
    if (category === "context") {
      const kind = KINDS.find((k) => k === c.kind);
      if (!kind) continue;
      card = { id: "", category, kind, title, edit: contextEdit(kind, str(c.focus, 120) ?? title) };
    } else {
      const edit = editOf(c.edit);
      if (!edit) continue;
      card = { id: "", category, title, edit };
    }
    const why = str(c.why, 200);
    if (why) card.why = why;
    if (applyEdit(draft, card.edit) === null) continue;
    card.id = `${idBase}-${out.length}`;
    out.push(card);
    if (out.length >= 5) break;
  }
  return out;
}

/** Chips and a name from the turn call. */
export function parseTurn(o: Record<string, unknown> | null): { chips: string[]; name: string | null } {
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const c of Array.isArray(o?.chips) ? (o!.chips as unknown[]) : []) {
    const s = str(c, 80);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    chips.push(s);
    if (chips.length >= 4) break;
  }
  const name = str(o?.name, 60)?.replace(/^["'“]+|["'”.]+$/g, "") ?? null;
  return { chips, name: name || null };
}
