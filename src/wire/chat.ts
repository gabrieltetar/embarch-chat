// One chat: its state, and the `claude` process behind it while it is in use.
// A chat's process does not outlive its use (decision 41): it closes a set
// time after the last input or reply — Claude's default prompt-cache
// lifetime — unless a background task runs or it waits on the owner, and the
// next message resumes it.

import { EventEmitter } from "events";
import * as fs from "fs";
import { ClaudeProcess, SpawnSpec, chatEnv } from "./process";
import { findTranscript, holdsMessage, projectsRoot } from "./transcript";
import { ChatState, Pending, chatStatus, initialState, reduce, reduceAll, textOf } from "./reducer";
import type { ContextUsage, PermissionDecision, WireMessage } from "./types";
import { DIALOG_CANCELLED, answerable, unansweredNote } from "./dialogs";

export interface ChatOptions {
  sessionId: string;
  cwd: string;
  claudePath: string;
  /** True when the session already has a transcript, so the first process resumes it. */
  existing: boolean;
  idleMs: number;
  mode?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra CLI flags, for tests (a stripped model, no MCP, ...). */
  extraArgs?: string[];
  log?: (line: string) => void;
}

export interface Attachment {
  /** base64 image data; pasted images ride the wire as image blocks. */
  mediaType: string;
  data: string;
}

/** How many lines a followed transcript passes on to the page one by one; more go as a snapshot. */
const FOLLOW_AS_EVENTS = 50;

/** A line that says a /compact has run: its boundary, or its output (or error) as a local command. */
function isCompactEnd(o: WireMessage): boolean {
  if (o.type === "system" && o.subtype === "compact_boundary") return true;
  if (o.type !== "user") return false;
  const t = textOf((o.message as { content?: unknown } | undefined)?.content).trim();
  return t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-stderr>");
}

/**
 * Events: `event` (one folded line or host event, for webviews to fold too),
 * `status` (the list-visible status changed), `closed` (the process went
 * away), `turn` (a turn ended: the result, and how many turns this chat has
 * had in this window), `suggestion` (the CLI's own guess at the next prompt,
 * decision 25), `unsent` (text that will not be sent — held for a
 * compaction that will not come, or not taken by a process that died — for
 * the draft).
 */
export class Chat extends EventEmitter {
  state: ChatState;
  private proc: ClaudeProcess | undefined;
  private hasSession: boolean;
  private model: string | undefined;
  private sent = 0;
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private closing = false;
  private lastStatus: string;
  /** The rest of a draft that waits for its /compact line's compaction to finish (decision 36). */
  private held: string | null = null;
  /** The held rest's entry, shown as waiting for the compaction. */
  private heldEntry: string | null = null;
  /** The held /compact has run (its boundary or its output came): the next result is its own. */
  private compactRan = false;
  private disposed = false;
  /** Turns ended in this window, compactions aside: naming runs after the first (decision 12). */
  turns = 0;
  /** Named with rename_session here: Claude's own ai-title no longer applies. */
  renamed = false;

  constructor(readonly opts: ChatOptions) {
    super();
    this.state = initialState(opts.sessionId, opts.mode ?? "auto");
    this.state = { ...this.state, cwd: opts.cwd };
    this.hasSession = opts.existing;
    this.lastStatus = chatStatus(this.state);
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }

  get running(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Folds history (from a transcript) without a process. */
  preload(events: WireMessage[]): void {
    this.state = reduceAll(this.state, events);
    this.emit("event", { type: "_snapshot" });
  }

  /**
   * Lines a transcript gained (a thread run elsewhere, every 3 s while it is
   * on screen): folded here as one batch — a line-by-line fold copies a long
   * chat's entries for every line, on the extension host — and passed on as
   * they are for the page to fold, or past a few dozen as one snapshot.
   */
  follow(events: WireMessage[]): void {
    this.state = reduceAll(this.state, events);
    if (events.length > FOLLOW_AS_EVENTS) {
      this.emit("event", { type: "_snapshot" });
      return;
    }
    for (const e of events) this.emit("event", e);
  }

  private dispatch(o: WireMessage): void {
    this.state = reduce(this.state, o);
    this.emit("event", o);
    const st = chatStatus(this.state);
    if (st !== this.lastStatus) {
      this.lastStatus = st;
      this.emit("status", st);
    }
  }

  private log(line: string): void {
    this.opts.log?.(`[${this.sessionId.slice(0, 8)}] ${line}`);
  }

  /** Messages written while the process was closing (an idle close under way): they go to the resumed one, once it has exited. */
  private queued: Array<string | unknown[]> = [];

  /**
   * Before a new chat's process starts again: one that died in its first
   * turn, before the reply that says the session exists, may have left a
   * transcript, and the CLI refuses `--session-id` for an id that has one
   * ("already in use") — every later message would fail the same way. A
   * transcript with the first message in it is resumed. One with only the
   * CLI's queue lines cannot be resumed either ("No conversation found"):
   * it holds no conversation, so it is set aside and the id starts afresh.
   */
  private settleSession(env: NodeJS.ProcessEnv): void {
    // A brand-new id has no transcript until a process of this chat's ran.
    if (this.hasSession || !this.proc) return;
    const file = findTranscript(this.sessionId, this.opts.cwd || undefined, projectsRoot(env));
    if (!file) return;
    if (holdsMessage(file)) {
      this.hasSession = true;
      this.log("a transcript from a process that died in the first turn: resumed");
      return;
    }
    const aside = `${file}.unstarted-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      this.log(`a transcript with no message, from a process that died in the first turn: set aside as ${aside}`);
    } catch (e) {
      this.log(`could not set aside ${file}: ${(e as Error).message}`);
    }
  }

  private ensureProcess(): ClaudeProcess {
    if (this.proc && !this.proc.exited) return this.proc;
    const env = this.opts.env ?? chatEnv();
    this.settleSession(env);
    const spec: SpawnSpec = {
      claudePath: this.opts.claudePath,
      cwd: this.opts.cwd,
      sessionId: this.sessionId,
      resume: this.hasSession,
      permissionMode: this.state.mode,
      model: this.model,
      env,
      extraArgs: this.opts.extraArgs,
    };
    const proc = new ClaudeProcess(spec);
    this.proc = proc;
    this.closing = false;
    this.dispatch({ type: "_process", state: "starting" });
    proc.on("message", (o: WireMessage) => {
      if (this.proc !== proc) return;
      // When it came, on the host's clock: the pages fold the same time (decision 68).
      o._at = Date.now();
      if (this.state.process !== "running") this.dispatch({ type: "_process", state: "running" });
      // A request nothing here can show is refused at once, never left to wait (decision 66).
      if (o.type === "control_request" && !answerable(o.request as { subtype?: string } | undefined)) {
        const r = o.request as { subtype?: string; dialog_kind?: string } | undefined;
        this.log(`refused ${r?.subtype}${r?.dialog_kind ? ` (${r.dialog_kind})` : ""}`);
        // An undeclared dialog is cancelled, as Claude Code's own panel answers one; anything else is an error.
        if (r?.subtype === "request_user_dialog") proc.answer(String(o.request_id), DIALOG_CANCELLED);
        else proc.refuse(String(o.request_id), unansweredNote(r));
      }
      if (o.type === "prompt_suggestion") {
        if (typeof o.suggestion === "string") this.emit("suggestion", o.suggestion);
        return;
      }
      if ((o.type === "user" && o.isReplay) || o.type === "result") this.hasSession = true;
      this.dispatch(o);
      if (this.held !== null && isCompactEnd(o)) this.compactRan = true;
      if (o.type === "result") {
        this.touch();
        // A turn that failed or was stopped before the held /compact ran:
        // the compaction will not finish, so its rest never goes on its own.
        if (this.held !== null && !this.compactRan && (o.is_error || o.subtype !== "success")) this.releaseHeld();
        if (this.held !== null && this.compactRan) {
          // The compaction finished: now the rest of the draft.
          const rest = this.held;
          this.held = null;
          this.heldEntry = null;
          this.compactRan = false;
          this.deliver(rest);
        } else {
          this.turns++;
          this.emit("turn", o, this.turns);
        }
        void this.refreshContext();
      } else if (o.type === "system" && (o.subtype === "background_tasks_changed" || o.subtype === "task_notification")) {
        this.touch();
      }
    });
    proc.on("error", (err: Error) => {
      if (this.proc !== proc) return;
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT" ? `claude not found: ${this.opts.claudePath}` : err.message;
      this.log(`spawn failed: ${msg}`);
      this.dispatch({ type: "_process", state: "error", error: msg });
      this.emit("closed");
    });
    proc.on("exit", (info: { code: number | null; signal: string | null; stderr: string }) => {
      if (this.proc !== proc) return;
      const expected = this.closing;
      // Gone on its own (a crash, a kill): what it had not taken goes back to
      // the owner — a held rest included, as for a stopped compaction (36).
      if (!expected) this.releaseUntaken();
      this.log(`exit ${info.code ?? info.signal}${expected ? " (idle close)" : ""}`);
      // A signal (killed, out of memory, a crash) is no idle close either.
      if (!expected && (info.code || info.signal)) {
        this.dispatch({ type: "_process", state: "error", error: info.stderr.split("\n").slice(-3).join("\n") || `claude exited with ${info.code ?? info.signal}` });
      } else {
        this.dispatch({ type: "_process", state: "closed" });
      }
      this.clearIdle();
      this.emit("closed");
      // Only after an idle close of ours does a process start again unasked.
      if (expected && this.queued.length && !this.disposed) {
        // Sent while it was closing: the next process, resumed, takes them.
        const q = this.queued;
        this.queued = [];
        setImmediate(() => {
          const next = this.ensureProcess();
          for (const c of q) next.sendUser(c);
          this.touch();
        });
      }
    });
    this.log(`spawn ${spec.resume ? "resume" : "new"} mode=${spec.permissionMode}${spec.model ? " model=" + spec.model : ""}`);
    proc.start();
    return proc;
  }

  // ------------------------------------------------------------- the owner

  send(text: string, images: Attachment[] = []): void {
    const content: unknown[] | string = images.length
      ? [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })), { type: "text", text }]
      : text;
    this.dispatch({ type: "_sent", n: ++this.sent, text, images: images.length, at: Date.now() });
    this.deliver(content);
    this.touch();
  }

  /** To the running process; while one is closing, to the next, once it has gone (decision 41). */
  private deliver(content: string | unknown[]): void {
    if (this.proc && !this.proc.exited && (this.closing || this.proc.closing)) {
      this.queued.push(content);
      return;
    }
    const proc = this.ensureProcess();
    if (!proc.sendUser(content) && !proc.exited) this.queued.push(content);
  }

  /**
   * The compact card's draft (decision 36): its `/compact focus on: …` line
   * goes first, and the rest once that compaction has finished — shown at
   * once as a message waiting for it.
   */
  sendAfterCompact(compact: string, rest: string): void {
    this.send(compact);
    this.held = rest;
    this.compactRan = false;
    const n = ++this.sent;
    this.heldEntry = `s:${n}`;
    this.dispatch({ type: "_sent", n, text: rest, images: 0, held: true, at: Date.now() });
  }

  /**
   * After a process went away on its own: every message it had not taken
   * (sent but not echoed back, written while it was dying, or held for
   * after its compaction) is marked not sent and its text goes back to the
   * draft. Nothing is sent again to a process the owner did not start: a
   * crash is no idle close.
   */
  private releaseUntaken(): void {
    this.held = null;
    this.heldEntry = null;
    this.compactRan = false;
    this.queued = [];
    const ids = [...(this.state.unconfirmed ?? [])];
    for (const id of ids) {
      const e = this.state.entries[id];
      this.dispatch({ type: "_unsent", id });
      if (e?.kind === "user" && e.text.trim()) this.emit("unsent", e.text);
    }
    if (ids.length) this.log(`${ids.length} message(s) not taken before the exit: back in the draft`);
  }

  /**
   * The held rest goes back to the owner: marked not sent, its text back in
   * the draft (`unsent`) — a compaction that was stopped or failed must not
   * let it go out later, in the middle of other work.
   */
  private releaseHeld(): void {
    if (this.held === null) return;
    const text = this.held;
    const id = this.heldEntry;
    this.held = null;
    this.heldEntry = null;
    this.compactRan = false;
    if (id) this.dispatch({ type: "_unsent", id });
    this.log("held message not sent: back in the draft");
    this.emit("unsent", text);
  }

  answer(requestId: string, decision: PermissionDecision): void {
    const p = this.state.pending.find((x) => x.requestId === requestId);
    if (!p || !this.proc) return;
    this.proc.answer(requestId, decision as unknown as Record<string, unknown>);
    this.dispatch({ type: "_answered", requestId, behavior: decision.behavior });
    this.touch();
  }

  /** Answers a dialog or an MCP server's elicitation (decision 66) as the CLI's schema has it. */
  respond(p: Pending, response: Record<string, unknown>): void {
    if (p.form !== "dialog" && p.form !== "elicitation") return;
    this.answer(p.requestId, response as unknown as PermissionDecision);
  }

  /** Allow as asked, or with the CLI's own "don't ask again" suggestions. */
  allow(p: Pending, always = false, input?: Record<string, unknown>): void {
    const d: PermissionDecision = { behavior: "allow", updatedInput: input ?? p.input };
    if (always && Array.isArray(p.suggestions) && p.suggestions.length) d.updatedPermissions = p.suggestions;
    this.answer(p.requestId, d);
  }

  deny(p: Pending, message = "The user declined this tool call."): void {
    this.answer(p.requestId, { behavior: "deny", message });
  }

  /** Claude's question answered (`AskUserQuestion` counts as approve, decision 8). */
  answerQuestion(p: Pending, answers: Record<string, string>): void {
    this.answer(p.requestId, { behavior: "allow", updatedInput: { ...p.input, answers } });
  }

  async interrupt(): Promise<void> {
    // Stop: nothing held for after the compaction goes out on its own later.
    this.releaseHeld();
    if (!this.running) return;
    try {
      await this.proc!.request("interrupt");
    } catch (e) {
      this.log(`interrupt: ${(e as Error).message}`);
    }
  }

  async setMode(mode: string): Promise<void> {
    if (this.running) {
      try {
        await this.proc!.request("set_permission_mode", { mode });
      } catch (e) {
        this.dispatch({ type: "_note", text: `Mode not changed: ${(e as Error).message}`, tone: "error" });
        return;
      }
    }
    this.dispatch({ type: "_mode", mode });
  }

  async setModel(model: string): Promise<void> {
    if (this.running) {
      try {
        await this.proc!.request("set_model", { model });
      } catch (e) {
        this.dispatch({ type: "_note", text: `Model not changed: ${(e as Error).message}`, tone: "error" });
        return;
      }
    }
    this.model = model === "default" ? undefined : model;
    this.dispatch({ type: "_model", model });
  }

  /** Names the session (`rename_session`), so Claude Code's own panel and history show it too (decision 12). */
  async rename(title: string): Promise<void> {
    if (!this.running) return;
    try {
      await this.proc!.request("rename_session", { title });
      this.renamed = true;
      this.noteTitle(title);
    } catch (e) {
      this.log(`rename: ${(e as Error).message}`);
    }
  }

  async refreshContext(): Promise<void> {
    if (!this.running) return;
    try {
      const r = (await this.proc!.request("get_context_usage", {}, 10000)) as unknown as ContextUsage;
      this.dispatch({
        type: "_context",
        usage: {
          totalTokens: r.totalTokens,
          maxTokens: r.maxTokens,
          percentage: r.percentage,
          categories: (r.categories ?? []).map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
        },
      });
    } catch (e) {
      this.log(`context: ${(e as Error).message}`);
    }
  }

  /** The session's name as the transcript or a rename has it (decision 12). */
  noteTitle(title: string): void {
    if (title && title !== this.state.title) this.dispatch({ type: "_title", title });
  }

  compact(focus?: string): void {
    this.send(focus ? `/compact ${focus}` : "/compact");
  }

  // ------------------------------------------------------------- lifetime

  private touch(): void {
    this.lastActivity = Date.now();
    this.armIdle();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdle(): void {
    this.clearIdle();
    if (!this.running) return;
    const wait = Math.max(0, this.lastActivity + this.opts.idleMs - Date.now());
    this.idleTimer = setTimeout(() => this.idleCheck(), wait);
    this.idleTimer.unref?.();
  }

  /** Why the process stays up, or null when it may close. */
  holdReason(): string | null {
    if (!this.running) return null;
    if (this.state.pending.length) return "waits on the owner";
    if (this.state.background.length) return "a background task runs";
    if (this.state.busy || this.state.compacting) return "a turn is running";
    return null;
  }

  private idleCheck(): void {
    if (!this.running) return;
    if (Date.now() - this.lastActivity < this.opts.idleMs) return this.armIdle();
    const hold = this.holdReason();
    if (hold) {
      // Checked again when the hold lifts: every result and task event touches.
      this.log(`idle but kept: ${hold}`);
      this.idleTimer = setTimeout(() => this.idleCheck(), Math.min(this.opts.idleMs, 30000));
      this.idleTimer.unref?.();
      return;
    }
    this.closeProcess();
  }

  closeProcess(): void {
    if (!this.running) return;
    this.closing = true;
    this.proc!.close();
  }

  dispose(): void {
    this.disposed = true;
    this.queued = [];
    this.clearIdle();
    this.closing = true;
    this.proc?.kill();
    this.removeAllListeners();
  }
}
