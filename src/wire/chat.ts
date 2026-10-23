// One chat: its state, and the `claude` process behind it while it is in use.
// A chat's process does not outlive its use (decision 41): it closes a set
// time after the last input or reply — Claude's default prompt-cache
// lifetime — unless a background task runs or it waits on the owner, and the
// next message resumes it.

import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import * as fs from "fs";
import { ClaudeProcess, SpawnSpec, chatEnv } from "./process";
import { HostHooks, answererFor, initializeRequest } from "./host";
import { findTranscript, holdsMessage, projectsRoot } from "./transcript";
import { appendTitle } from "./history";
import { ChatState, Pending, chatStatus, initialState, reduce, reduceAll, textOf } from "./reducer";
import { anyMovable, soonMovable } from "./tasks";
import { Attachment, ContextItem, Outgoing, outgoing } from "./message";
import type { ContextUsage, PermissionDecision, WireMessage } from "./types";
import { DIALOG_CANCELLED, answerable, unansweredNote } from "./dialogs";
import { Destination, PlanComment, alwaysPermissions, planFeedback } from "./cards";

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
  /** A fork (decision 73): the first process copies `from`'s conversation up to its entry `at`. */
  fork?: { from: string; at: string };
  log?: (line: string) => void;
  /** What the panel does for the CLI (decisions 61, 65), read as each process starts: settings may have changed. */
  hooks?: () => HostHooks;
}

/** `rewind_files`' answer, as the CLI gives it. */
export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  /** Paths left alone because they are links. */
  skippedLinks?: number;
}

/** What goes with a message besides its text and images (decisions 56, 58, 60). */
export interface SendExtra {
  /** The editor's selection or open file, a terminal's output: blocks before the text. */
  context?: ContextItem[];
  /** Long pastes the owner made, marked by the CLI where the message still holds them. */
  pastes?: string[];
}

/** Claude Code's own words for a step rerun after a reload, and for one that will not be (decision 63). */
export const RERUN_NOTE = "Continuing the step that was interrupted when the window reloaded.";
export const NO_REPLY_NOTE = "No reply was recorded for this message before the session was reloaded.";
/** How old a step the CLI reruns, as Claude Code sets it (an hour). */
export const RERUN_MAX_AGE_MS = 3_600_000;

/** How long a side question may take, as Claude Code's panel allows (its SIDE_QUESTION_TIMEOUT_MS). */
const SIDE_MS = 300_000;

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
  /** The rest of a draft that waits for its /compact line's compaction to finish (decision 36), and its text for the draft. */
  private held: (Outgoing & { text: string }) | null = null;
  /** The held rest's entry, shown as waiting for the compaction. */
  private heldEntry: string | null = null;
  /** The held /compact has run (its boundary or its output came): the next result is its own. */
  private compactRan = false;
  private disposed = false;
  /** Turns ended in this window, compactions aside: naming runs after the first (decision 12). */
  turns = 0;
  /** Named with rename_session here: Claude's own ai-title no longer applies. */
  renamed = false;
  /** The next process reruns a step a window reload cut off (decision 63). */
  private rerun = false;
  /** Named by the owner (decision 75): Haiku's name does not come (decision 12). */
  handNamed = false;
  /** A name for a chat with no session yet, given once its first turn has ended. */
  private pendingTitle: string | null = null;

  /** The owner's name still waiting for the chat's first turn: what a reload must carry (decision 63). */
  get pendingName(): string | null {
    return this.pendingTitle;
  }

  /** A fork whose first process has not run yet (decision 73): where it starts from, for a reload to carry. */
  get pendingFork(): { from: string; at: string } | null {
    return this.hasSession ? null : (this.opts.fork ?? null);
  }

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

  /** The session exists: a process of it has taken a message, or the chat came from a transcript. */
  get started(): boolean {
    return this.hasSession;
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
  private queued: Array<Outgoing & { uuid?: string }> = [];

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
    // File checkpoints, as Claude Code's panel runs the CLI
    // (`enableFileCheckpointing`): what a rewind of a message's files needs
    // (decision 73) — for every process, a rerun after a reload too (63).
    let env: NodeJS.ProcessEnv = { ...(this.opts.env ?? chatEnv()), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" };
    this.settleSession(env);
    // The CLI's own rerun of an interrupted step, as Claude Code spawns it (63): this process only.
    const rerun = this.rerun;
    this.rerun = false;
    if (rerun) env = { ...env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1", CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: String(RERUN_MAX_AGE_MS) };
    let label = rerun;
    // The panel's own hooks and MCP servers (61, 65), read as each process starts, in its one initialize.
    const hooks = this.opts.hooks?.() ?? {};
    const init = initializeRequest(hooks);
    const spec: SpawnSpec = {
      claudePath: this.opts.claudePath,
      cwd: this.opts.cwd,
      sessionId: this.sessionId,
      resume: this.hasSession,
      permissionMode: this.state.mode,
      model: this.model,
      env,
      extraArgs: this.opts.extraArgs,
      ...(init ? { initialize: init } : {}),
      fork: this.hasSession ? undefined : this.opts.fork,
    };
    const proc = new ClaudeProcess(spec);
    // Their callbacks are answered in process.ts and never reach the refusal below (66).
    if (init) proc.answerer = answererFor(hooks, (l) => this.log(l));
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
      // The rerun's first frame says so (`resume_reason`): the label goes before it.
      if (label && typeof o.resume_reason === "string") {
        label = false;
        this.dispatch({ type: "_note", text: RERUN_NOTE, tone: "info" });
      }
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
          const heldId = this.heldEntry;
          this.held = null;
          this.heldEntry = null;
          this.compactRan = false;
          this.deliver(rest, this.uuidOf(heldId));
        } else {
          this.turns++;
          this.emit("turn", o, this.turns);
        }
        if (this.pendingTitle !== null) {
          const t = this.pendingTitle;
          this.pendingTitle = null;
          void this.rename(t);
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
          for (const c of q) next.sendUser(c.content, c.uuid, c.pastes);
          this.touch();
        });
      }
    });
    this.log(`spawn ${spec.resume ? "resume" : "new"} mode=${spec.permissionMode}${spec.model ? " model=" + spec.model : ""}`);
    proc.start();
    return proc;
  }

  // ------------------------------------------------------------- the owner

  send(text: string, images: Attachment[] = [], extra: SendExtra = {}): void {
    const context = extra.context ?? [];
    // Its own uuid: the CLI's queue knows it by it, to take it back or send it now (port item 72).
    const uuid = randomUUID();
    this.dispatch({ type: "_sent", n: ++this.sent, text, images: images.length, at: Date.now(), uuid, ...(context.length ? { context } : {}) });
    this.deliver(outgoing(text, images, context, extra.pastes), uuid);
    this.touch();
  }

  /** To the running process; while one is closing, to the next, once it has gone (decision 41). */
  private deliver(out: Outgoing, uuid?: string): void {
    const line = { content: out.content, pastes: out.pastes, uuid };
    if (this.proc && !this.proc.exited && (this.closing || this.proc.closing)) {
      this.queued.push(line);
      return;
    }
    const proc = this.ensureProcess();
    if (!proc.sendUser(line.content, uuid, line.pastes) && !proc.exited) this.queued.push(line);
  }

  private uuidOf(entryId: string | null): string | undefined {
    const e = entryId ? this.state.entries[entryId] : undefined;
    return e?.kind === "user" ? e.uuid : undefined;
  }

  /**
   * The compact card's draft (decision 36): its `/compact focus on: …` line
   * goes first, and the rest once that compaction has finished — shown at
   * once as a message waiting for it.
   */
  sendAfterCompact(compact: string, rest: string, images: Attachment[] = [], extra: SendExtra = {}): void {
    this.send(compact);
    const context = extra.context ?? [];
    this.held = { ...outgoing(rest, images, context, extra.pastes), text: rest };
    this.compactRan = false;
    const n = ++this.sent;
    this.heldEntry = `s:${n}`;
    this.dispatch({ type: "_sent", n, text: rest, images: images.length, held: true, at: Date.now(), uuid: randomUUID(), ...(context.length ? { context } : {}) });
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
    const text = this.held.text;
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

  /**
   * After a window reload (decision 63): starts the process, sending
   * nothing, with the CLI's own CLAUDE_CODE_RESUME_INTERRUPTED_TURN — the
   * CLI reruns a step the reload cut off, if the transcript ends in one.
   */
  continueInterrupted(): void {
    if (this.running || this.disposed) return;
    this.rerun = true;
    this.ensureProcess();
    this.touch();
  }

  /** A line of the panel's own in the chat. */
  note(text: string, tone: "info" | "error" = "info"): void {
    this.dispatch({ type: "_note", text, tone });
  }

  /** Answers a dialog or an MCP server's elicitation (decision 66) as the CLI's schema has it. */
  respond(p: Pending, response: Record<string, unknown>): void {
    if (p.form !== "dialog" && p.form !== "elicitation") return;
    this.answer(p.requestId, response as unknown as PermissionDecision);
  }

  /**
   * Allow as asked, or with the CLI's own "don't ask again" suggestions:
   * those the owner kept (`picks`, by index; all when not named), each rule
   * and directory saved where the owner picked (decision 78) — the CLI
   * writes that settings file itself.
   */
  allow(p: Pending, always: boolean | { picks?: number[]; destination?: Destination } = false, input?: Record<string, unknown>): void {
    const d: PermissionDecision = { behavior: "allow", updatedInput: input ?? p.input };
    if (always && Array.isArray(p.suggestions) && p.suggestions.length) {
      const o = always === true ? {} : always;
      const kept = alwaysPermissions(p.suggestions, o.picks, o.destination);
      if (kept.length) d.updatedPermissions = kept;
    }
    this.answer(p.requestId, d);
  }

  /**
   * The owner kept only some of a pending Edit's or Write's changes in its
   * diff tab (decision 64): Allow now sends this input; `kept` says so on
   * the card (null: all of them).
   */
  propose(requestId: string, input: Record<string, unknown>, kept: string | null): void {
    if (!this.state.pending.some((p) => p.requestId === requestId)) return;
    this.dispatch({ type: "_proposed", requestId, input, kept });
  }

  deny(p: Pending, message = "The user declined this tool call."): void {
    this.answer(p.requestId, { behavior: "deny", message });
  }

  /**
   * A plan approved (decision 77) as Claude Code's card approves it: the
   * mode set first, then the plan allowed, and the session stays in that
   * mode [measured]. "auto" falls back to accept edits on a model that
   * refuses auto mode, as Claude Code's does [measured: Haiku answers "auto
   * mode unavailable for this model"]; "default" is "Yes, and manually
   * approve edits", ask mode with the CLI's own setMode beside the allow.
   */
  async approvePlan(p: Pending, mode: "auto" | "default"): Promise<void> {
    if (p.form !== "plan") return;
    if (mode === "auto") {
      const refused = await this.trySetMode("auto");
      if (refused !== null) this.note(`${(await this.trySetMode("acceptEdits")) === null ? "Approved with edits accepted" : "Approved, mode unchanged"}: ${refused.replace(/\.$/, "")}.`);
      this.answer(p.requestId, { behavior: "allow", updatedInput: p.input });
      return;
    }
    await this.trySetMode("default");
    this.answer(p.requestId, { behavior: "allow", updatedInput: p.input, updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] });
  }

  /** The plan sent back (77): what the owner typed and the comments on its lines, in Claude Code's words; with neither the turn stops for the owner. */
  keepPlanning(p: Pending, typed: string): void {
    const { message, interrupt } = planFeedback(typed, p.comments ?? []);
    this.answer(p.requestId, { behavior: "deny", message, ...(interrupt ? { interrupt } : {}) });
  }

  /** The comments on a pending plan's lines, as its document tab has them (77). */
  planComments(requestId: string, comments: PlanComment[]): void {
    if (!this.state.pending.some((p) => p.requestId === requestId)) return;
    this.dispatch({ type: "_planComments", requestId, comments });
  }

  /** The mode as `setMode` sets it, without a note: null when set, else why not. */
  private async trySetMode(mode: string): Promise<string | null> {
    if (this.running) {
      try {
        await this.proc!.request("set_permission_mode", { mode });
      } catch (e) {
        return (e as Error).message;
      }
    }
    this.dispatch({ type: "_mode", mode });
    return null;
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

  // ------------------------------------------------- work that runs on its own

  /**
   * "Run in background" (port item 70): a Bash call or a subagent running in
   * the foreground goes on as a background task, and the turn goes on —
   * `background_tasks` with its tool_use_id, as Claude Code's own panel asks.
   */
  async runInBackground(toolUseId: string): Promise<void> {
    if (!this.running) return;
    try {
      const r = await this.proc!.request("background_tasks", { tool_use_id: toolUseId });
      if (r.backgrounded === false) this.dispatch({ type: "_note", text: "Not moved to the background: it may have just finished, or already run in the background.", tone: "error" });
    } catch (e) {
      this.dispatch({ type: "_note", text: `Not moved to the background: ${(e as Error).message}`, tone: "error" });
    }
  }

  /** Stops one background task — a shell, a Monitor, a subagent — and nothing else (port item 71). */
  async stopTask(taskId: string): Promise<void> {
    if (!this.running) return;
    try {
      await this.proc!.request("stop_task", { task_id: taskId });
    } catch (e) {
      this.dispatch({ type: "_note", text: `Task not stopped: ${(e as Error).message}`, tone: "error" });
    }
  }

  /** The end of a shell's or a Monitor's output (the last 8 KiB), running or ended; read-only, no turn. */
  async taskOutput(taskId: string): Promise<{ output: string; totalBytes: number; truncated: boolean }> {
    if (!this.running) throw new Error("claude is not running");
    const r = await this.proc!.request("get_task_output", { task_id: taskId }, 5000);
    return { output: String(r.output ?? ""), totalBytes: Number(r.total_bytes ?? 0), truncated: Boolean(r.truncated) };
  }

  /**
   * Takes back a message that waits for Claude (port item 72): the held
   * rest of a /compact draft, or one still in the CLI's queue
   * (`cancel_async_message`). Its text goes back to the draft. One Claude
   * already took stays; its echo moves it into the timeline.
   */
  async cancelQueued(id: string): Promise<void> {
    const e = this.state.entries[id];
    if (e?.kind !== "user" || !(this.state.queue ?? []).includes(id)) return;
    let gone = false;
    if (id === this.heldEntry) {
      this.held = null;
      this.heldEntry = null;
      this.compactRan = false;
      gone = true;
    } else if (this.queued.some((q) => q.uuid && q.uuid === e.uuid)) {
      // Written while the process was closing: not at the CLI yet.
      this.queued = this.queued.filter((q) => q.uuid !== e.uuid);
      gone = true;
    } else if (this.running && e.uuid) {
      try {
        gone = (await this.proc!.request("cancel_async_message", { message_uuid: e.uuid })).cancelled === true;
      } catch (err) {
        this.log(`cancel: ${(err as Error).message}`);
      }
    }
    if (!gone) return;
    this.dispatch({ type: "_dequeued", id });
    this.emit("unsent", e.text);
  }

  /**
   * Send now (port item 72): Claude takes the waiting message at once. A
   * step running in the foreground goes to the background and the turn
   * takes the message in, as the CLI's send-now key does since 2.1.281;
   * with none, an interrupt with `send_now` — which on CLI 2.1.287 stops
   * such a step rather than move it (recorded), hence the step first. A
   * step that cannot move (an MCP call) is stopped; the button says so.
   */
  async sendNow(id: string): Promise<void> {
    const e = this.state.entries[id];
    if (e?.kind !== "user" || !e.uuid || !this.running || !(this.state.queue ?? []).includes(id) || id === this.heldEntry) return;
    // A Bash call or a subagent just started: its task comes within a second, then it can move.
    for (let waited = 0; !anyMovable(this.state) && soonMovable(this.state) && waited < 3000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    try {
      if (anyMovable(this.state)) await this.proc!.request("background_tasks", {});
      else await this.proc!.request("interrupt", { send_now: true, message_uuid: e.uuid });
    } catch (err) {
      this.dispatch({ type: "_note", text: `Not sent now: ${(err as Error).message}`, tone: "error" });
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

  private asked = 0;

  /**
   * A side question (decision 57), Claude Code's /btw: the CLI's
   * `side_question` control request answers from the conversation and the
   * turn in progress — a tool call still running too — and adds nothing to
   * it. The answer stays beside the chat; earlier ones go along as history,
   * as Claude Code sends them. A closed chat resumes for it (`control`); a
   * first turn still running is asked before its session is on record.
   */
  async ask(question: string): Promise<void> {
    const id = `q:${++this.asked}`;
    const history = (this.state.side ?? []).filter((q) => typeof q.response === "string").map((q) => ({ question: q.question, response: q.response as string }));
    this.dispatch({ type: "_side", id, question });
    if (!this.hasSession && !this.running) {
      this.dispatch({ type: "_side", id, error: "Nothing to ask about yet: send a message first." });
      return;
    }
    const fields = { question, ...(history.length ? { history } : {}) };
    this.touch();
    try {
      const r = this.hasSession ? await this.control("side_question", fields, SIDE_MS) : await this.proc!.request("side_question", fields, SIDE_MS);
      this.dispatch({ type: "_side", id, response: typeof r.response === "string" ? r.response : null });
    } catch (e) {
      this.dispatch({ type: "_side", id, error: (e as Error).message });
    }
    this.touch();
  }

  /** Clears the answered side questions (Claude Code's "Clear side questions"). */
  clearSide(): void {
    this.dispatch({ type: "_sideClear" });
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

  /**
   * The owner's own name (decision 75), which wins over Haiku's (decision 12)
   * and over Claude's ai-title on every read: the running process takes it
   * with rename_session; a closed chat's transcript gets the custom-title
   * line Claude Code's own panel appends; a chat with no transcript yet
   * keeps it until its first turn ends.
   */
  async renameByHand(title: string): Promise<void> {
    this.handNamed = true;
    this.renamed = true;
    this.noteTitle(title);
    if (this.running && (this.closing || this.proc!.closing)) {
      // Closing: the name goes into its transcript once the process, which writes there too, has gone.
      this.once("closed", () => void this.renameByHand(title));
      return;
    }
    if (this.running && this.hasSession) {
      this.pendingTitle = null;
      await this.rename(title);
      return;
    }
    const file = this.hasSession ? findTranscript(this.sessionId, this.opts.cwd || undefined, projectsRoot(this.opts.env ?? chatEnv())) : null;
    if (file) {
      appendTitle(file, this.sessionId, title);
      this.pendingTitle = null;
    } else this.pendingTitle = title;
  }

  /**
   * A control request of the owner's to this chat's own process, resumed
   * for it when it has closed (decision 41) — a rewind, an export. Only a
   * chat whose session exists: a new one has nothing to ask about.
   */
  private async control(subtype: string, fields: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.hasSession) throw new Error("this chat has no conversation yet");
    if (this.proc && !this.proc.exited && (this.closing || this.proc.closing)) throw new Error("claude is closing; try again in a moment");
    const proc = this.ensureProcess();
    try {
      return await proc.request(subtype, fields, timeoutMs);
    } finally {
      // A process resumed for a request writes nothing on stdout until a message: it runs all the same.
      if (this.proc === proc && !proc.exited && this.state.process === "starting") this.dispatch({ type: "_process", state: "running" });
      this.touch();
    }
  }

  /**
   * The CLI's `rewind_files` (decision 73): the files Claude changed since the
   * owner's message `uuid` go back to how they were before it — or, as a
   * dry run, what that would change. Edits made by hand or by Bash are not
   * Claude's checkpoints and stay as they are.
   */
  async rewindFiles(uuid: string, dryRun: boolean): Promise<RewindResult> {
    const r = (await this.control("rewind_files", { user_message_id: uuid, ...(dryRun ? { dry_run: true } : {}) }, 30000)) as unknown as RewindResult;
    if (!dryRun && r.canRewind) this.log(`files rewound to before ${uuid.slice(0, 8)}`);
    return r;
  }

  /** The conversation as the plain text Claude Code's `/export` writes, and the file name it offers (decision 74). */
  async exportConversation(): Promise<{ text: string; filename: string }> {
    const r = await this.control("export_conversation", {}, 30000);
    if (typeof r.text !== "string") throw new Error("claude gave no text");
    return { text: r.text, filename: typeof r.default_filename === "string" ? r.default_filename : "conversation.txt" };
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
    if ((this.state.side ?? []).some((q) => q.pending)) return "a side question is out";
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
