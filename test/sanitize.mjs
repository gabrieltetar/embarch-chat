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
const NEUTRAL_COST = "Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 1s\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write";

const scrub = (s) => {
  for (const [from, to] of swaps) {
    s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
  }
  return s;
};

// A tool's input and a reply's text stream as fragments that can split a
// path anywhere. A tool's fragments are joined into a single delta, scrubbed
// whole; a reply's are joined only when a path spans them, so a fixture
// keeps its streaming where nothing needed scrubbing.
const out = [];
let held = null;
const FIELD = { input_json_delta: "partial_json", text_delta: "text" };
const flush = () => {
  if (!held) return;
  const f = FIELD[held.type];
  if (held.type === "text_delta" && scrub(held.text) === held.text) {
    for (const e of held.lines) out.push(scrub(JSON.stringify(e)));
  } else {
    const e = held.lines[0];
    e.o.event.delta[f] = held.text;
    out.push(scrub(JSON.stringify(e)));
  }
  held = null;
};
for (const line of fs.readFileSync(src, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  const o = e.o;
  const dt = o.type === "stream_event" ? o.event?.delta?.type : undefined;
  if (dt && FIELD[dt]) {
    const piece = o.event.delta[FIELD[dt]];
    const h = held?.lines[0].o;
    if (held && held.type === dt && h.event.index === o.event.index && h.parent_tool_use_id === o.parent_tool_use_id) {
      held.text += piece;
      held.lines.push(e);
    } else {
      flush();
      held = { lines: [e], type: dt, text: piece };
    }
    continue;
  }
  flush();
  if (o.type === "rate_limit_event") continue;
  // /cost answers with the account's own usage and limits: a neutral answer instead.
  delete o.usage_report;
  if (o.type === "assistant" && ["cost", "usage"].includes(o.local_command_run?.command)) {
    o.message.content = [{ type: "text", text: NEUTRAL_COST }];
    o.local_command_source = `<local-command-stdout>${NEUTRAL_COST}</local-command-stdout>`;
  }
  if (o.type === "result" && ["cost", "usage"].includes(o.local_command)) o.result = NEUTRAL_COST;
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
