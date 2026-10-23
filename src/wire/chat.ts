// One chat: its state, and the `claude` process behind it while it is in use.
// A chat's process does not outlive its use (decision 41): it closes a set
// time after the last input or reply — Claude's default prompt-cache
// lifetime — unless a background task runs or it waits on the owner, and the
// next message resumes it.

import { EventEmitter } from "events";
import { ClaudeProcess, SpawnSpec, chatEnv } from "./process";
import { ChatState, Pending, chatStatus, initialState, reduce } from "./reducer";
import type { ContextUsage, PermissionDecision, WireMessage } from "./types";

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

/**
 * Events: `event` (one folded line or host event, for webviews to fold too),
 * `status` (the list-visible status changed), `closed` (the process went
 * away), `turn` (a turn ended).
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
    for (const e of events) this.state = reduce(this.state, e);
    this.emit("event", { type: "_snapshot" });
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

  private ensureProcess(): ClaudeProcess {
    if (this.proc && !this.proc.exited) return this.proc;
    const spec: SpawnSpec = {
      claudePath: this.opts.claudePath,
      cwd: this.opts.cwd,
      sessionId: this.sessionId,
      resume: this.hasSession,
      permissionMode: this.state.mode,
      model: this.model,
      env: this.opts.env ?? chatEnv(),
      extraArgs: this.opts.extraArgs,
    };
    const proc = new ClaudeProcess(spec);
    this.proc = proc;
    this.closing = false;
    this.dispatch({ type: "_process", state: "starting" });
    proc.on("message", (o: WireMessage) => {
      if (this.proc !== proc) return;
      if (this.state.process !== "running") this.dispatch({ type: "_process", state: "running" });
      if ((o.type === "user" && o.isReplay) || o.type === "result") this.hasSession = true;
      this.dispatch(o);
      if (o.type === "result") {
        this.touch();
        this.emit("turn", o);
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
      this.log(`exit ${info.code ?? info.signal}${expected ? " (idle close)" : ""}`);
      if (!expected && info.code) {
        this.dispatch({ type: "_process", state: "error", error: info.stderr.split("\n").slice(-3).join("\n") || `claude exited with ${info.code}` });
      } else {
        this.dispatch({ type: "_process", state: "closed" });
      }
      this.clearIdle();
      this.emit("closed");
    });
    this.log(`spawn ${spec.resume ? "resume" : "new"} mode=${spec.permissionMode}${spec.model ? " model=" + spec.model : ""}`);
    proc.start();
    return proc;
  }

  // ------------------------------------------------------------- the owner

  send(text: string, images: Attachment[] = []): void {
    const proc = this.ensureProcess();
    const content: unknown[] | string = images.length
      ? [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })), { type: "text", text }]
      : text;
    this.dispatch({ type: "_sent", n: ++this.sent, text, images: images.length });
    proc.sendUser(content);
    this.touch();
  }

  answer(requestId: string, decision: PermissionDecision): void {
    const p = this.state.pending.find((x) => x.requestId === requestId);
    if (!p || !this.proc) return;
    this.proc.answer(requestId, decision as unknown as Record<string, unknown>);
    this.dispatch({ type: "_answered", requestId, behavior: decision.behavior });
    this.touch();
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

  async rename(title: string): Promise<void> {
    if (!this.running) return;
    try {
      await this.proc!.request("rename_session", { title });
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

  /** Claude's own ai-title, read from the transcript, until the assistant names chats (decision 12). */
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
    this.clearIdle();
    this.closing = true;
    this.proc?.kill();
    this.removeAllListeners();
  }
}
