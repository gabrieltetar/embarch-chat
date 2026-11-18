#!/usr/bin/env node
// A wire probe: ask the live `claude` one question, see every line it sends
// back, unfiltered. A developer tool, not a test: `npm test` does not run it
// and nothing in the extension imports it. Needs `node build.mjs --tests`
// (test-out/core.js) for the panel's own flags.
//
//   node tools/wire-probe.mjs [--config-dir <dir>] [--bin <claude>] [--model <m>]
//        [--cwd <dir>] [--wait <ms>] --send <json>[@<delay-ms>] ...
//   node tools/wire-probe.mjs --list <fixture.jsonl>
//
// Each `--send` is one JSON line written to stdin, in order, `<delay-ms>`
// after the one before (default 0). `initialize` goes first, as the panel
// sends it. Every stdout line prints as `<ms since spawn> <line>`, whole.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const USAGE = `usage: wire-probe.mjs [--config-dir <dir>] [--bin <claude>] [--model <m>] [--cwd <dir>] [--wait <ms>] --send <json>[@<delay-ms>] ...
       wire-probe.mjs --list <fixture.jsonl>`;

/** One `--send` value: `<json>` or `<json>@<delay-ms>`; the delay is the digits after the last `@`, so `@` inside the JSON is safe. */
export function parseSend(text) {
  const m = /^([\s\S]*)@(\d+)$/.exec(text);
  const [json, delayMs] = m ? [m[1], Number(m[2])] : [text, 0];
  let value;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new Error(`--send is not JSON: ${json.slice(0, 60)} (${e.message})`);
  }
  return { value, delayMs };
}

export function parseArgs(argv) {
  const o = { sends: [], bin: "claude", waitMs: 5000 };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--config-dir": o.configDir = need(i++, a); break;
      case "--bin": o.bin = need(i++, a); break;
      case "--model": o.model = need(i++, a); break;
      case "--cwd": o.cwd = need(i++, a); break;
      case "--list": o.list = need(i++, a); break;
      case "--send": o.sends.push(parseSend(need(i++, a))); break;
      case "--wait": {
        const n = Number(need(i++, a));
        if (!Number.isInteger(n) || n < 0) throw new Error("--wait needs milliseconds");
        o.waitMs = n;
        break;
      }
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (o.list && o.sends.length) throw new Error("--list and --send do not combine");
  return o;
}

/** One row per fixture entry: direction, type, and the subtype or request id. */
export function listFixture(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    const o = e.o ?? {};
    const req = o.request ?? o.response ?? {};
    const detail = o.subtype ?? req.subtype ?? o.request_id ?? req.request_id ?? "";
    rows.push([e.d, o.type ?? "?", detail].join("\t").trimEnd());
  }
  return rows;
}

async function probe(o) {
  const require = createRequire(import.meta.url);
  const core = require("../test-out/core.js");
  const env = core.chatEnv(process.env);
  if (o.configDir) env.CLAUDE_CONFIG_DIR = o.configDir;
  const cwd = o.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "wire-probe-"));
  const args = core.claudeArgs({ claudePath: o.bin, cwd, sessionId: randomUUID(), resume: false, permissionMode: "default", model: o.model });
  const t0 = Date.now();
  const stamp = () => String(Date.now() - t0).padStart(6);
  const child = spawn(o.bin, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  child.on("error", (e) => {
    console.error(`spawn failed: ${e.message}`);
    process.exit(1);
  });
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      console.log(`${stamp()} ${buf.slice(0, i)}`);
      buf = buf.slice(i + 1);
    }
  });
  const write = (v) => child.stdin.write(JSON.stringify(v) + "\n");
  child.stdin.on("error", () => {});
  write({ type: "control_request", request_id: "probe-init", request: { subtype: "initialize", supportedDialogKinds: core.DIALOG_KINDS } });
  for (const s of o.sends) {
    await new Promise((r) => setTimeout(r, s.delayMs));
    write(s.value);
  }
  // Replies are the point: give them --wait ms after the last write, then end stdin.
  await new Promise((r) => setTimeout(r, o.waitMs));
  child.stdin.end();
  const kill = setTimeout(() => child.kill(), 5000);
  await new Promise((r) => child.on("exit", r));
  clearTimeout(kill);
  if (buf.trim()) console.log(`${stamp()} ${buf}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.list) console.log(listFixture(fs.readFileSync(o.list, "utf8")).join("\n"));
    else await probe(o);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
}
