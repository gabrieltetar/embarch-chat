#!/usr/bin/env node
// Turns a raw recording from record.mjs into a fixture safe for a public
// repo: machine paths become /work, the init line keeps only what the
// panel reads, a rate limit keeps its shape with neutral numbers, and the
// answer to the panel's initialize (the account, its commands) keeps only
// the session's state and the effort levels of the models the panel
// offers and whether Remote Control is offered, a `get_settings` answer
// only what the CLI runs at, an `mcp_status` answer no server's command
// line, and a Remote Control session a made-up id.
//
//   node test/sanitize.mjs <recording.jsonl> <fixture.jsonl> <scratch-dir>
//   node test/sanitize.mjs --transcript <session.jsonl> <fixture.jsonl> <scratch-dir>
//
// With --transcript it scrubs a transcript Claude wrote instead (a fork's
// parent, read by the panel): the conversation's chain and its titles stay,
// an attachment keeps only its kind and its place in the chain — they
// carry the account's email and organisation — and the CLI's bookkeeping lines go.

import * as fs from "node:fs";

const asTranscript = process.argv[2] === "--transcript";
const [src, dst, scratch] = process.argv.slice(asTranscript ? 3 : 2);
if (!src || !dst || !scratch) {
  console.error("usage: sanitize.mjs [--transcript] <recording.jsonl> <fixture.jsonl> <scratch-dir>");
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
  // A Remote Control session on claude.ai is the account's own.
  [/session_[A-Za-z0-9]{12,}/g, "session_01FIXTURE0000000000000000"],
  [/cse_[A-Za-z0-9]{12,}/g, "cse_01FIXTURE0000000000000000"],
];

const KEEP_INIT = ["type", "subtype", "session_id", "uuid", "cwd", "model", "permissionMode", "tools", "agents", "claude_code_version", "output_style", "apiKeySource", "capabilities", "mcp_servers"];
const NEUTRAL_COMMANDS = ["compact", "context", "cost", "init", "review", "security-review", "simplify"];
const NEUTRAL_COST = "Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 1s\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write";

/** A rate limit's shape, the account's numbers and billing set aside: half a week used, a far-off reset (decision 67). */
const RESETS_AT = 1900000000;
function neutralLimit(i) {
  const out = { status: i.status, resetsAt: RESETS_AT, rateLimitType: i.rateLimitType };
  if (i.utilization !== undefined) out.utilization = 0.5;
  if (i.rateLimitGraceActive) out.rateLimitGraceActive = true;
  if (i.unifiedWindows) out.unifiedWindows = Object.fromEntries(Object.keys(i.unifiedWindows).map((k) => [k, { utilization: 0.5, resetsAt: RESETS_AT }]));
  return out;
}
/** The initialize request ids the panel sent: their answers name the account. */
const inits = new Set();
const KEEP_INITIALIZE = ["current_permission_mode", "session_state", "output_style", "hooks_applied", "remote_control_available"];
/** The models the panel offers (webview/shared/protocol.ts MODELS), each with what the effort row reads. */
const PANEL_MODELS = ["default", "opus", "sonnet", "haiku"];
const MODEL_FIELDS = ["value", "resolvedModel", "displayName", "supportsEffort", "supportedEffortLevels"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
/** `mcp_status` requests by id: their answers carry each server's command line. */
const mcpAsks = new Set();
/** `get_settings` requests by id: their answers carry the owner's effective settings (env, permissions, hooks). */
const settingsAsks = new Set();

const scrub = (s) => {
  for (const [from, to] of swaps) {
    s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
  }
  return s;
};

if (asTranscript) {
  const KEEP = ["user", "assistant", "system", "attachment", "ai-title", "custom-title"];
  const lines = [];
  for (const line of fs.readFileSync(src, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (!KEEP.includes(o.type)) continue;
    const kept = o.type !== "attachment" ? o : { type: o.type, uuid: o.uuid, parentUuid: o.parentUuid, isSidechain: o.isSidechain, sessionId: o.sessionId, cwd: o.cwd, timestamp: o.timestamp, attachment: { type: o.attachment?.type } };
    lines.push(scrub(JSON.stringify(kept)));
  }
  fs.writeFileSync(dst, lines.join("\n") + "\n");
  console.log(`${dst}: ${lines.length} lines`);
  process.exit(0);
}

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
  if (o.type === "rate_limit_event") o.rate_limit_info = neutralLimit(o.rate_limit_info ?? {});
  if (e.d === "in" && o.type === "control_request" && o.request?.subtype === "initialize") inits.add(o.request_id);
  if (e.d === "in" && o.type === "control_request" && o.request?.subtype === "mcp_status") mcpAsks.add(o.request_id);
  if (e.d === "in" && o.type === "control_request" && o.request?.subtype === "get_settings") settingsAsks.add(o.request_id);
  if (e.d === "out" && o.type === "control_response" && inits.has(o.response?.request_id)) {
    const r = o.response.response ?? {};
    const keep = pick(r, KEEP_INITIALIZE);
    if (Array.isArray(r.models)) keep.models = r.models.filter((m) => PANEL_MODELS.includes(m.value)).map((m) => pick(m, MODEL_FIELDS));
    o.response.response = keep;
  }
  if (e.d === "out" && o.type === "control_response" && settingsAsks.has(o.response?.request_id) && o.response.response) {
    o.response.response = pick(o.response.response, ["applied"]);
  }
  if (e.d === "out" && o.type === "control_response" && mcpAsks.has(o.response?.request_id) && Array.isArray(o.response.response?.mcpServers)) {
    for (const srv of o.response.response.mcpServers) delete srv.config;
  }
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
