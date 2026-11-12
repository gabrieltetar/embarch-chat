// A chat's settings before its first message (EMB-164): the login's models
// and the effort levels each takes, the folder's MCP servers, and whether
// Remote Control starts with a chat (100) — what a chat's own process says
// only once it runs, and it starts on the first message. One short `claude`
// per login and folder answers `initialize` and `mcp_status` and closes. It
// is sent no message: no tokens, no transcript, no bridge [measured
// 2026-11-11]; no hook runs and the desk never sees it, as it is nobody's
// chat. Its answer is kept for the window's life and asked again when a
// chat starts more than a minute after it; a chat's own process replaces it
// (Chat.seedStartup).

import { randomUUID } from "crypto";
import { ClaudeProcess } from "./wire/process";
import { StartupInfo, bridgesAtStartup, modelInfos } from "./wire/chat";

/** How long an answer stands before a new chat asks again. */
export const PROBE_FRESH_MS = 60_000;
/** How long the probe waits for the CLI's answer to `initialize`, as the Agent SDK allows. */
const INIT_MS = 60_000;
/** How long it waits for its MCP servers to stop connecting, asking each second. */
const MCP_WAIT_MS = 15_000;
const MCP_POLL_MS = 1_000;
const MCP_ASK_MS = 10_000;

export interface ProbeOptions {
  claudePath: string;
  log: (line: string) => void;
  /** The login's warm-up while its token is due (105): the probe waits on it like a chat. */
  gate?: (env: NodeJS.ProcessEnv) => Promise<void> | null;
}

interface Entry {
  info: StartupInfo | null;
  at: number;
  probing: boolean;
  /** Who takes the answers of the probe under way: models and Remote Control first, then the MCP servers. */
  listeners: Array<(info: StartupInfo) => void>;
}

export class StartupProbes {
  private entries = new Map<string, Entry>();

  constructor(private opts: () => ProbeOptions) {}

  /**
   * Hands `use` what is known for this login and folder at once, and each
   * answer of a probe under way or started now, when the last is over a
   * minute old.
   */
  get(env: NodeJS.ProcessEnv, cwd: string, use: (info: StartupInfo) => void): void {
    if (!cwd) return;
    const key = `${env.CLAUDE_CONFIG_DIR ?? ""}\n${cwd}`;
    let e = this.entries.get(key);
    if (!e) {
      e = { info: null, at: 0, probing: false, listeners: [] };
      this.entries.set(key, e);
    }
    if (e.info) use(e.info);
    if (e.probing) {
      e.listeners.push(use);
      return;
    }
    if (e.info && Date.now() - e.at < PROBE_FRESH_MS) return;
    const entry = e;
    entry.probing = true;
    entry.listeners = [use];
    void this.probe(env, cwd, (info) => {
      entry.info = info;
      entry.at = Date.now();
      for (const l of entry.listeners) l(info);
    }).finally(() => {
      entry.probing = false;
      entry.listeners = [];
    });
  }

  private async probe(env: NodeJS.ProcessEnv, cwd: string, answer: (info: StartupInfo) => void): Promise<void> {
    const o = this.opts();
    const t0 = Date.now();
    const ready = o.gate?.(env) ?? null;
    const proc = new ClaudeProcess({
      claudePath: o.claudePath,
      cwd,
      sessionId: randomUUID(),
      resume: false,
      permissionMode: "default",
      env: { ...env, EMBARCH_DESK_INTERNAL: "1" },
      settings: { disableAllHooks: true },
      ...(ready ? { ready } : {}),
    });
    const where = env.CLAUDE_CONFIG_DIR ?? "the default login";
    try {
      const r = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no answer to initialize")), INIT_MS);
        timer.unref?.();
        proc.once("initialized", (x: Record<string, unknown>) => (clearTimeout(timer), resolve(x)));
        proc.once("exit", (x: { code: number | null; signal: string | null }) => (clearTimeout(timer), reject(new Error(`claude exited (${x.code ?? x.signal})`))));
        proc.once("error", (err: Error) => (clearTimeout(timer), reject(err)));
        proc.start();
      });
      const info: StartupInfo = {
        models: modelInfos(r.models),
        mcp: [],
        remote: bridgesAtStartup(r),
        remoteByDefault: r.remote_control_auto_enable === true && r.remote_control_auto_on_by_default === true,
      };
      answer(info);
      const until = Date.now() + MCP_WAIT_MS;
      let mcp: unknown[] = [];
      for (;;) {
        const s = await proc.request("mcp_status", {}, MCP_ASK_MS);
        mcp = Array.isArray(s.mcpServers) ? s.mcpServers : [];
        if (Date.now() > until || !mcp.some((x) => (x as { status?: unknown })?.status === "pending")) break;
        await new Promise((res) => setTimeout(res, MCP_POLL_MS));
      }
      if (mcp.length) answer({ ...info, mcp });
      o.log(`startup probe, ${where}: ${info.models.length} models, ${mcp.length} MCP servers, Remote Control at startup ${info.remote ? "on" : "off"} (${Date.now() - t0} ms)`);
    } catch (e) {
      o.log(`startup probe, ${where}: ${(e as Error).message}`);
    } finally {
      proc.close();
    }
  }
}
