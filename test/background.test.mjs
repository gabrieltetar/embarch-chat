// Work that runs while the owner does something else (port items 70–72),
// against recorded real sessions replayed by fake-claude.mjs: a step moved
// to the background, background tasks with their output and their own
// Stop, and messages that wait for Claude — taken back, or sent now.

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
  const unsent = [];
  chat.on("unsent", (t) => unsent.push(t));
  // Each recording allowed its permission prompts.
  chat.on("status", (st) => {
    if (st === "waiting") for (const p of chat.state.pending) chat.allow(p);
  });
  // What the panel wrote to the CLI, in order.
  const sentIn = () => (fs.existsSync(inputs) ? fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o) : []);
  return { chat, events, unsent, sentIn };
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
const userBy = (s, text) => Object.values(s.entries).find((e) => e.kind === "user" && e.text.includes(text));
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

test("a CLI that dies with a task in the background leaves none behind: its row ends, and the next process closes when idle (decision 41)", async () => {
  const { chat } = makeChat("bgstop", { idleMs: 300 });
  chat.send("Run the bash command `for i in $(seq 1 30); do echo tick $i; sleep 2; done` with run_in_background set to true. Reply with just: started");
  await turns(chat, 1);
  assert.equal(chat.state.background.length, 1);
  const bash = tools(chat.state).find((t) => t.background);
  // An OOM kill, a crash: no background_tasks_changed comes after it.
  process.kill(chat.pid, "SIGKILL");
  await waitFor(() => !chat.running);
  assert.deepEqual(chat.state.background, [], "no task outlives its process");
  assert.equal(chat.state.entries[bash.id].taskEnd, "stopped", "its row says it ended");
  chat.opts.env.FAKE_CLAUDE_FIXTURE = fixture("basic");
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  await turns(chat, 1);
  await waitFor(() => !chat.running, 3000);
  assert.equal(chat.state.process, "closed", "closed when idle, not held for a task that died");
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

// ------------------------------------------------------------ item 72

test("messages sent while Claude works wait at the bottom; one is taken back before Claude took it, the other joins where Claude took it (port item 72)", async () => {
  const { chat, unsent, sentIn } = makeChat("queue");
  chat.send("Run the bash command `sleep 8; echo one`, then reply with just: one");
  await waitFor(() => tools(chat.state).length === 1);
  chat.send("Also end your reply with the word: two");
  chat.send("Also end your reply with the word: three");
  const two = userBy(chat.state, "two");
  const three = userBy(chat.state, "three");
  assert.deepEqual(chat.state.queue, [two.id, three.id], "both wait, in order");
  assert.ok(!chat.state.timeline.includes(two.id), "not among the steps");
  assert.ok(two.uuid && three.uuid && two.uuid !== three.uuid, "each with its own uuid");
  await waitFor(() => sentIn().filter((o) => o.type === "user").length === 3);
  assert.deepEqual(
    sentIn().filter((o) => o.type === "user").map((o) => o.uuid),
    [chat.state.entries[chat.state.timeline[0]].uuid, two.uuid, three.uuid],
    "the uuids went to the CLI with the messages",
  );
  const ended = turns(chat, 1);
  await chat.cancelQueued(three.id);
  assert.deepEqual(controls(sentIn, "cancel_async_message"), [{ subtype: "cancel_async_message", message_uuid: three.uuid }]);
  assert.equal(chat.state.entries[three.id], undefined, "taken back: gone");
  assert.deepEqual(unsent, ["Also end your reply with the word: three"], "its text back in the draft");
  await ended;
  assert.deepEqual(chat.state.queue, []);
  const t = top(chat.state);
  assert.deepEqual(t.map((e) => e.kind), ["user", "tool", "user", "text"], "it joined after the step, where Claude took it in");
  assert.equal(t[2].id, two.id);
  assert.equal(t[2].pending, false);
  assert.equal(t[3].text, "one\ntwo");
  chat.dispose();
});

test("Send now while a step runs in the foreground: the step goes to the background and the turn takes the message in (port item 72)", async () => {
  const { chat, events, sentIn } = makeChat("sendnowbg");
  chat.send("Run the bash command ... then reply with just: one");
  await waitFor(() => tools(chat.state).some(core.movable));
  chat.send("Also end your reply with the word: two");
  const two = userBy(chat.state, "two");
  assert.deepEqual(chat.state.queue, [two.id]);
  await waitFor(() => events.some((e) => e.type === "command_lifecycle" && e.command_uuid === two.uuid && e.state === "queued"));
  assert.ok(core.anyMovable(chat.state));
  const ended = turns(chat, 1);
  await chat.sendNow(two.id);
  await ended;
  assert.deepEqual(controls(sentIn, "background_tasks"), [{ subtype: "background_tasks" }], "every step in the foreground, not an interrupt");
  assert.deepEqual(controls(sentIn, "interrupt"), []);
  const t = top(chat.state);
  assert.deepEqual(t.map((e) => e.kind), ["user", "tool", "user", "text"]);
  assert.equal(t[1].background, true, "the step runs on");
  assert.equal(t[3].text, "one\n\ntwo");
  assert.ok(!Object.values(chat.state.entries).some((e) => e.kind === "note" && e.tone === "interrupt"), "nothing was stopped");
  await chat.stopTask(t[1].task);
  await waitFor(() => chat.state.background.length === 0);
  chat.dispose();
});

test("Send now while Claude writes: an interrupt with send_now and the message's uuid; the message runs next", async () => {
  const { chat, events, sentIn } = makeChat("sendnowtext");
  // This turn's own text, not the first turn's: an interrupt sent before the CLI took the message stops nothing.
  const from = events.length;
  chat.send("Write a 400-word story about a lighthouse keeper.");
  await waitFor(() => events.slice(from).some((e) => e.type === "stream_event" && e.event?.delta?.type === "text_delta"));
  chat.send("Stop the story. Reply with just: two");
  const two = userBy(chat.state, "two");
  await waitFor(() => events.some((e) => e.type === "command_lifecycle" && e.command_uuid === two.uuid));
  const both = turns(chat, 2);
  await chat.sendNow(two.id);
  await both;
  assert.deepEqual(controls(sentIn, "interrupt"), [{ subtype: "interrupt", send_now: true, message_uuid: two.uuid }]);
  assert.deepEqual(chat.state.queue, []);
  assert.equal(top(chat.state).at(-1).text, "two");
  assert.ok(chat.state.timeline.includes(two.id));
  chat.dispose();
});

test("the CLI's own send_now stops a step running in the foreground (2.1.287): why Send now moves the step first", () => {
  // Recorded: interrupt with send_now and the waiting message's uuid while a
  // Bash call ran in the foreground. Should a later CLI move the step instead
  // (its changelog says so of its own key since 2.1.281), this fails when
  // re-recorded, and Send now can use send_now alone.
  const lines = fs.readFileSync(fixture("sendnow"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const answer = lines.find((e) => e.d === "out" && e.o.type === "control_response" && e.o.response.request_id === "sn-1").o.response.response;
  assert.equal(answer.send_now, "stopped");
  const s = core.reduceAll(core.initialState("x"), lines.filter((e) => e.d === "out").map((e) => e.o));
  const bash = tools(s).find((t) => t.name === "Bash");
  assert.equal(bash.status, "error", "the step was ended, not moved");
  assert.notEqual(bash.background, true);
  assert.ok(Object.values(s.entries).some((e) => e.kind === "note" && e.tone === "interrupt"));
});

test("the queue in the reducer: a message sent mid-turn waits, its echo (by uuid) moves it; one not sent joins the timeline marked so", () => {
  let s = core.initialState("x");
  s = core.reduce(s, { type: "_sent", n: 1, text: "first", uuid: "u1" });
  assert.deepEqual(s.timeline, ["s:1"], "nothing runs: straight in");
  s = core.reduce(s, { type: "_sent", n: 2, text: "second", uuid: "u2" });
  s = core.reduce(s, { type: "_sent", n: 3, text: "third", uuid: "u3" });
  assert.deepEqual(s.queue, ["s:2", "s:3"]);
  assert.deepEqual(s.timeline, ["s:1"]);
  // The echo of a message whose text the CLI rewrote still finds it by its uuid.
  s = core.reduce(s, { type: "user", isReplay: true, uuid: "u2", message: { role: "user", content: "second (expanded)" } });
  assert.deepEqual(s.queue, ["s:3"]);
  assert.deepEqual(s.timeline, ["s:1", "s:2"]);
  s = core.reduce(s, { type: "_unsent", id: "s:3" });
  assert.deepEqual(s.queue, []);
  assert.equal(s.timeline.at(-1), "s:3");
  assert.equal(s.entries["s:3"].unsent, true);
  s = core.reduce(s, { type: "_sent", n: 4, text: "fourth", uuid: "u4" });
  s = core.reduce(s, { type: "_dequeued", id: "s:4" });
  assert.equal(s.entries["s:4"], undefined);
  assert.ok(!s.unconfirmed.includes("s:4"));
});
