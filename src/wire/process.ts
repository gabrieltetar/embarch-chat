// One `claude` process for one chat, over the wire Claude Code's own panel
// uses (decision 5): stream-json both ways, permission prompts on stdio.
// This file knows the flags and the framing; chat.ts decides when a process
// runs.

import * as cp from "child_process";
import { EventEmitter } from "events";
import type { WireMessage } from "./types";

export interface SpawnSpec {
  claudePath: string;
  cwd: string;
  sessionId: string;
  /** Resume an existing session (`--resume`) rather than start one with this id (`--session-id`). */
  resume: boolean;
  permissionMode: string;
  /** Omitted: the owner's default model (decision 22). */
  model?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}

/** The official panel's flags (proposal, "What is possible"), plus streaming and prompt suggestions. */
export function claudeArgs(spec: SpawnSpec): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool=stdio",
    "--setting-sources=user,project,local",
    `--permission-mode=${spec.permissionMode}`,
    "--replay-user-messages",
    "--include-partial-messages",
    // The CLI's own guess at the next prompt, one of the reply chips (decision 25).
    "--prompt-suggestions",
  ];
  args.push(...(spec.resume ? [`--resume=${spec.sessionId}`] : ["--session-id", spec.sessionId]));
  if (spec.model) args.push("--model", spec.model);
  if (spec.extraArgs) args.push(...spec.extraArgs);
  return args;
}

/** The extension host's environment, minus what would make the chat look like a child of some other Claude session. */
export function chatEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SSE_PORT", "EMBARCH_DESK_INTERNAL", "TRACEPARENT", "TRACESTATE"]) {
    delete env[k];
  }
  return env;
}

interface Waiter {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Events: `message` (a parsed stdout line), `exit` ({code, signal, stderr}),
 * `error` (spawn failure).
 */
export class ClaudeProcess extends EventEmitter {
  private child: cp.ChildProcess | undefined;
  private buf = "";
  private stderrTail = "";
  private waiters = new Map<string, Waiter>();
  private nextId = 1;
  readonly answered = new Set<string>();
  exited = false;

  constructor(readonly spec: SpawnSpec) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    const child = cp.spawn(this.spec.claudePath, claudeArgs(this.spec), {
      cwd: this.spec.cwd,
      env: this.spec.env ?? chatEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => this.onData(d));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.stdin!.on("error", () => {
      /* EPIPE after the process died; exit reports it */
    });
    child.on("error", (err) => {
      this.exited = true;
      this.failWaiters(err);
      this.emit("error", err);
    });
    child.on("exit", (code, signal) => {
      if (this.buf.trim()) this.onLine(this.buf);
      this.buf = "";
      this.exited = true;
      this.failWaiters(new Error(`claude exited (${code ?? signal})`));
      this.emit("exit", { code, signal, stderr: this.stderrTail.trim() });
    });
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let o: WireMessage;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.type === "control_response") {
      const r = o.response as { request_id?: string; subtype?: string; error?: string; response?: Record<string, unknown> } | undefined;
      const id = r?.request_id;
      // The CLI echoes our answers to its own permission prompts back; those
      // are not ours to resolve and carry nothing new.
      if (id && this.waiters.has(id)) {
        const w = this.waiters.get(id)!;
        this.waiters.delete(id);
        clearTimeout(w.timer);
        if (r?.subtype === "error") w.reject(new Error(r.error ?? "control request failed"));
        else w.resolve(r?.response ?? {});
      }
      return;
    }
    this.emit("message", o);
  }

  private failWaiters(err: Error): void {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
  }

  write(o: unknown): boolean {
    if (!this.child || this.exited || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(JSON.stringify(o) + "\n");
    return true;
  }

  sendUser(content: string | unknown[]): boolean {
    return this.write({ type: "user", message: { role: "user", content } });
  }

  /** A control request of ours (`interrupt`, `set_model`, ...), resolved by its response. */
  request(subtype: string, fields: Record<string, unknown> = {}, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const request_id = `ec-${Date.now().toString(36)}-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(request_id);
        reject(new Error(`${subtype}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(request_id, { resolve, reject, timer });
      if (!this.write({ type: "control_request", request_id, request: { subtype, ...fields } })) {
        clearTimeout(timer);
        this.waiters.delete(request_id);
        reject(new Error("claude is not running"));
      }
    });
  }

  /** Answers one of the CLI's `can_use_tool` prompts. */
  answer(requestId: string, response: Record<string, unknown>): boolean {
    this.answered.add(requestId);
    return this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  /** Ends stdin so the CLI finishes and exits; kills it if it lingers. */
  close(graceMs = 5000): void {
    if (!this.child || this.exited) return;
    this.child.stdin?.end();
    const child = this.child;
    setTimeout(() => {
      if (!this.exited) child.kill();
    }, graceMs).unref();
  }

  kill(): void {
    if (this.child && !this.exited) this.child.kill();
  }
}
