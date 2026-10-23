#!/usr/bin/env node
// One real chat through the wire layer, against the real `claude` (about
// three cents on Haiku): a permission prompt allowed, a model switch, the
// context meter, a mode switch, Stop, an idle close and a resume. Stripped
// as every test session here is — no user settings, no MCP, a terse system
// prompt — and EMBARCH_DESK_INTERNAL=1 keeps the desk out.
//
//   node test/live.smoke.mjs <scratch-dir> [claude-binary]

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const [, , scratch, bin = "claude"] = process.argv;
if (!scratch) {
  console.error("usage: live.smoke.mjs <scratch-dir> [claude-binary]");
  process.exit(2);
}
const cwd = path.join(scratch, `live-${Date.now()}`);
fs.mkdirSync(cwd, { recursive: true });

const env = core.chatEnv(process.env);
env.EMBARCH_DESK_INTERNAL = "1";
const chat = new core.Chat({
  sessionId: randomUUID(),
  cwd,
  claudePath: bin,
  existing: false,
  idleMs: 4000,
  mode: "default",
  env,
  // Later flags win: user settings and MCP stay out of a test session.
  extraArgs: ["--setting-sources", "", "--strict-mcp-config", "--model", "haiku", "--max-thinking-tokens", "0", "--tools", "Bash", "--system-prompt", "You are a terse test assistant. Follow instructions exactly."],
  log: (l) => console.log("  log", l),
});
let cost = 0;
let init = null;
chat.on("event", (e) => {
  if (e.type === "result") cost = Math.max(cost, e.total_cost_usd ?? 0);
  if (e.type === "system" && e.subtype === "init") init = e;
});
const turn = () => new Promise((r) => chat.once("turn", r));
const waitFor = async (pred, ms = 60000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const step = (s) => console.log(`PASS ${s}`);
const last = () => chat.state.entries[chat.state.timeline.at(-1)];

console.log(`claude: ${await core.claudeVersion(bin)}${core.versionWarning(await core.claudeVersion(bin)) ? " (outside the tested range)" : ""}`);

chat.send("Run the bash command `touch live-made.txt` and then reply with just: done");
await waitFor(() => chat.state.pending.length > 0 || chat.state.lastTurn);
if (chat.state.pending.length) {
  const p = chat.state.pending[0];
  assert.equal(p.toolName, "Bash");
  chat.allow(p);
  step("a real permission prompt, allowed");
}
await waitFor(() => !chat.state.busy && chat.state.lastTurn);
assert.ok(fs.existsSync(path.join(cwd, "live-made.txt")), "the allowed command ran");
assert.equal(Object.values(chat.state.entries).find((e) => e.kind === "tool").status, "done");
step(`turn one: ${JSON.stringify(last().text ?? last().kind)}`);
assert.ok(!init.plugins?.length || init.plugins.every((p) => p.path === "builtin"), "no user plugins in a stripped session");

await waitFor(() => chat.state.context !== null, 15000);
step(`context meter: ${chat.state.context.totalTokens} of ${chat.state.context.maxTokens}`);
await chat.setModel("haiku");
await chat.setMode("acceptEdits");
assert.equal(chat.state.mode, "acceptEdits");
step("set_model and set_permission_mode answered");

const t2 = turn();
chat.send("Write a 300-word story about a lighthouse keeper.");
await waitFor(() => core.liveBlocks(chat.state).some((b) => b.type === "text" && b.text.length > 5));
await chat.interrupt();
await t2;
assert.ok(Object.values(chat.state.entries).some((e) => e.kind === "note" && e.tone === "interrupt"));
step("Stop ended the turn");

await new Promise((r) => chat.once("closed", r));
assert.equal(chat.state.process, "closed");
step("closed after idle");
const t3 = turn();
chat.send("What file did my first message create? Reply with the file name only.");
await t3;
assert.match(last().text, /live-made/);
step(`resumed with --resume and kept context: ${JSON.stringify(last().text)}`);
chat.dispose();
console.log(`all live checks passed; cost about $${cost.toFixed(3)} for the last process`);
