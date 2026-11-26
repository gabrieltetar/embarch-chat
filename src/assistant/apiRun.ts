// A runner for `embarch-api --json <verb>` (decision 116), the chat's way to
// read what Core holds without a Core client: the binary `findBinary` finds
// (as Promptu's `--have` does), run in the chat's folder so it finds
// `embarch/embarch.toml` upward as every verb does. A 10 s limit, a result —
// or a failure — kept 5 minutes per folder and verb, so a run happens only on
// a cards call after the last one went stale. No binary: no spawn. A failure
// leaves the answer null and logs once per cause. Later linker kinds reuse it: the cache and the failure rule are the verb's own
// whatever it is (`list-studies --limit 20` is one verb here, words and all).

import * as cp from "child_process";
import { findBinary } from "../promptu/cli";
import { chatEnv } from "../wire/process";

/** A verb gets this long. */
export const API_TIMEOUT_MS = 10_000;
/** An answer, or a failure, is reused this long. */
export const API_CACHE_MS = 5 * 60_000;
/** The verb's output is read to this size. */
const OUT_CAP = 8 * 1024 * 1024;

type RunResult = { ok: true; out: string } | { ok: false; error: string };

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(bin, args, { cwd, env: chatEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: `could not start: ${(e as Error).message}` });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `took over ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (e) => finish({ ok: false, error: `could not start: ${e.message}` }));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      out += d;
      if (out.length > OUT_CAP) {
        child.kill();
        finish({ ok: false, error: "printed more than it is read" });
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (err = (err + d).slice(-2000)));
    child.on("close", (code) => {
      if (code !== 0) return finish({ ok: false, error: `failed (exit ${code ?? "killed"})${err.trim() ? `: ${err.trim().split("\n")[0]}` : ""}` });
      finish({ ok: true, out });
    });
  });
}

interface Read {
  at: number;
  json: unknown;
  /** The cause last logged, so the same one is said once. */
  logged: string | null;
}

/** Runs `embarch-api --json <verb>` per folder, cached; never rejects. */
export class ApiRunner {
  private reads = new Map<string, Read>();
  private busy = new Map<string, Promise<void>>();
  /** Runs, for the tests: cards calls inside the cache make one. */
  spawns = 0;

  constructor(private binary = "embarch-api") {}

  /** The last answer for a folder and verb: the output's JSON; null before the first, after a failed one or once it is not JSON. */
  get(folder: string, verb: string): unknown {
    return this.reads.get(`${folder}\0${verb}`)?.json ?? null;
  }

  /** Runs the verb when the last answer is over 5 minutes old; calls in the meantime wait for the one running. */
  refresh(folder: string, verb: string, log: (s: string) => void, now = Date.now(), timeoutMs = API_TIMEOUT_MS): Promise<void> {
    if (!folder) return Promise.resolve();
    const key = `${folder}\0${verb}`;
    const last = this.reads.get(key);
    if (last && now - last.at < API_CACHE_MS) return Promise.resolve();
    const running = this.busy.get(key);
    if (running) return running;
    const p = this.read(key, folder, verb, log, now, timeoutMs).finally(() => this.busy.delete(key));
    this.busy.set(key, p);
    return p;
  }

  private async read(key: string, folder: string, verb: string, log: (s: string) => void, now: number, timeoutMs: number): Promise<void> {
    const prev = this.reads.get(key);
    const fail = (cause: string, why: string) => {
      if (prev?.logged !== cause) log(`references: embarch-api ${verb} ${why}; nothing from it is offered`);
      this.reads.set(key, { at: now, json: null, logged: cause });
    };
    const exe = findBinary(this.binary);
    if (!exe) return void this.reads.set(key, { at: now, json: null, logged: "no-binary" });
    this.spawns++;
    const r = await run(exe, ["--json", ...verb.split(" ")], folder, timeoutMs);
    if (!r.ok) return fail(`run:${r.error}`, r.error);
    let json: unknown;
    try {
      json = JSON.parse(r.out);
    } catch {
      return fail("bad-json", "printed no JSON");
    }
    this.reads.set(key, { at: now, json, logged: null });
  }
}
