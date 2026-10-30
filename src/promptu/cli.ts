// The `promptu` CLI (embarch-promptu), run by the extension's Node side
// only: `prep` picks a pattern and plans the questions, `next` takes a page
// of answers, `render` writes the prompt (its contract §7–§8), `patterns`
// lists the set for the card's picker (95), `memory --json` is the Memory
// menu's data (98). The binary is `embarchChat.promptuPath`, `promptu` on
// PATH by default. Whatever goes wrong — not installed, a non-zero exit, a
// timeout, output that is not JSON — is one line, and the caller leaves the
// owner's draft as it was: Promptu never blocks sending (96).

import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { chatEnv } from "../wire/process";

/** One option of a question, in AskUserQuestion's shape (contract §7.8). */
export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/** One page: `ids[i]` names `questions[i]`. */
export interface AskPage {
  ids: string[];
  questions: AskQuestion[];
}

/** `prep`'s and `next`'s output (contract §7.8), as far as the chat reads it. */
export interface PrepOut {
  promptu: number;
  run: string;
  pattern: { id: string; version: number; picked_by: string; confidence: number | null; alt?: string[]; start_default?: boolean } | null;
  offline: boolean;
  offline_reason: string | null;
  mode?: string;
  filled: Array<{ q: string; header: string; value: unknown; source: string; entry?: string | null; evidence?: string | null }>;
  defaults: Array<{ q: string; header: string; value: unknown }>;
  choose: AskPage | null;
  pages: AskPage[];
  done: boolean;
  warnings?: string[];
  start?: boolean;
  /** Only when the run could not be saved: the prompt, every question at its recommendation. */
  prompt?: string;
  footer?: string;
}

/** `render`'s output (contract §8.3). */
export interface RenderOut {
  run: string;
  pattern: string | null;
  prompt: string;
  footer: string;
}

/** One task pattern, for the card's picker (`promptu patterns --json`). */
export interface PatternInfo {
  name: string;
  version: number;
  summary: string;
  desk?: string | null;
}

/** The answers `next` and `render` take (contract §8.1). */
export interface AnswerInput {
  pattern?: string;
  answers?: Record<string, string | string[] | { other: string } | { labels: string[]; other?: string }>;
}

export type Rest = "recommended" | "assume";

export interface CliResult<T> {
  ok: boolean;
  value?: T;
  /** One line: what went wrong. */
  error?: string;
  ms: number;
}

export interface CliSettings {
  /** `embarchChat.promptuPath`: a name looked up on PATH, or a path. */
  bin: string;
  log: (s: string) => void;
  /** For tests: the env each call runs with. */
  env?: NodeJS.ProcessEnv;
}

/** How long each command may take: `prep` runs the Sonnet pass (15 s by its own default) and gathers first. */
export const TIMEOUTS = { prep: 40_000, next: 10_000, render: 10_000, patterns: 10_000, memory: 20_000 };

/** The first line worth showing of a command's stderr. */
function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean)
      ?.replace(/^promptu:\s*/, "")
      .slice(0, 200) ?? ""
  );
}

/**
 * Where `bin` is: itself when it names a path, else the first executable of
 * that name on PATH — as a shell finds it. Null when there is none.
 */
export function findBinary(bin: string, envPath = process.env.PATH ?? ""): string | null {
  const executable = (p: string) => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return false;
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (!bin) return null;
  if (bin.includes("/")) return executable(bin) ? bin : null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    if (executable(p)) return p;
  }
  return null;
}

export class PromptuCli {
  constructor(private settings: () => CliSettings) {}

  /** The binary this window would run, or null: what lights the Promptu icon at all (95). */
  located(): string | null {
    const s = this.settings();
    return findBinary(s.bin, (s.env ?? process.env).PATH ?? "");
  }

  /**
   * Runs one command in `cwd` (the chat's folder: `prep` reads its checkout
   * and its memory there), `stdin` in, JSON out. Never rejects.
   */
  run<T>(args: string[], opts: { cwd: string; stdin?: string; timeoutMs: number; signal?: AbortSignal }): Promise<CliResult<T>> {
    const s = this.settings();
    const t0 = Date.now();
    const what = `promptu ${args[0]}`;
    return new Promise((resolve) => {
      let out = "";
      let err = "";
      let done = false;
      const finish = (r: Omit<CliResult<T>, "ms">) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const res = { ...r, ms: Date.now() - t0 };
        s.log(`${what}: ${res.ok ? "ok" : res.error} (${res.ms} ms)`);
        resolve(res);
      };
      let child: cp.ChildProcess;
      try {
        child = cp.spawn(s.bin, args, { cwd: opts.cwd || undefined, env: s.env ?? chatEnv(), stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        finish({ ok: false, error: `${what} could not start: ${(e as Error).message}` });
        return;
      }
      const onAbort = () => {
        child.kill();
        finish({ ok: false, error: "cancelled" });
      };
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: `${what} took over ${Math.round(opts.timeoutMs / 1000)} s` });
      }, opts.timeoutMs);
      timer.unref?.();
      child.on("error", (e: NodeJS.ErrnoException) =>
        finish({ ok: false, error: e.code === "ENOENT" ? `promptu is not installed here (${s.bin}): set embarchChat.promptuPath, or put promptu on PATH` : `${what}: ${e.message}` }),
      );
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => (out += d));
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (d: string) => (err = (err + d).slice(-4000)));
      child.on("close", (code) => {
        if (code !== 0) return finish({ ok: false, error: `${what} failed (exit ${code ?? "killed"})${firstLine(err) ? `: ${firstLine(err)}` : ""}` });
        try {
          finish({ ok: true, value: JSON.parse(out) as T });
        } catch {
          finish({ ok: false, error: `${what} printed no JSON` });
        }
      });
      child.stdin!.on("error", () => {
        /* it died first; close reports it */
      });
      child.stdin!.end(opts.stdin ?? "");
    });
  }

  prep(
    rough: string,
    o: { cwd: string; have: string[]; desk?: string | null; pattern?: string | null; quick?: boolean; start?: boolean; signal?: AbortSignal },
  ): Promise<CliResult<PrepOut>> {
    const args = ["prep", "--have", o.have.length ? o.have.join(",") : "none"];
    if (o.pattern) args.push("--pattern", o.pattern);
    if (o.quick) args.push("--rec");
    if (o.start) args.push("--start");
    if (o.desk) args.push("--desk", o.desk);
    return this.run<PrepOut>(args, { cwd: o.cwd, stdin: rough, timeoutMs: TIMEOUTS.prep, signal: o.signal });
  }

  next(run: string, input: AnswerInput, cwd: string, signal?: AbortSignal): Promise<CliResult<PrepOut>> {
    return this.run<PrepOut>(["next", run], { cwd, stdin: JSON.stringify(input), timeoutMs: TIMEOUTS.next, signal });
  }

  render(run: string, input: AnswerInput, rest: Rest | null, cwd: string, signal?: AbortSignal): Promise<CliResult<RenderOut>> {
    return this.run<RenderOut>(["render", run, ...(rest ? ["--rest", rest] : [])], { cwd, stdin: JSON.stringify(input), timeoutMs: TIMEOUTS.render, signal });
  }

  async patterns(cwd: string): Promise<CliResult<PatternInfo[]>> {
    const r = await this.run<{ patterns?: unknown }>(["patterns", "--json"], { cwd, timeoutMs: TIMEOUTS.patterns });
    if (!r.ok) return { ok: false, error: r.error, ms: r.ms };
    const list = Array.isArray(r.value?.patterns) ? (r.value!.patterns as PatternInfo[]) : [];
    return { ok: true, value: list.filter((p) => p && typeof p.name === "string").map((p) => ({ name: p.name, version: Number(p.version) || 0, summary: String(p.summary ?? ""), desk: p.desk ?? null })), ms: r.ms };
  }

  memory(cwd: string): Promise<CliResult<MemoryOut>> {
    return this.run<MemoryOut>(["memory", "--json"], { cwd, timeoutMs: TIMEOUTS.memory });
  }
}

// ------------------------------------------------------------ the Memory menu's data (98)

/** One use of a memory entry: a footer whose `filled=` named it (contract §5). */
export interface MemoryUse {
  pattern: string;
  question: string;
  date: string;
  changed?: boolean;
}

export interface MemoryEntry {
  scope: string;
  domain: string | null;
  kind: string | null;
  id: string;
  file: string;
  title: string;
  line: string | null;
  line_no: number | null;
  modified: string | null;
  age_days: number | null;
  review_by?: string | null;
  flags: string[];
  stale: boolean;
  used: MemoryUse[];
}

/** `promptu memory --json` (contract §5), as far as the menu reads it. */
export interface MemoryOut {
  promptu: number;
  project_root: string;
  today: string;
  hook?: string;
  memory: { path: string | null; exists: boolean; index: string | null };
  scopes: Array<{ id: string; label: string; files: string[]; domains: string[] }>;
  entries: MemoryEntry[];
  counts?: { entries: number; stale: number };
  used_scanned?: boolean;
  used_claude_md?: MemoryUse[];
}
