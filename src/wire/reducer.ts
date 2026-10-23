// A chat's state, folded from the wire one message at a time. Pure and
// shared: the extension host folds every line it reads, and each webview
// showing the chat folds the same lines after one snapshot, so a streamed
// delta crosses postMessage as one small event, not as the whole chat.
//
// Events are either lines from the CLI (wire.ts types) or the host's own,
// whose type starts with "_" (a message sent, a prompt answered, the process
// starting or closing, a control response folded in).

import type { ContentBlock, ContextUsage, PermissionRequest, WireMessage } from "./types";

export type ProcessState = "none" | "starting" | "running" | "closed" | "error";

export interface UserEntry {
  kind: "user";
  id: string;
  text: string;
  images: number;
  /** Sent by this panel and not yet echoed back by the CLI. */
  pending?: boolean;
}
export interface TextEntry {
  kind: "text";
  id: string;
  text: string;
  parent: string | null;
}
export interface ThinkingEntry {
  kind: "thinking";
  id: string;
  text: string;
  parent: string | null;
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
}
export interface NoteEntry {
  kind: "note";
  id: string;
  text: string;
  tone: "info" | "error" | "compact" | "interrupt";
}
export type Entry = UserEntry | TextEntry | ThinkingEntry | ToolEntry | NoteEntry;

export interface Pending {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  description?: string;
  suggestions?: unknown[];
  /** How the panel shows it: a question form, a plan, or allow/deny. */
  form: "question" | "plan" | "permission";
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
  context: ContextUsage | null;
  lastTurn: { ok: boolean; subtype: string; error?: string } | null;
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
    context: null,
    lastTurn: null,
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

/** A slash command's echo, `<command-name>/x</command-name><command-args>y</command-args>`, as the owner typed it. */
function commandText(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
  return `${name.startsWith("/") ? name : "/" + name}${args ? " " + args : ""}`;
}

// ----------------------------------------------------------------- helpers

function put(s: ChatState, e: Entry, parent: string | null): ChatState {
  const entries = { ...s.entries, [e.id]: e };
  const host = parent ? entries[parent] : undefined;
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
  return { ...s, entries: { ...s.entries, [id]: { ...typed, ...f(typed) } } };
}

function note(s: ChatState, text: string, tone: NoteEntry["tone"]): ChatState {
  return put(s, { kind: "note", id: `n:${s.seq}`, text, tone }, null);
}

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n");
  return "";
}

// ----------------------------------------------------------------- folding

function foldAssistant(s: ChatState, o: WireMessage): ChatState {
  const msg = o.message as { id?: string; content?: ContentBlock[] } | undefined;
  if (!msg || !Array.isArray(msg.content)) return s;
  const parent = (o.parent_tool_use_id as string | null | undefined) ?? null;
  const msgId = msg.id ?? `m:${s.seq}`;
  for (const b of msg.content) {
    const sig =
      b.type === "tool_use" ? `${msgId}#u:${(b as { id: string }).id}` : `${msgId}#${b.type}:${hash(String((b as { text?: string; thinking?: string }).text ?? (b as { thinking?: string }).thinking ?? ""))}`;
    if (s.seen[sig]) continue;
    const n = s.finalized[msgId] ?? 0;
    s = { ...s, seen: { ...s.seen, [sig]: true }, finalized: { ...s.finalized, [msgId]: n + 1 } };
    if (b.type === "text") {
      const text = (b as { text: string }).text;
      if (text.trim()) s = put(s, { kind: "text", id: `${msgId}:${n}`, text, parent }, parent);
    } else if (b.type === "thinking") {
      const text = (b as { thinking: string }).thinking ?? "";
      if (text.trim()) s = put(s, { kind: "thinking", id: `${msgId}:${n}`, text, parent }, parent);
    } else if (b.type === "tool_use") {
      const t = b as { id: string; name: string; input: Record<string, unknown> };
      if (!s.entries[t.id]) {
        s = put(s, { kind: "tool", id: t.id, name: t.name, input: t.input ?? {}, parent, status: "running", children: [] }, parent);
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
      }));
    }
    if ((content as ContentBlock[]).every((b) => b.type === "tool_result")) return s;
  }
  if (o.isSynthetic || o.isMeta || o.isCompactSummary || parent) return s;
  const raw = textOf(content);
  if (raw.startsWith("[Request interrupted by user")) return note(s, "Interrupted", "interrupt");
  const stdout = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(raw.trim());
  if (stdout) return stdout[1].trim() ? note(s, stdout[1].trim(), "info") : s;
  if (/^<local-command-stderr>/.test(raw.trim())) return note(s, raw.replace(/<\/?local-command-stderr>/g, "").trim(), "error");
  const text = commandText(raw) ?? raw;
  const images = imagesOf(content);
  if (!text.trim() && !images) return s;
  // The CLI echoing what this panel sent (`--replay-user-messages`).
  const mine = s.timeline.find((id) => {
    const e = s.entries[id];
    return e.kind === "user" && e.pending && e.text.trim() === text.trim();
  });
  if (mine) return patch(s, mine, "user", () => ({ pending: false }));
  return put(s, { kind: "user", id: (o.uuid as string) ?? `u:${s.seq}`, text, images }, null);
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
      const m = o.compact_metadata as { pre_tokens?: number; trigger?: string } | undefined;
      const pre = m?.pre_tokens ? ` from ${Math.round(m.pre_tokens / 1000)}K tokens` : "";
      return note({ ...s, compacting: false }, `Compacted${pre}${m?.trigger === "auto" ? " (auto)" : ""}`, "compact");
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
      return patch(s, id, "tool", () => ({
        progress: text,
        ...(o.subtype === "task_started" ? { background: Boolean(o.is_backgrounded) } : {}),
      }));
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
      const r = o.request as PermissionRequest | undefined;
      if (!r || r.subtype !== "can_use_tool") return s;
      const p: Pending = {
        requestId: o.request_id as string,
        toolName: r.tool_name,
        input: r.input ?? {},
        toolUseId: r.tool_use_id,
        description: r.description,
        suggestions: r.permission_suggestions,
        form: formOf(r.tool_name),
      };
      if (s.pending.some((x) => x.requestId === p.requestId)) return s;
      let n: ChatState = { ...s, pending: [...s.pending, p] };
      if (p.toolUseId) n = patch(n, p.toolUseId, "tool", () => ({ status: "awaiting" }));
      return n;
    }
    case "control_cancel_request": {
      const id = o.request_id as string;
      return { ...s, pending: s.pending.filter((p) => p.requestId !== id) };
    }
    case "result": {
      const ok = !o.is_error && o.subtype === "success";
      const interrupted = s.timeline.length > 0 && s.entries[s.timeline[s.timeline.length - 1]]?.kind === "note" && (s.entries[s.timeline[s.timeline.length - 1]] as NoteEntry).tone === "interrupt";
      let n: ChatState = { ...s, busy: false, compacting: false, streaming: null, pending: [], lastTurn: { ok, subtype: String(o.subtype ?? "") } };
      if (!ok && !interrupted) {
        const errs = Array.isArray(o.errors) ? (o.errors as string[]).join("; ") : "";
        const text = errs || (typeof o.result === "string" && o.result) || `The turn ended with ${o.subtype}`;
        n = note({ ...n, lastTurn: { ok, subtype: String(o.subtype ?? ""), error: text } }, text, "error");
      }
      return n;
    }
    // ---- the host's own events
    case "_sent":
      return put({ ...s, busy: true }, { kind: "user", id: `s:${o.n}`, text: String(o.text ?? ""), images: Number(o.images ?? 0), pending: true }, null);
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
    case "_context":
      return { ...s, context: o.usage as ContextUsage };
    case "_model":
      return { ...s, model: String(o.model) };
    case "_mode":
      return { ...s, mode: String(o.mode) };
    case "_title":
      return { ...s, title: String(o.title) };
    case "_note":
      return note(s, String(o.text), (o.tone as NoteEntry["tone"]) ?? "info");
    default:
      return s;
  }
}
