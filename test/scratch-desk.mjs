// A scratch embarch-desk for the tests (never the live one on :4891): a
// binary built from ../embarch-desk (EMBARCH_DESK_BIN), its own data and
// config folders, and a port from the tests' scratch range, 4980–4989:
//
//   desk.test 4980–4981 · host.test 4982–4983 · resume.test 4984–4985
//   settings.test 4986–4987 · webview.e2e 4988–4989
//
// (desk.test's older desk, EMBARCH_DESK_OLD_BIN, takes 4981 for its one test.)
//
// A `start` mailbox entry is written only by Start work, server-side (the
// desk refuses one posted to /mailbox), and Start work needs Linear and a
// worktree; the tests seed one into the desk's store instead, while it is
// stopped.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");

export const BIN = process.env.EMBARCH_DESK_BIN;
export const haveDesk = !!BIN && fs.existsSync(BIN);
/** Optional: a desk older than the chat panel's side (e.g. built from 80368bf), for the "update embarch-desk" notice. */
export const OLD_BIN = process.env.EMBARCH_DESK_OLD_BIN;
export const haveOldDesk = !!OLD_BIN && fs.existsSync(OLD_BIN);

/** A port in [base, base + n). */
export const scratchPort = (base, n = 2) => base + Math.floor(Math.random() * n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ScratchDesk {
  /** `claudeDir`: the scratch CLAUDE_CONFIG_DIR the desk reads memory files from (never the owner's). */
  constructor(dir, port, claudeDir = path.join(dir, "claude"), bin = BIN) {
    this.dir = dir;
    this.port = port;
    this.claudeDir = claudeDir;
    this.bin = bin;
    this.proc = null;
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    this.url = `http://127.0.0.1:${port}`;
    this.tokenPath = path.join(dir, "config", "desk-token");
    this.client = new core.DeskClient({ baseUrl: this.url, tokenPath: this.tokenPath });
  }

  async start() {
    // The desk runs `claude agents --json` from PATH every 30 s: it gets the
    // fake (which lists nothing), never the real CLI.
    const bin = path.join(this.dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    if (!fs.existsSync(path.join(bin, "claude"))) fs.symlinkSync(FAKE, path.join(bin, "claude"));
    const { FAKE_CLAUDE_ARGS_LOG: _log, FAKE_CLAUDE_AGENTS: _agents, ...env } = process.env;
    this.proc = spawn(this.bin, ["serve"], {
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        EMBARCH_DESK_DATA_DIR: path.join(this.dir, "data"),
        EMBARCH_DESK_CONFIG_DIR: path.join(this.dir, "config"),
        EMBARCH_DESK_PORT: String(this.port),
        CLAUDE_CONFIG_DIR: this.claudeDir,
      },
      stdio: "ignore",
    });
    const exited = new Promise((r) => this.proc.once("exit", r));
    for (let i = 0; i < 150; i++) {
      // An authenticated read: only our desk holds the token it wrote, so a
      // stray desk already on the port never passes for ours. (/view: an
      // older desk has no /settings.)
      if (await this.client.call("GET", "/view").then(() => true, () => false)) return this;
      if (this.proc.exitCode !== null) break;
      await sleep(70);
    }
    this.proc.kill();
    await exited;
    throw new Error(`the scratch desk did not start on ${this.port}`);
  }

  /** SIGTERM: the desk saves its state on the way out. */
  async stop() {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    const done = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    await done;
    this.proc = null;
  }

  /** The desk's own store, read while it is stopped. */
  state() {
    return JSON.parse(fs.readFileSync(path.join(this.dir, "data", "state.json"), "utf8"));
  }

  /** Leaves a `start` entry as Start work would, in the store, while the desk is stopped. */
  seedStart({ item_id, folder, prompt }) {
    const file = path.join(this.dir, "data", "state.json");
    const st = this.state();
    const now = Date.now();
    const id = `m-seed-${now.toString(36)}`;
    st.mailbox = [...(st.mailbox ?? []), { id, kind: "start", item_id, session_id: null, folder, prompt, created_ms: now, expires_ms: now + 10 * 60_000, taken_ms: null }];
    fs.writeFileSync(file, JSON.stringify(st, null, 2));
    return id;
  }

  /** Stops the desk, seeds a start entry, starts it again. */
  async withStart(entry) {
    await this.stop();
    const id = this.seedStart(entry);
    await this.start();
    return id;
  }
}
