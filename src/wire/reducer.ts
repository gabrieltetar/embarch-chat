// A chat's state, folded from the wire one message at a time. Pure and
// shared: the extension host folds every line it reads, and each webview
// showing the chat folds the same lines after one snapshot, so a streamed
// delta crosses postMessage as one small event, not as the whole chat.
//
// Events are either lines from the CLI (wire.ts types) or the host's own,
// whose type starts with "_" (a message sent, a prompt answered, the process
// starting or closing, a control response folded in).

import type { ContentBlock, ContextUsage, DialogRequest, ElicitationRequest, PermissionRequest, RateLimitInfo, WireMessage } from "./types";
import { answerable, unansweredNote } from "./dialogs";
import type { ContextItem } from "./message";
import { readMessage, sameText } from "./message";

export type ProcessState = "none" | "starting" | "running" | "closed" | "error";

export interface UserEntry {
  kind: "user";
  id: string;
  text: string;
  images: number;
  /** Sent by this panel and not yet echoed back by the CLI. */
  pending?: boolean;
  /** Held until the compaction before it finishes (decision 36). */
  held?: boolean;
  /** Held, then not sent: the compaction was stopped or failed; its text went back to the draft. */
  unsent?: boolean;
  /** When it was sent, ms since the epoch (decision 68): the panel's clock, else the CLI's. */
  at?: number;
  /**
   * The message's own uuid, stamped by this panel as it sends it: the CLI's
   * queue knows it by it (cancel_async_message, Send now; port item 72), and
   * the CLI keeps it as the message's id in the transcript — what a rewind
   * or a fork names (decision 73). A message from elsewhere has the CLI's.
   */
  uuid?: string;
  /** What went with it (decisions 58, 60): the editor's selection or file, a terminal's output. */
  context?: ContextItem[];
}
export interface TextEntry {
  kind: "text";
  id: string;
  text: string;
  parent: string | null;
  at?: number;
}
export interface ThinkingEntry {
  kind: "thinking";
  id: string;
  text: string;
  parent: string | null;
  at?: number;
}
export interface ToolEntry {
  kind: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  parent: string | null;
  status: "running" | "awaiting" | "done" | "error" | "denied";
  result?: string;
  /** The CLI's `tool_use_result`: an Edit's patch, a Bash's stdout, ... */
  structured?: unknown;
  /** A subagent's own steps, by entry id (decision 8: nested under its call). */
  children: string[];
  progress?: string;
  background?: boolean;
  /** When the call came and when its result did (decision 68). */
  at?: number;
  doneAt?: number;
  /** The CLI's task for the call (task_started): a Bash or a subagent in the foreground can be moved to the background by it. */
  task?: string;
  /** How its task ended, and when; until then a call in the background still runs. */
  taskEnd?: "completed" | "failed" | "stopped";
  taskEndAt?: number;
}
export interface NoteEntry {
  kind: "note";
  id: string;
  text: string;
  tone: "info" | "error" | "compact" | "interrupt";
  /** The owner's message that was not sent, kept with the note to copy. */
  kept?: string;
  /** A compaction's summary, the line the CLI sends after its boundary (decision 76). */
  summary?: string;
}
export type Entry = UserEntry | TextEntry | ThinkingEntry | ToolEntry | NoteEntry;

export interface Pending {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  description?: string;
  suggestions?: unknown[];
  /**
   * How the panel shows it: a question form, a plan, or allow/deny — all
   * `can_use_tool`; or an MCP server's elicitation (`toolName` the server,
   * `input` the request) or one of the CLI's dialogs (`toolName` its kind,
   * `input` its payload), decision 66.
   */
  form: "question" | "plan" | "permission" | "elicitation" | "dialog";
  /** Some of an Edit's or Write's changes rejected in its diff tab (decision 64): how many are kept; `input` makes only those. */
  kept?: string;
}

/** The prompt cache the next message would read (decision 69): written at `at` for `ttl` ms; a compaction since leaves it behind. */
export interface CacheWindow {
  /** The reply that wrote or read it: its later lines keep the first one's time. */
  msgId: string;
  at: number;
  /** Null until a reply says how long it lives. */
  ttl: number | null;
  compactedAt?: number;
}

/** A side question (decision 57): asked beside the chat, never part of its conversation. */
export interface SideQuestion {
  id: string;
  question: string;
  pending: boolean;
  /** Claude's answer; null when it gave none. */
  response?: string | null;
  error?: string;
}

export interface StreamBlock {
  type: string;
  text: string;
  name?: string;
  id?: string;
}

export interface ChatState {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  process: ProcessState;
  processError: string | null;
  busy: boolean;
  compacting: boolean;
  mode: string;
  model: string | null;
  version: string | null;
  slashCommands: string[];
  timeline: string[];
  entries: Record<string, Entry>;
  pending: Pending[];
  streaming: { msgId: string; blocks: StreamBlock[] } | null;
  /** Finalized block count per assistant message id: a streamed block at a lower index is already an entry. */
  finalized: Record<string, number>;
  /** Block signatures already folded, so a repeated assistant message adds nothing. */
  seen: Record<string, true>;
  background: Array<{ id: string; type: string; description: string }>;
  /** Task id to the tool call that started it, for the background tasks' rows. */
  tasks: Record<string, string>;
  /** This panel's messages the CLI has not echoed yet, oldest first (the `pending` user entries). */
  unconfirmed: string[];
  /** Messages sent while Claude worked and not yet taken: they wait at the bottom, not in the timeline, until Claude starts on them (port item 72). */
  queue: string[];
  /** What the CLI says it supports (init's `capabilities`): `interrupt_send_now_v1` is Send now. */
  capabilities: string[];
  context: ContextUsage | null;
  lastTurn: { ok: boolean; subtype: string; error?: string } | null;
  /** The account's latest usage limit as the CLI reported it (decision 67). */
  rateLimit: RateLimitInfo | null;
  /** When the CLI last wrote a line, or the owner last sent one: the "Not responding" clock (decision 68). */
  lastLineAt: number | null;
  cache: CacheWindow | null;
  /** Side questions (decision 57), oldest first: kept beside the timeline, never in it. */
  side: SideQuestion[];
  seq: number;
}

export function initialState(sessionId: string, mode = "auto"): ChatState {
  return {
    sessionId,
    title: null,
    cwd: null,
    process: "none",
    processError: null,
    busy: false,
    compacting: false,
    mode,
    model: null,
    version: null,
    slashCommands: [],
    timeline: [],
    entries: {},
    pending: [],
    streaming: null,
    finalized: {},
    seen: {},
    background: [],
    tasks: {},
    unconfirmed: [],
    queue: [],
    capabilities: [],
    context: null,
    lastTurn: null,
    rateLimit: null,
    lastLineAt: null,
    cache: null,
    side: [],
    seq: 0,
  };
}

/** What the thread list shows for a chat. */
export function chatStatus(s: ChatState): "waiting" | "busy" | "idle" | "closed" {
  if (s.pending.length) return "waiting";
  if (s.busy || s.compacting) return "busy";
  if (s.process === "running" || s.process === "starting") return "idle";
  return "closed";
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function imagesOf(content: unknown): number {
  return Array.isArray(content) ? content.filter((b) => b && (b as { type?: string }).type === "image").length : 0;
}

function formOf(toolName: string): Pending["form"] {
  if (toolName === "AskUserQuestion") return "question";
  if (toolName === "ExitPlanMode") return "plan";
  return "permission";
}

/**
 * When a line was written, ms since the epoch (decision 68): the CLI's own
 * `timestamp` (user and assistant lines, live and in a transcript), else the
 * host's arrival time, `_at`, which chat.ts stamps on every live line.
 */
function stamp(o: WireMessage): number | undefined {
  const t = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  if (Number.isFinite(t)) return t;
  return typeof o._at === "number" ? o._at : undefined;
}

/** How long a reply's cache write lives, from its usage: an hour or five minutes; null when it wrote none (69). */
function cacheTtl(u: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } }): number | null {
  if ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) return 3_600_000;
  if ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) return 300_000;
  return null;
}

/** What waits on the owner, from one of the CLI's requests `answerable` takes (decision 66). */
function pendingOf(requestId: string, r: PermissionRequest | ElicitationRequest | DialogRequest): Pending {
  if (r.subtype === "elicitation") {
    const { subtype: _, ...input } = r;
    return { requestId, toolName: r.mcp_server_name, input, form: "elicitation" };
  }
  if (r.subtype === "request_user_dialog") return { requestId, toolName: r.dialog_kind, input: r.payload ?? {}, toolUseId: r.tool_use_id || undefined, form: "dialog" };
  return {
    requestId,
    toolName: r.tool_name,
    input: r.input ?? {},
    toolUseId: r.tool_use_id,
    description: r.description,
    suggestions: r.permission_suggestions,
    form: formOf(r.tool_name),
  };
}

/** A slash command's echo, `<command-name>/x</command-name><command-args>y</command-args>`, as the owner typed it. */
function commandText(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
  return `${name.startsWith("/") ? name : "/" + name}${args ? " " + args : ""}`;
}

// ----------------------------------------------------------------- helpers

/**
 * Folding a whole transcript (`reduceAll`) writes into containers it owns
 * instead of copying them per line: copying `entries` and `timeline` on
 * every line made a long chat cost O(n²) to open. Entries themselves are
 * still replaced, never changed, so a state handed out earlier stays as it
 * was.
 */
let owned: { entries: Record<string, Entry>; timeline: string[]; seen: Record<string, true>; finalized: Record<string, number> } | null = null;

const ownsEntries = (s: ChatState) => owned !== null && owned.entries === s.entries;

function put(s: ChatState, e: Entry, parent: string | null): ChatState {
  const host = parent ? s.entries[parent] : undefined;
  if (ownsEntries(s)) {
    s.entries[e.id] = e;
    if (host && host.kind === "tool") s.entries[parent!] = { ...host, children: [...host.children, e.id] };
    else s.timeline.push(e.id);
    return s;
  }
  const entries = { ...s.entries, [e.id]: e };
  if (host && host.kind === "tool") {
    entries[parent!] = { ...host, children: [...host.children, e.id] };
    return { ...s, entries };
  }
  return { ...s, entries, timeline: [...s.timeline, e.id] };
}

function patch<K extends Entry["kind"]>(s: ChatState, id: string, kind: K, f: (e: Extract<Entry, { kind: K }>) => Partial<Extract<Entry, { kind: K }>>): ChatState {
  const e = s.entries[id];
  if (!e || e.kind !== kind) return s;
  const typed = e as Extract<Entry, { kind: K }>;
  if (ownsEntries(s)) {
    s.entries[id] = { ...typed, ...f(typed) };
    return s;
  }
  return { ...s, entries: { ...s.entries, [id]: { ...typed, ...f(typed) } } };
}

/** Folds many lines at once — a transcript — in O(n); the result is the same as folding them one by one with `reduce`. */
export function reduceAll(s: ChatState, events: WireMessage[]): ChatState {
  const prev = owned;
  let st: ChatState = { ...s, entries: { ...s.entries }, timeline: s.timeline.slice(), seen: { ...s.seen }, finalized: { ...s.finalized } };
  owned = { entries: st.entries, timeline: st.timeline, seen: st.seen, finalized: st.finalized };
  try {
    for (const e of events) {
      st = reduce(st, e);
      // A branch that copied a container hands the copy over.
      owned = { entries: st.entries, timeline: st.timeline, seen: st.seen, finalized: st.finalized };
    }
  } finally {
    owned = prev;
  }
  return st;
}

/**
 * A message of this panel's the CLI took: no longer pending. One that
 * waited at the bottom joins the timeline here, where Claude started on it
 * (port item 72), as one not sent does, to say so where it was.
 */
function confirm(s: ChatState, id: string, extra: Partial<UserEntry> = {}): ChatState {
  s = patch(s, id, "user", () => ({ pending: false, ...extra }));
  s = { ...s, unconfirmed: (s.unconfirmed ?? []).filter((x) => x !== id) };
  if (!(s.queue ?? []).includes(id)) return s;
  s = { ...s, queue: s.queue.filter((x) => x !== id) };
  if (ownsEntries(s)) {
    s.timeline.push(id);
    return s;
  }
  return { ...s, timeline: [...s.timeline, id] };
}

/** The tool call a task was started by. */
function taskTool(s: ChatState, taskId: unknown): string | undefined {
  return typeof taskId === "string" ? s.tasks?.[taskId] : undefined;
}

function note(s: ChatState, text: string, tone: NoteEntry["tone"], kept?: string): ChatState {
  return put(s, { kind: "note", id: `n:${s.seq}`, text, tone, ...(kept ? { kept } : {}) }, null);
}

/** The last thing in the timeline, the owner's own messages aside, is a compaction's card. */
function justCompacted(s: ChatState): boolean {
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    const e = s.entries[s.timeline[i]];
    if (e?.kind === "user") continue;
    return e?.kind === "note" && e.tone === "compact";
  }
  return false;
}

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n");
  return "";
}

/** A tool call made inside a background task (a background subagent's step), at any depth. */
function inBackground(s: ChatState, toolId: string | undefined): boolean {
  for (let id = toolId, hops = 0; id && hops < 32; hops++) {
    const e = s.entries[id];
    if (!e || e.kind !== "tool") return false;
    if (e.background && id !== toolId) return true;
    id = e.parent ?? undefined;
  }
  return false;
}

// ----------------------------------------------------------------- folding

function foldAssistant(s: ChatState, o: WireMessage): ChatState {
  const msg = o.message as { id?: string; content?: ContentBlock[]; usage?: Record<string, number> & { cache_creation?: Record<string, number> } } | undefined;
  if (!msg || !Array.isArray(msg.content)) return s;
  const parent = (o.parent_tool_use_id as string | null | undefined) ?? null;
  const msgId = msg.id ?? `m:${s.seq}`;
  const at = stamp(o);
  // The main thread's prompt cache, as Claude Code's panel reads it: from a
  // reply that wrote or read it, timed by its first line (69). A subagent's
  // prefix is its own; a reply without a lifetime keeps the last one known.
  const u = msg.usage;
  if (!parent && u && at !== undefined && s.cache?.msgId !== msgId && (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) > 0) {
    s = { ...s, cache: { msgId, at, ttl: cacheTtl(u) ?? s.cache?.ttl ?? null } };
  }
  for (const b of msg.content) {
    const sig =
      b.type === "tool_use" ? `${msgId}#u:${(b as { id: string }).id}` : `${msgId}#${b.type}:${hash(String((b as { text?: string; thinking?: string }).text ?? (b as { thinking?: string }).thinking ?? ""))}`;
    if (s.seen[sig]) continue;
    const n = s.finalized[msgId] ?? 0;
    if (owned !== null && owned.seen === s.seen && owned.finalized === s.finalized) {
      s.seen[sig] = true;
      s.finalized[msgId] = n + 1;
    } else {
      s = { ...s, seen: { ...s.seen, [sig]: true }, finalized: { ...s.finalized, [msgId]: n + 1 } };
    }
    if (b.type === "text") {
      const text = (b as { text: string }).text;
      if (text.trim()) s = put(s, { kind: "text", id: `${msgId}:${n}`, text, parent, at }, parent);
    } else if (b.type === "thinking") {
      const text = (b as { thinking: string }).thinking ?? "";
      if (text.trim()) s = put(s, { kind: "thinking", id: `${msgId}:${n}`, text, parent, at }, parent);
    } else if (b.type === "tool_use") {
      const t = b as { id: string; name: string; input: Record<string, unknown> };
      if (!s.entries[t.id]) {
        s = put(s, { kind: "tool", id: t.id, name: t.name, input: t.input ?? {}, parent, status: "running", children: [], at }, parent);
      }
    }
  }
  return s;
}

function foldUser(s: ChatState, o: WireMessage): ChatState {
  const msg = o.message as { content?: unknown } | undefined;
  if (!msg) return s;
  const content = msg.content;
  const parent = (o.parent_tool_use_id as string | null | undefined) ?? null;
  // Tool results, wherever they sit.
  if (Array.isArray(content)) {
    for (const b of content as ContentBlock[]) {
      if (b.type !== "tool_result") continue;
      const r = b as { tool_use_id: string; content?: unknown; is_error?: boolean };
      const structured = o.tool_use_result ?? o.toolUseResult;
      s = patch(s, r.tool_use_id, "tool", (t) => ({
        status: r.is_error ? (t.status === "denied" ? "denied" : "error") : "done",
        result: resultText(r.content),
        structured: structured ?? t.structured,
        doneAt: stamp(o) ?? t.doneAt,
      }));
    }
    if ((content as ContentBlock[]).every((b) => b.type === "tool_result")) return s;
  }
  // A compaction's summary, right after its boundary: `isCompactSummary` in a
  // transcript, a synthetic message of plain text live (Claude Code's rule), 76.
  if (!parent && (o.isCompactSummary || (o.isSynthetic && typeof content === "string"))) {
    const last = s.entries[s.timeline[s.timeline.length - 1]];
    if (last?.kind === "note" && last.tone === "compact" && last.summary === undefined) return patch(s, last.id, "note", () => ({ summary: textOf(content) }));
  }
  if (o.isSynthetic || o.isMeta || o.isCompactSummary || parent) return s;
  const raw = textOf(content);
  if (raw.startsWith("[Request interrupted by user")) return note(s, "Interrupted", "interrupt");
  const stdout = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(raw.trim());
  if (stdout) {
    // A local command (/compact, /cost, ...) echoes its output, not itself.
    const cmd = (s.unconfirmed ?? []).find((id) => {
      const e = s.entries[id];
      return e?.kind === "user" && e.pending && e.text.startsWith("/");
    });
    if (cmd) s = confirm(s, cmd);
    // /compact's own "Compacted" says again what its card says (76).
    if (stdout[1].trim() === "Compacted" && justCompacted(s)) return s;
    return stdout[1].trim() ? note(s, stdout[1].trim(), "info") : s;
  }
  if (/^<local-command-stderr>/.test(raw.trim())) return note(s, raw.replace(/<\/?local-command-stderr>/g, "").trim(), "error");
  // The context blocks before the owner's words, and a marked paste unwrapped (decisions 56, 58, 60).
  const own = readMessage(raw);
  const text = commandText(own.text) ?? own.text;
  const images = imagesOf(content);
  if (!text.trim() && !images && !own.context.length) return s;
  // The CLI echoing what this panel sent (`--replay-user-messages`), under
  // the uuid it was sent with; by its text, a message sent without one —
  // whitespace-blind, as a marked paste's echo moves its line breaks (56).
  const uuid = typeof o.uuid === "string" ? o.uuid : undefined;
  const mine =
    (uuid &&
      (s.unconfirmed ?? []).find((id) => {
        const e = s.entries[id];
        return e?.kind === "user" && e.pending && e.uuid === uuid;
      })) ||
    (s.unconfirmed ?? []).find((id) => {
      const e = s.entries[id];
      return e?.kind === "user" && e.pending && sameText(e.text, text);
    });
  if (mine) return confirm(s, mine, uuid ? { uuid } : {});
  return put(s, { kind: "user", id: uuid ?? `u:${s.seq}`, text, images, at: stamp(o), ...(uuid ? { uuid } : {}), ...(own.context.length ? { context: own.context } : {}) }, null);
}

function foldSystem(s: ChatState, o: WireMessage): ChatState {
  switch (o.subtype) {
    case "init":
      return {
        ...s,
        cwd: (o.cwd as string) ?? s.cwd,
        model: (o.model as string) ?? s.model,
        mode: (o.permissionMode as string) ?? s.mode,
        version: (o.claude_code_version as string) ?? s.version,
        slashCommands: Array.isArray(o.slash_commands) ? (o.slash_commands as string[]) : s.slashCommands,
        capabilities: Array.isArray(o.capabilities) ? (o.capabilities as string[]) : (s.capabilities ?? []),
      };
    case "status": {
      let n = s;
      if (o.status === "requesting") n = { ...n, busy: true };
      if (o.status === "compacting") n = { ...n, compacting: true, busy: true };
      if (o.status === null && n.compacting) n = { ...n, compacting: false };
      if (typeof o.permissionMode === "string") n = { ...n, mode: o.permissionMode };
      return n;
    }
    case "compact_boundary": {
      // Live `compact_metadata`, in a transcript `compactMetadata`.
      const m = (o.compact_metadata ?? o.compactMetadata) as { pre_tokens?: number; preTokens?: number; trigger?: string } | undefined;
      const pre = m?.pre_tokens ?? m?.preTokens ?? 0;
      // The cache held the conversation before it; the next message writes a new one (69).
      const cache = s.cache ? { ...s.cache, compactedAt: stamp(o) ?? s.cache.at } : null;
      // Claude Code's card line, its "freed" being the size before (76); the summary comes next.
      return note({ ...s, compacting: false, cache }, `Compacted chat · ${m?.trigger === "manual" ? "manual" : "auto"} · ${Math.round(pre / 1000)}k tokens freed`, "compact");
    }
    case "session_title_changed":
      return typeof o.title === "string" ? { ...s, title: o.title } : s;
    case "background_tasks_changed":
      return {
        ...s,
        background: Array.isArray(o.tasks)
          ? (o.tasks as Array<{ task_id: string; task_type: string; description: string }>).map((t) => ({ id: t.task_id, type: t.task_type, description: t.description }))
          : s.background,
      };
    case "task_started":
    case "task_progress":
    case "task_notification": {
      const id = o.tool_use_id as string | undefined;
      if (!id) return s;
      const text = (o.subtype === "task_notification" ? o.summary : o.description) as string | undefined;
      const task = typeof o.task_id === "string" ? o.task_id : undefined;
      if (o.subtype === "task_started" && task) s = { ...s, tasks: { ...(s.tasks ?? {}), [task]: id } };
      const end = o.subtype === "task_notification" && ["completed", "failed", "stopped"].includes(o.status as string) ? (o.status as ToolEntry["taskEnd"]) : undefined;
      return patch(s, id, "tool", () => ({
        progress: text,
        ...(o.subtype === "task_started" ? { background: Boolean(o.is_backgrounded), task } : {}),
        ...(end ? { taskEnd: end, taskEndAt: stamp(o) } : {}),
      }));
    }
    case "task_updated": {
      // Moved to the background ("Run in background", port item 70), or ended.
      const id = taskTool(s, o.task_id);
      const p = o.patch as { is_backgrounded?: boolean; status?: string } | undefined;
      if (!id || !p) return s;
      const end = p.status === "completed" || p.status === "failed" ? p.status : p.status === "killed" ? "stopped" : undefined;
      return patch(s, id, "tool", () => ({ ...(p.is_backgrounded ? { background: true } : {}), ...(end ? { taskEnd: end, taskEndAt: stamp(o) } : {}) }));
    }
    default:
      return s;
  }
}

function foldStream(s: ChatState, o: WireMessage): ChatState {
  if (o.parent_tool_use_id) return s;
  const ev = o.event as { type: string; index?: number; message?: { id?: string }; content_block?: { type: string; text?: string; name?: string; id?: string; thinking?: string }; delta?: { type: string; text?: string; thinking?: string; partial_json?: string } };
  if (!ev) return s;
  switch (ev.type) {
    case "message_start":
      return { ...s, busy: true, streaming: { msgId: ev.message?.id ?? `m:${s.seq}`, blocks: [] } };
    case "content_block_start": {
      if (!s.streaming || ev.index === undefined || !ev.content_block) return s;
      const blocks = s.streaming.blocks.slice();
      const cb = ev.content_block;
      blocks[ev.index] = { type: cb.type, text: cb.text ?? cb.thinking ?? "", name: cb.name, id: cb.id };
      return { ...s, streaming: { ...s.streaming, blocks } };
    }
    case "content_block_delta": {
      if (!s.streaming || ev.index === undefined || !ev.delta) return s;
      const b = s.streaming.blocks[ev.index];
      if (!b) return s;
      const add = ev.delta.text ?? ev.delta.thinking ?? ev.delta.partial_json ?? "";
      if (!add) return s;
      const blocks = s.streaming.blocks.slice();
      blocks[ev.index] = { ...b, text: b.text + add };
      return { ...s, streaming: { ...s.streaming, blocks } };
    }
    default:
      return s;
  }
}

/** The blocks still streaming, not yet folded into entries. */
export function liveBlocks(s: ChatState): StreamBlock[] {
  if (!s.streaming) return [];
  const done = s.finalized[s.streaming.msgId] ?? 0;
  return s.streaming.blocks.slice(done).filter(Boolean);
}

export function reduce(s: ChatState, o: WireMessage): ChatState {
  s = { ...s, seq: s.seq + 1 };
  // A live line from the CLI: the "Not responding" clock starts again (68).
  if (typeof o._at === "number" && !o.type.startsWith("_")) s.lastLineAt = o._at;
  switch (o.type) {
    case "assistant":
      return foldAssistant(s, o);
    case "user":
      return foldUser(s, o);
    case "system":
      return foldSystem(s, o);
    case "stream_event":
      return foldStream(s, o);
    case "control_request": {
      const r = o.request as PermissionRequest | ElicitationRequest | DialogRequest | undefined;
      // Any other request was refused on arrival (chat.ts): one line says so, and nothing waits (66).
      if (!answerable(r)) return note(s, unansweredNote(r), "info");
      const p = pendingOf(o.request_id as string, r!);
      if (s.pending.some((x) => x.requestId === p.requestId)) return s;
      let n: ChatState = { ...s, pending: [...s.pending, p] };
      if (p.toolUseId) n = patch(n, p.toolUseId, "tool", () => ({ status: "awaiting" }));
      return n;
    }
    // Sent when the account's limit changes — on a process's first turn at
    // least — and on any line of a turn (67).
    case "rate_limit_event": {
      const i = o.rate_limit_info as RateLimitInfo | undefined;
      if (!i || typeof i.status !== "string") return s;
      return {
        ...s,
        rateLimit: {
          status: i.status,
          ...(typeof i.resetsAt === "number" ? { resetsAt: i.resetsAt } : {}),
          ...(typeof i.rateLimitType === "string" ? { rateLimitType: i.rateLimitType } : {}),
          ...(typeof i.utilization === "number" ? { utilization: i.utilization } : {}),
          ...(i.rateLimitGraceActive === true ? { rateLimitGraceActive: true } : {}),
        },
      };
    }
    case "control_cancel_request": {
      const id = o.request_id as string;
      return { ...s, pending: s.pending.filter((p) => p.requestId !== id) };
    }
    case "result": {
      const ok = !o.is_error && o.subtype === "success";
      const interrupted = s.timeline.length > 0 && s.entries[s.timeline[s.timeline.length - 1]]?.kind === "note" && (s.entries[s.timeline[s.timeline.length - 1]] as NoteEntry).tone === "interrupt";
      // The turn's own prompts end with it; a background task's go on asking
      // after the main turn ends, and wait until answered or cancelled.
      const pending = s.pending.some((p) => inBackground(s, p.toolUseId)) ? s.pending.filter((p) => inBackground(s, p.toolUseId)) : [];
      let n: ChatState = { ...s, busy: false, compacting: false, streaming: null, pending, lastTurn: { ok, subtype: String(o.subtype ?? "") } };
      // A local command (/context, /cost, /model …) echoes nothing back: its
      // result, which names it, is what says the CLI took it — else it would
      // wait on Claude for good, and a crash hours later would hand it back.
      if (typeof o.local_command === "string") {
        const ran = `/${o.local_command}`;
        const id = (n.unconfirmed ?? []).find((x) => {
          const e = n.entries[x];
          return e?.kind === "user" && e.pending && !e.held && e.text.trim().split(/\s/, 1)[0] === ran;
        });
        if (id) n = confirm(n, id);
      }
      if (!ok && !interrupted) {
        const errs = Array.isArray(o.errors) ? (o.errors as string[]).join("; ") : "";
        const text = errs || (typeof o.result === "string" && o.result) || `The turn ended with ${o.subtype}`;
        n = note({ ...n, lastTurn: { ok, subtype: String(o.subtype ?? ""), error: text } }, text, "error");
      }
      return n;
    }
    // ---- the host's own events
    case "_sent": {
      // Sent: the time above it, and the "Not responding" clock starts (68).
      const at = typeof o.at === "number" ? o.at : undefined;
      const e: UserEntry = {
        kind: "user",
        id: `s:${o.n}`,
        text: String(o.text ?? ""),
        images: Number(o.images ?? 0),
        pending: true,
        ...(o.held ? { held: true } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(typeof o.uuid === "string" ? { uuid: o.uuid } : {}),
        ...(Array.isArray(o.context) && o.context.length ? { context: o.context as ContextItem[] } : {}),
      };
      const n: ChatState = { ...s, busy: true, unconfirmed: [...(s.unconfirmed ?? []), e.id], ...(at !== undefined ? { lastLineAt: at } : {}) };
      // Sent while Claude works, or waits on a card: it waits at the bottom
      // until Claude takes it (port item 72; decision 55), not among the steps.
      if (s.busy || s.compacting || s.pending.length || o.held || (s.queue ?? []).length) return { ...n, entries: { ...n.entries, [e.id]: e }, queue: [...(s.queue ?? []), e.id] };
      return put(n, e, null);
    }
    case "_dequeued": {
      // Taken back before Claude took it (cancel_async_message): gone, its text back in the draft.
      const id = String(o.id);
      if (!(s.queue ?? []).includes(id)) return s;
      const entries = { ...s.entries };
      delete entries[id];
      return { ...s, entries, queue: s.queue.filter((x) => x !== id), unconfirmed: (s.unconfirmed ?? []).filter((x) => x !== id) };
    }
    case "_process":
      return {
        ...s,
        process: o.state as ProcessState,
        processError: (o.error as string) ?? null,
        ...(o.state === "closed" || o.state === "error" ? { busy: false, streaming: null, pending: [], compacting: false } : {}),
      };
    case "_answered": {
      const p = s.pending.find((x) => x.requestId === o.requestId);
      let n: ChatState = { ...s, pending: s.pending.filter((x) => x.requestId !== o.requestId) };
      if (p?.toolUseId) n = patch(n, p.toolUseId, "tool", () => ({ status: o.behavior === "deny" ? "denied" : "running" }));
      return n;
    }
    case "_proposed":
      return {
        ...s,
        pending: s.pending.map((p) => (p.requestId === o.requestId ? { ...p, input: o.input as Record<string, unknown>, kept: typeof o.kept === "string" ? o.kept : undefined } : p)),
      };
    case "_unsent":
      return confirm(s, String(o.id), { held: false, unsent: true });
    case "_context":
      return { ...s, context: o.usage as ContextUsage };
    case "_model":
      return { ...s, model: String(o.model) };
    case "_mode":
      return { ...s, mode: String(o.mode) };
    case "_title":
      return { ...s, title: String(o.title) };
    case "_side": {
      const id = String(o.id);
      const side = s.side ?? [];
      if (typeof o.question === "string") return { ...s, side: [...side, { id, question: o.question, pending: true }] };
      return {
        ...s,
        side: side.map((q) => (q.id === id ? { ...q, pending: false, ...(typeof o.error === "string" ? { error: o.error } : { response: typeof o.response === "string" ? o.response : null }) } : q)),
      };
    }
    case "_sideClear":
      return { ...s, side: (s.side ?? []).filter((q) => q.pending) };
    case "_note":
      return note(s, String(o.text), (o.tone as NoteEntry["tone"]) ?? "info", typeof o.kept === "string" ? o.kept : undefined);
    default:
      return s;
  }
}
