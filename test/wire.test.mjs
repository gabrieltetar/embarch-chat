// The wire layer against recorded real sessions, replayed by fake-claude.mjs.
// Run with `npm test` (builds test-out/core.js first).

import { test } from "node:test";
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

function makeChat(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-test-"));
  const argsLog = path.join(dir, "args.jsonl");
  const sessionId = opts.sessionId ?? "11111111-2222-4333-8444-555555555555";
  const chat = new core.Chat({
    sessionId,
    cwd: dir,
    claudePath: FAKE,
    existing: opts.existing ?? false,
    idleMs: opts.idleMs ?? 60000,
    mode: opts.mode,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture(name), FAKE_CLAUDE_ARGS_LOG: argsLog },
  });
  const events = [];
  chat.on("event", (e) => events.push(e));
  const spawns = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { chat, events, spawns, dir };
}

const once = (em, ev) => new Promise((r) => em.once(ev, r));
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
const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const entries = (s, kind) => Object.values(s.entries).filter((e) => e.kind === kind);
const top = (s) => s.timeline.map((id) => s.entries[id]);

test("a new chat starts with the official panel's flags, in auto mode, by session id", async () => {
  const { chat, spawns } = makeChat("basic");
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  await turns(chat, 1);
  const a = spawns()[0].argv;
  for (const f of ["--input-format", "stream-json", "--output-format", "--verbose", "--permission-prompt-tool=stdio", "--setting-sources=user,project,local", "--permission-mode=auto", "--replay-user-messages", "--include-partial-messages", "--prompt-suggestions"]) {
    assert.ok(a.includes(f), `missing ${f}`);
  }
  assert.equal(a[a.indexOf("--session-id") + 1], chat.sessionId);
  assert.ok(!a.some((x) => x.startsWith("--resume")));
  assert.ok(!a.includes("--model"), "the owner's default model");
  assert.equal(spawns()[0].env.EMBARCH_DESK_INTERNAL, null, "a real chat is seen by the desk");
  chat.dispose();
});

test("streams text, folds a tool call with its result, confirms the echoed message", async () => {
  const { chat } = makeChat("basic");
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  await turns(chat, 1);
  let s = chat.state;
  const users = entries(s, "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].pending, false, "the replay confirmed it");
  const bash = entries(s, "tool")[0];
  assert.equal(bash.name, "Bash");
  assert.equal(bash.input.command, "echo hello-from-bash");
  assert.equal(bash.status, "done");
  assert.equal(bash.result, "hello-from-bash");
  assert.deepEqual(top(s).map((e) => e.kind), ["user", "tool", "text"]);
  assert.equal(s.busy, false);
  assert.equal(core.chatStatus(s), "idle");
  chat.send("Reply with just: ok");
  await turns(chat, 1);
  s = chat.state;
  assert.equal(top(s).at(-1).text, "ok");
  await waitFor(() => chat.state.context !== null);
  assert.ok(chat.state.context.maxTokens > 0, "the meter refreshes after a turn");
  chat.dispose();
});

test("a permission prompt waits on the owner, and deny reaches the CLI", async () => {
  const { chat } = makeChat("deny");
  chat.send("Run the bash command `touch should-not-exist.txt`. If it is refused, reply with just: refused");
  await waitFor(() => chat.state.pending.length === 1);
  const p = chat.state.pending[0];
  assert.equal(p.form, "permission");
  assert.equal(p.toolName, "Bash");
  assert.equal(core.chatStatus(chat.state), "waiting");
  assert.equal(chat.holdReason(), "waits on the owner");
  chat.deny(p, "The owner declined this tool call.");
  await turns(chat, 1);
  const t = entries(chat.state, "tool")[0];
  assert.equal(t.status, "denied");
  assert.equal(chat.state.pending.length, 0);
  chat.dispose();
});

test("Claude's question is a form answered with `answers`", async () => {
  const { chat } = makeChat("question");
  chat.send("Use the AskUserQuestion tool ...");
  await waitFor(() => chat.state.pending.length === 1);
  const p = chat.state.pending[0];
  assert.equal(p.form, "question");
  const q = p.input.questions[0];
  assert.equal(q.options.length, 2);
  chat.answerQuestion(p, { [q.question]: q.options[1].label });
  await turns(chat, 1);
  assert.match(top(chat.state).at(-1).text, /coffee/i);
  chat.dispose();
});

test("a plan is approved, and the work goes on", async () => {
  const { chat } = makeChat("plan", { mode: "plan" });
  assert.ok(true);
  chat.send("Plan how to create hello.txt ...");
  await waitFor(() => chat.state.pending.length === 1);
  let p = chat.state.pending[0];
  assert.equal(p.form, "plan");
  assert.match(String(p.input.plan), /hello\.txt/);
  chat.allow(p);
  await waitFor(() => chat.state.pending.length === 1);
  p = chat.state.pending[0];
  assert.equal(p.toolName, "Write");
  chat.allow(p);
  await turns(chat, 1);
  assert.match(top(chat.state).at(-1).text, /hello\.txt/);
  chat.dispose();
});

test("Stop interrupts the turn and the session goes on", async () => {
  const { chat, events } = makeChat("interrupt");
  let sawLive = false;
  chat.on("event", () => {
    if (core.liveBlocks(chat.state).some((b) => b.type === "text" && b.text)) sawLive = true;
  });
  chat.send("Write a 400-word story about a lighthouse keeper.");
  await waitFor(() => events.some((e) => e.type === "stream_event" && e.event?.delta?.type === "text_delta"));
  await chat.interrupt();
  await turns(chat, 1);
  assert.ok(sawLive, "text showed while streaming");
  assert.ok(entries(chat.state, "note").some((n) => n.tone === "interrupt"));
  assert.ok(!entries(chat.state, "note").some((n) => n.tone === "error"), "an interrupt is not an error");
  chat.send("Reply with just: still here");
  await turns(chat, 1);
  assert.equal(top(chat.state).at(-1).text, "still here");
  chat.dispose();
});

test("mode, model, rename, context meter and /compact over control requests", async () => {
  const { chat } = makeChat("controls");
  chat.send("@note.txt what is the secret? One word.");
  await turns(chat, 1);
  assert.equal(top(chat.state).at(-1).text, "MANGO", "the CLI inlined the @-mention");
  await waitFor(() => chat.state.context !== null);
  assert.equal(chat.state.context.totalTokens, 534);
  await chat.setMode("acceptEdits");
  assert.equal(chat.state.mode, "acceptEdits");
  await chat.setModel("haiku");
  assert.equal(chat.state.model, "haiku");
  await chat.rename("ABC-123 fixture chat");
  await waitFor(() => chat.state.title === "ABC-123 fixture chat");
  chat.compact();
  await turns(chat, 1);
  assert.ok(entries(chat.state, "note").some((n) => n.tone === "compact"));
  await waitFor(() => chat.state.context?.totalTokens === 1214);
  chat.dispose();
});

test("a subagent's steps nest under its call; its background task holds the process", async () => {
  const { chat } = makeChat("subagent");
  chat.send("Use the Agent tool ...");
  await turns(chat, 1);
  const agent = entries(chat.state, "tool").find((t) => t.name === "Agent");
  assert.ok(agent);
  await turns(chat, 1);
  const s = chat.state;
  const kids = s.entries[agent.id].children.map((id) => s.entries[id]);
  assert.ok(kids.some((k) => k.kind === "tool" && k.name === "Bash" && k.result === "from-subagent"), "the subagent's Bash nests under the Agent call");
  assert.ok(!s.timeline.some((id) => s.entries[id].kind === "tool" && s.entries[id].name === "Bash"), "and not at the top");
  assert.ok(s.entries[agent.id].background);
  assert.deepEqual(s.background, []);
  chat.dispose();
});

test("Edit and Write carry what a diff needs", async () => {
  const { chat } = makeChat("edit");
  chat.on("status", (st) => {
    if (st === "waiting") chat.allow(chat.state.pending[0]);
  });
  chat.send("Use the Write tool ...");
  await turns(chat, 1);
  const tools = entries(chat.state, "tool");
  const w = tools.find((t) => t.name === "Write");
  const e = tools.find((t) => t.name === "Edit");
  assert.equal(w.input.content, "one\ntwo");
  assert.equal(e.input.old_string, "one\ntwo");
  assert.equal(e.input.new_string, "one\nthree");
  assert.equal(e.structured.originalFile, "one\ntwo");
  assert.ok(Array.isArray(e.structured.structuredPatch));
  chat.dispose();
});

test("a background task keeps the process past idle; it closes when the task ends", async () => {
  const { chat } = makeChat("background", { idleMs: 150 });
  // The replay runs ahead of the test, so look at the first turn's end as it happens.
  let atFirst = null;
  chat.once("turn", () => (atFirst = { bg: chat.state.background.length, hold: chat.holdReason() }));
  chat.send("Run the bash command `sleep 4; echo bg-done` with run_in_background ...");
  await turns(chat, 2); // the second is the CLI's own turn when the task ends
  assert.deepEqual(atFirst, { bg: 1, hold: "a background task runs" });
  assert.deepEqual(chat.state.background, []);
  await once(chat, "closed");
  assert.equal(chat.state.process, "closed");
  chat.dispose();
});

test("an idle chat closes, and the next message resumes it with --resume", async () => {
  const { chat, spawns } = makeChat("resume", { idleMs: 150 });
  chat.send("What word did I ask you to remember? One word.");
  await turns(chat, 1);
  await once(chat, "closed");
  assert.equal(chat.state.process, "closed");
  assert.equal(core.chatStatus(chat.state), "closed");
  chat.send("again");
  await turns(chat, 1);
  const runs = spawns();
  assert.equal(runs.length, 2);
  assert.ok(runs[0].argv.includes("--session-id"));
  assert.ok(runs[1].argv.includes(`--resume=${chat.sessionId}`));
  chat.dispose();
});

test("a pending prompt keeps the process past idle", async () => {
  const { chat } = makeChat("deny", { idleMs: 100 });
  chat.send("Run ...");
  await waitFor(() => chat.state.pending.length === 1);
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(chat.running, "still up while it waits on the owner");
  chat.deny(chat.state.pending[0], "no");
  await turns(chat, 1);
  await once(chat, "closed");
  chat.dispose();
});

test("an existing session resumes, mode and model carried", async () => {
  const { chat, spawns } = makeChat("resume", { existing: true, mode: "acceptEdits" });
  await chat.setModel("sonnet");
  chat.send("What word did I ask you to remember? One word.");
  await turns(chat, 1);
  const a = spawns()[0].argv;
  assert.ok(a.includes(`--resume=${chat.sessionId}`));
  assert.ok(a.includes("--permission-mode=acceptEdits"));
  assert.equal(a[a.indexOf("--model") + 1], "sonnet");
  chat.dispose();
});

test("a missing claude is an error on the chat, not a crash", async () => {
  const chat = new core.Chat({ sessionId: "x", cwd: os.tmpdir(), claudePath: "/nonexistent/claude", existing: false, idleMs: 1000 });
  chat.send("hi");
  await once(chat, "closed");
  assert.equal(chat.state.process, "error");
  assert.match(chat.state.processError, /not found/);
  chat.dispose();
});

test("versions outside the tested range warn in one line", async () => {
  assert.equal(core.versionWarning("2.1.287 (Claude Code)"), null);
  assert.equal(core.versionWarning("2.1.300 (Claude Code)"), null);
  assert.match(core.versionWarning("2.2.0 (Claude Code)"), /outside the versions/);
  assert.match(core.versionWarning("2.1.100"), /outside/);
  assert.match(core.versionWarning("garbage"), /Could not read/);
  assert.equal(await core.claudeVersion(FAKE), "2.1.287 (Claude Code)");
});

test("a transcript folds into the same state, titled by Claude's ai-title", () => {
  const dir = path.join(here, "fixtures", "transcripts");
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const { events, meta } = core.readTranscript(file);
  assert.equal(meta.title, "PELICAN");
  let s = core.initialState(meta.sessionId);
  for (const e of events) s = core.reduce(s, e);
  assert.equal(s.title, "PELICAN");
  assert.equal(entries(s, "user").length, 2);
  assert.match(top(s).at(-1).text, /PELICAN/i);
});

test("the claude args for a resumed chat", () => {
  const a = core.claudeArgs({ claudePath: "claude", cwd: "/w", sessionId: "S", resume: true, permissionMode: "auto" });
  assert.ok(a.includes("--resume=S"));
  assert.ok(!a.includes("--session-id"));
  assert.ok(!("CLAUDECODE" in core.chatEnv({ CLAUDECODE: "1", PATH: "/bin" })));
});
