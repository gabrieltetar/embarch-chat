#!/usr/bin/env node
// Turns a raw recording from record.mjs into a fixture safe for a public
// repo: machine paths become /work, the init line keeps only what the
// panel reads, and account-level lines (rate limits) are dropped.
//
//   node test/sanitize.mjs <recording.jsonl> <fixture.jsonl> <scratch-dir>

import * as fs from "node:fs";

const [, , src, dst, scratch] = process.argv;
if (!src || !dst || !scratch) {
  console.error("usage: sanitize.mjs <recording.jsonl> <fixture.jsonl> <scratch-dir>");
  process.exit(2);
}

const home = process.env.HOME;
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const swaps = [
  [scratch, "/work/rec"],
  [enc(scratch), "-work-rec"],
  [`${home}/.claude`, "/home/user/.claude"],
  [home, "/home/user"],
  [enc(home), "-home-user"],
  [/\/tmp\/claude-\d+/g, "/tmp/claude-user"],
  [/\/run\/user\/\d+\/[^"]*/g, "/run/user/socket"],
];

const KEEP_INIT = ["type", "subtype", "session_id", "uuid", "cwd", "model", "permissionMode", "tools", "agents", "claude_code_version", "output_style", "apiKeySource", "capabilities", "mcp_servers"];
const NEUTRAL_COMMANDS = ["compact", "context", "cost", "init", "review", "security-review", "simplify"];

const scrub = (s) => {
  for (const [from, to] of swaps) {
    s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
  }
  return s;
};

// A tool's input streams as JSON fragments that can split a path anywhere,
// so the fragments of one block are joined into a single delta, scrubbed
// whole, before the block's next line.
const out = [];
let held = null;
const flush = () => {
  if (!held) return;
  held.e.o.event.delta.partial_json = held.json;
  out.push(scrub(JSON.stringify(held.e)));
  held = null;
};
for (const line of fs.readFileSync(src, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  const o = e.o;
  if (o.type === "stream_event" && o.event?.delta?.type === "input_json_delta") {
    if (held && held.e.o.event.index === o.event.index) held.json += o.event.delta.partial_json;
    else {
      flush();
      held = { e, json: o.event.delta.partial_json };
    }
    continue;
  }
  flush();
  if (o.type === "rate_limit_event") continue;
  if (o.type === "system" && o.subtype === "init") {
    const keep = {};
    for (const k of KEEP_INIT) if (k in o) keep[k] = o[k];
    keep.slash_commands = NEUTRAL_COMMANDS;
    e.o = keep;
  }
  out.push(scrub(JSON.stringify(e)));
}
flush();
fs.writeFileSync(dst, out.join("\n") + "\n");
console.log(`${dst}: ${out.length} lines`);
