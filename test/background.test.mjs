// Work that runs while the owner does something else (port items 70, 71),
// against recorded real sessions replayed by fake-claude.mjs: a step moved
// to the background, and background tasks with their output and their own
// Stop.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fake-claude.mjs");
const fixture = (n) => path.join(here, "fixtures", "wire", `${n}.jsonl`);
fs.chmodSync(FAKE, 0o755);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-bg-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function makeChat(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, "chat-"));
  const inputs = path.join(dir, "in.jsonl");
  const chat = new core.Chat({
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: dir,
    claudePath: FAKE,
    existing: false,
    idleMs: opts.idleMs ?? 60000,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture(name), FAKE_CLAUDE_INPUT_LOG: inputs },
  });
  const events = [];
  chat.on("event", (e) => events.push(e));
  // Each recording allowed its permission prompts.
  chat.on("status", (st) => {
    if (st === "waiting") for (const p of chat.state.pending) chat.allow(p);
  });
  // What the panel wrote to the CLI, in order.
  const sentIn = () => (fs.existsSync(inputs) ? fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o) : []);
  return { chat, events, sentIn };
}

const turns = (chat, n) =>
  new Promise((r) => {
    let k = 0;
    const f = (o) => {
      if (++k >= n) {
        chat.off("turn", f);
        r(o);
      }
    };
    chat.on("turn", f);
  });
const waitFor = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const tools = (s) => Object.values(s.entries).filter((e) => e.kind === "tool");
const top = (s) => s.timeline.map((id) => s.entries[id]);
const controls = (sentIn, subtype) => sentIn().filter((o) => o.type === "control_request" && o.request.subtype === subtype).map((o) => o.request);

// ------------------------------------------------------------ item 70

test("Run in background: a running Bash call moves to the background by its tool_use_id, and the turn goes on (port item 70)", async () => {
  const { chat, sentIn } = makeChat("runbg");
  chat.send("Run the bash command `for i in $(seq 1 20); do echo tick $i; sleep 2; done` in the foreground (not in the background). When it returns, reply with just: done");
  await waitFor(() => tools(chat.state).some(core.movable));
  const bash = tools(chat.state).find(core.movable);
  assert.equal(bash.name, "Bash");
  assert.equal(bash.background, false, "the CLI registered it as a task in the foreground");
  const ended = turns(chat, 1);
  await chat.runInBackground(bash.id);
  await ended;
  const t = chat.state.entries[bash.id];
  assert.equal(t.background, true);
  assert.ok(!core.movable(t), "nothing more to move");
  assert.equal(top(chat.state).at(-1).text, "done", "the turn went on without it");
  assert.deepEqual(controls(sentIn, "background_tasks"), [{ subtype: "background_tasks", tool_use_id: bash.id }]);
  assert.deepEqual(chat.state.background.map((b) => b.id), [t.task]);
  assert.equal(chat.holdReason(), "a background task runs", "decision 41: the process stays while it runs");
  chat.dispose();
});

test("a subagent moves to the background too, and Stop agent ends it and the shell it started (items 70, 71)", async () => {
  const { chat } = makeChat("agentbg");
  chat.send("Use the Agent tool ...");
  await waitFor(() => tools(chat.state).some((t) => t.name === "Agent" && core.movable(t)));
  const agent = tools(chat.state).find((t) => t.name === "Agent");
  const ended = turns(chat, 1);
  await chat.runInBackground(agent.id);
  await ended;
  assert.equal(chat.state.entries[agent.id].background, true);
  assert.equal(chat.state.background.length, 2, "the agent, and the shell it started in the background");
  const afterStop = turns(chat, 1); // the CLI's own turn for the stopped agent
  await chat.stopTask(chat.state.entries[agent.id].task);
  await afterStop;
  assert.equal(chat.state.entries[agent.id].taskEnd, "stopped");
  assert.deepEqual(chat.state.background, []);
  chat.dispose();
});

// ------------------------------------------------------------ item 71

test("a background shell's output is read while it runs and once more after its Stop; Stop ends only it (port item 71)", async () => {
  const { chat } = makeChat("runbg");
  chat.send("Run the bash command ...");
  await waitFor(() => tools(chat.state).some(core.movable));
  const bash = tools(chat.state).find(core.movable);
  const ended = turns(chat, 1);
  await chat.runInBackground(bash.id);
  await ended;
  const task = chat.state.entries[bash.id].task;
  assert.equal(core.taskKind(chat.state.background[0].type, chat.state.entries[bash.id]), "shell");
  assert.ok(core.hasOutput(chat.state.background[0].type));
  const out = await chat.taskOutput(task);
  assert.equal(out.output, "tick 1\ntick 2\ntick 3\ntick 4\n");
  assert.equal(out.truncated, false);
  await chat.stopTask(task);
  await waitFor(() => chat.state.background.length === 0);
  assert.equal(chat.state.entries[bash.id].taskEnd, "stopped");
  const last = await chat.taskOutput(task);
  assert.match(last.output, /tick 4\n\n\[killed\]/);
  chat.dispose();
});

test("Stop on a turn ends only the turn: a background task runs on, with its own Stop (port item 71)", async () => {
  const { chat, events, sentIn } = makeChat("bgstop");
  chat.send("Run the bash command `for i in $(seq 1 30); do echo tick $i; sleep 2; done` with run_in_background set to true. Reply with just: started");
  await turns(chat, 1);
  assert.equal(chat.state.background.length, 1);
  // This turn's own text, not the first turn's: an interrupt sent before the CLI took the message stops nothing.
  const from = events.length;
  chat.send("Write a 400-word story about a lighthouse keeper.");
  await waitFor(() => events.slice(from).some((e) => e.type === "stream_event" && e.event?.delta?.type === "text_delta"));
  const ended = turns(chat, 1);
  await chat.interrupt();
  await ended;
  assert.ok(Object.values(chat.state.entries).some((e) => e.kind === "note" && e.tone === "interrupt"));
  assert.equal(chat.state.background.length, 1, "the interrupt left the background task running");
  assert.deepEqual(controls(sentIn, "interrupt"), [{ subtype: "interrupt" }], "a plain interrupt: no cancel_queued, no send_now");
  const task = chat.state.background[0].id;
  assert.equal((await chat.taskOutput(task)).output, "tick 1\ntick 2\n");
  await chat.stopTask(task);
  await waitFor(() => chat.state.background.length === 0);
  chat.dispose();
});

test("a Monitor is a shell to get_task_output, and says so in its row (port item 71)", async () => {
  const { chat } = makeChat("monitor");
  chat.send("Use the Monitor tool ...");
  await turns(chat, 3); // its reply, then a turn for each event it reported
  const mon = tools(chat.state).find((t) => t.name === "Monitor");
  assert.equal(mon.background, true);
  assert.equal(core.taskKind(chat.state.background[0].type, mon), "monitor");
  assert.equal((await chat.taskOutput(mon.task)).output, "tick 1\ntick 2\n");
  await chat.stopTask(mon.task);
  await waitFor(() => chat.state.entries[mon.id].taskEnd === "stopped");
  chat.dispose();
});

test("a task's output reads as plain text: escapes out, a carriage-return redraw at its last state", () => {
  assert.equal(core.plainOutput("\x1b[32mok\x1b[0m\n10%\r50%\r100%\n\x1b]0;title\x07done\n"), "ok\n100%\ndone\n");
});
