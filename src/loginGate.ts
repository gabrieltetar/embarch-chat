// One refresh of the Claude login's token, run alone (decision 105). Every
// `claude` that finds the token due takes one lock in the login's folder,
// and a non-interactive one gives up after five tries 1–2 s apart [read from
// CLI 2.1.287]: a chat's first message, which starts its own process and
// Haiku's at once, then fails on whichever held the lock longest. So when the
// token is due one warm-up call runs first and is never killed; a chat's
// process waits for it, and Haiku calls are skipped until it is done.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { haikuEnv, runHaiku } from "./assistant/haiku";

/** The CLI refreshes a token this close to its expiry [CLI 2.1.287]: the gate's "due" is the CLI's. */
export const REFRESH_MARGIN_MS = 300_000;
/** The longest a chat's process waits on a warm-up: the refresh lock's own staleness [CLI 2.1.287]. */
export const GATE_MAX_MS = 60_000;
/** A warm-up still running after this is hung, and only then killed. */
const WARM_MS = 120_000;
/** After a turn ended on the lock: warm-ups this far apart, at most this many. */
const RECOVER_PAUSE_MS = 10_000;
const RECOVER_TRIES = 3;
const WARM_SYSTEM = "Reply with the single word OK.";
const WARM_PROMPT = "OK";

/** The login's folder, as the CLI picks it. */
export function loginDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** When the login's token expires (ms), from its credentials file, of which only `expiresAt` is kept. Null without one: an API key, the macOS keychain. */
export function tokenExpiry(dir: string): number | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"))?.claudeAiOauth?.expiresAt;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Whether a `claude` started now would refresh the token first. */
export function refreshDue(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && now + REFRESH_MARGIN_MS >= expiresAt;
}

/** The CLI's own words when it gave up on the lock, in both its phrasings [CLI 2.1.287]. */
const LOCK_TEXT = /another Claude Code process is refreshing it/;

/** A line that is the CLI's refresh-lock failure: the reply it makes up in place of Claude's. */
export function isRefreshLockError(o: { type?: unknown; message?: unknown }): boolean {
  if (o.type !== "assistant") return false;
  const content = (o.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((b) => !!b && (b as { type?: unknown }).type === "text" && LOCK_TEXT.test(String((b as { text?: unknown }).text)));
}

/** One stripped Haiku call under `env`, never cancelled: its error, or null. */
export async function warmUp(claudePath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await runHaiku({ claudePath, system: WARM_SYSTEM, prompt: WARM_PROMPT, env: haikuEnv(env), timeoutMs: WARM_MS });
  return r.error ?? null;
}

export interface GateDeps {
  /** One warm-up call under `env`, settled once its process has exited: its error, or null. */
  warm: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  log: (line: string) => void;
  /** For tests: the token's expiry, the clock, the waits. */
  expiry?: (dir: string) => number | null;
  now?: () => number;
  maxWaitMs?: number;
  pauseMs?: number;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** The warm-up per login folder, shared by the chats and the assistant of one window. */
export class LoginGate {
  private running = new Map<string, Promise<void>>();

  constructor(private deps: GateDeps) {}

  private expiry(dir: string): number | null {
    return (this.deps.expiry ?? tokenExpiry)(dir);
  }

  private due(dir: string): boolean {
    return refreshDue(this.expiry(dir), (this.deps.now ?? Date.now)());
  }

  /** Starts the folder's warm-up, or joins the one running. */
  private warm(env: NodeJS.ProcessEnv): Promise<void> {
    const dir = loginDir(env);
    let p = this.running.get(dir);
    if (p) return p;
    const t0 = Date.now();
    this.deps.log(`login ${dir}: token due, one warm-up call first`);
    p = this.deps
      .warm(env)
      .catch((e: Error) => e.message)
      .then((err) => this.deps.log(`login ${dir}: warm-up ${err ? `failed (${err})` : "done"} in ${Date.now() - t0} ms, token ${this.due(dir) ? "still due" : "fresh"}`))
      .finally(() => this.running.delete(dir));
    this.running.set(dir, p);
    return p;
  }

  /** What a chat's process waits on before it spawns: null when nothing is due, else the warm-up, for at most GATE_MAX_MS. */
  wait(env: NodeJS.ProcessEnv): Promise<void> | null {
    const dir = loginDir(env);
    if (!this.running.has(dir) && !this.due(dir)) return null;
    return Promise.race([this.warm(env), delay(this.deps.maxWaitMs ?? GATE_MAX_MS)]);
  }

  /** Whether a Haiku call is skipped: the token is due, or its warm-up runs. A due token starts the warm-up. */
  quiet(env: NodeJS.ProcessEnv): boolean {
    const dir = loginDir(env);
    if (this.running.has(dir)) return true;
    if (!this.due(dir)) return false;
    void this.warm(env);
    return true;
  }

  /**
   * After a turn ended on the lock: warm-ups a pause apart until the token is
   * fresh — at once if the lock's holder has refreshed it meanwhile — or the
   * tries run out. Whether it is. With no expiry to read, one warm-up, taken
   * as enough.
   */
  async recover(env: NodeJS.ProcessEnv): Promise<boolean> {
    const dir = loginDir(env);
    if (this.expiry(dir) === null) {
      await this.warm(env);
      return true;
    }
    for (let i = 0; i < RECOVER_TRIES; i++) {
      if (i) await delay(this.deps.pauseMs ?? RECOVER_PAUSE_MS);
      if (this.running.has(dir) || this.due(dir)) await this.warm(env);
      if (!this.due(dir)) return true;
    }
    return false;
  }
}
