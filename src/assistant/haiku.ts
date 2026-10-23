// One Haiku call (embarch-chat-assistant-proposal.md decision 26): a
// stripped, unsaved, streamed `claude -p` with thinking off, the prompt on
// stdin — measured at about 0.86 s to the first token and 1.1 s in all.
// `--tools ""` is variadic and would swallow a prompt given after it, hence
// stdin; `EMBARCH_DESK_INTERNAL=1` keeps the desk's hooks out of it;
// `--no-session-persistence` leaves no transcript in the owner's history.

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { chatEnv } from "../wire/process";

export interface HaikuCall {
  claudePath: string;
  system: string;
  prompt: string;
  /** Called with the whole text so far, on every streamed delta. */
  onText?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface HaikuResult {
  text: string;
  costUsd: number | null;
  /** From spawn to the first text delta. */
  firstTokenMs: number | null;
  ms: number;
  aborted: boolean;
  error?: string;
}

export function haikuArgs(system: string): string[] {
  return [
    "-p",
    "--model",
    "haiku",
    "--max-thinking-tokens",
    "0",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--system-prompt",
    system,
    "--tools",
    "",
  ];
}

let neutral: string | null = null;
/**
 * An empty folder of this process's own (mode 0700) for every call: no
 * project's CLAUDE.md or settings come along, and nobody else can plant
 * one — the shared temp folder is world-writable.
 */
export function neutralDir(): string {
  if (neutral && fs.existsSync(neutral)) return neutral;
  neutral = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-haiku-"));
  return neutral;
}

/** Removes the folder when the window goes. */
export function dropNeutralDir(): void {
  if (neutral) fs.rmSync(neutral, { recursive: true, force: true });
  neutral = null;
}

export function haikuEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...chatEnv(base), EMBARCH_DESK_INTERNAL: "1" };
}

/** Runs one call; resolves (never rejects) with what came back, `aborted` when the signal fired first. */
export function runHaiku(call: HaikuCall): Promise<HaikuResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let text = "";
    let final: string | null = null;
    let cost: number | null = null;
    let first: number | null = null;
    let done = false;
    let stderr = "";
    let buf = "";
    const finish = (r: Partial<HaikuResult>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onAbort);
      resolve({ text: final ?? text, costUsd: cost, firstTokenMs: first, ms: Date.now() - t0, aborted: false, ...r });
    };
    const child = cp.spawn(call.claudePath, haikuArgs(call.system), { cwd: neutralDir(), env: call.env ?? haikuEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const onAbort = () => {
      child.kill();
      finish({ aborted: true });
    };
    if (call.signal?.aborted) return onAbort();
    call.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      child.kill();
      finish({ error: `no answer in ${call.timeoutMs ?? 20000} ms` });
    }, call.timeoutMs ?? 20000);
    timer.unref?.();
    child.on("error", (e) => finish({ error: e.message }));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-2000)));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let o: { type?: string; event?: { delta?: { type?: string; text?: string } }; result?: unknown; total_cost_usd?: number; is_error?: boolean };
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === "stream_event" && o.event?.delta?.type === "text_delta" && o.event.delta.text) {
          if (first === null) first = Date.now() - t0;
          text += o.event.delta.text;
          call.onText?.(text);
        } else if (o.type === "result") {
          if (typeof o.result === "string") final = o.result;
          if (typeof o.total_cost_usd === "number") cost = o.total_cost_usd;
          if (o.is_error) finish({ error: typeof o.result === "string" ? o.result : "the call failed" });
        }
      }
    });
    child.on("exit", (code) => finish(code ? { error: stderr.trim().split("\n").slice(-2).join(" ") || `claude exited with ${code}` } : {}));
    child.stdin!.on("error", () => {
      /* the process died first; exit reports it */
    });
    child.stdin!.end(call.prompt);
  });
}
