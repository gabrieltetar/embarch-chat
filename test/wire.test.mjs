// The wire layer against recorded real sessions, replayed by fake-claude.mjs.
// Run with `npm test` (builds test-out/core.js first).

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
// Every scratch folder of this run, under one root removed at the end.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-wire-"));
const tmp = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function makeChat(name, opts = {}) {
  const dir = tmp("chat-");
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

test("a message sent while Claude's question waits is queued: the question stays open, and Claude takes the message after the answer (decision 55)", async () => {
  const { chat } = makeChat("askqueued");
  chat.send("Use the AskUserQuestion tool to ask me whether I prefer tea or coffee (two options, each with a short description), then tell me in one line what I picked.");
  await waitFor(() => chat.state.pending.length === 1);
  const p = chat.state.pending[0];
  chat.send("Also end your reply with the word: kiwi");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(chat.state.pending.map((x) => x.requestId), [p.requestId], "still asking: the message answered nothing");
  const kiwi = () => entries(chat.state, "user").find((e) => e.text.includes("kiwi"));
  assert.equal(kiwi().pending, true, "the CLI holds it");
  const q = p.input.questions[0];
  chat.answerQuestion(p, { [q.question]: q.options[1].label });
  await turns(chat, 1);
  assert.equal(kiwi().pending, false, "taken after the answer");
  const t = top(chat.state);
  assert.deepEqual(t.map((e) => e.kind), ["user", "tool", "user", "text"]);
  assert.equal(t[1].status, "done");
  assert.match(t[3].text, /tea[\s\S]*kiwi/i, "one reply to both, in the same turn");
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
  // Both results can arrive in one read of stdout, so wait for both at once.
  const both = turns(chat, 2);
  chat.send("Use the Agent tool ...");
  await both;
  const agent = entries(chat.state, "tool").find((t) => t.name === "Agent");
  assert.ok(agent);
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
  const chat = new core.Chat({ sessionId: "11111111-2222-4333-8444-555555555555", cwd: os.tmpdir(), claudePath: "/nonexistent/claude", existing: false, idleMs: 1000 });
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
  const S = "11111111-2222-4333-8444-555555555555";
  const a = core.claudeArgs({ claudePath: "claude", cwd: "/w", sessionId: S, resume: true, permissionMode: "auto" });
  assert.ok(a.includes(`--resume=${S}`));
  assert.ok(!a.includes("--session-id"));
  assert.ok(!("CLAUDECODE" in core.chatEnv({ CLAUDECODE: "1", PATH: "/bin" })));
});

// ------------------------------------------------------------ what review round 1 found

test("only a UUID is a session id: none other reaches a path or claude's command line", () => {
  assert.ok(core.isSessionId("11111111-2222-4333-8444-555555555555"));
  for (const bad of ["../../x", "S", "11111111-2222-4333-8444-55555555555/", "--model=opus", "", null]) assert.equal(core.isSessionId(bad), false, String(bad));
  assert.throws(() => core.claudeArgs({ claudePath: "claude", cwd: "/w", sessionId: "../../x", resume: true, permissionMode: "auto" }), /not a session id/);
  const root = tmp("sid-");
  fs.mkdirSync(path.join(root, "p"));
  fs.writeFileSync(path.join(root, "x.jsonl"), "{}\n");
  assert.equal(core.findTranscript("../x", undefined, path.join(root, "p")), null, "no path out of the projects folder");
  fs.writeFileSync(path.join(root, "p", "not-a-session.jsonl"), "{}\n");
  assert.deepEqual(new core.TranscriptIndex(root).list(["/p"], 0), [], "a file not named by a session id is not a transcript");
});

test("a message sent while the idle close is under way goes to the resumed process", async () => {
  const { chat, spawns, dir } = makeChat("resume");
  const inputs = path.join(dir, "inputs.jsonl");
  chat.opts.env.FAKE_CLAUDE_INPUT_LOG = inputs;
  // The recording echoes its own prompt, so the second message is the same text.
  const Q = "What word did I ask you to remember? One word.";
  chat.send(Q);
  await turns(chat, 1);
  // The idle close ends stdin; the owner's message lands before the CLI has gone.
  chat.closeProcess();
  const next = turns(chat, 1);
  chat.send(Q);
  assert.equal(Object.values(chat.state.entries).filter((e) => e.kind === "user" && e.pending).length, 1, "shown at once, waiting");
  await next;
  const runs = spawns();
  assert.equal(runs.length, 2, "resumed");
  assert.ok(runs[1].argv.includes(`--resume=${chat.sessionId}`));
  const sent = fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o).filter((o) => o.type === "user").map((o) => o.message.content);
  assert.deepEqual(sent, [Q, Q], "nothing written into the closing process is lost");
  assert.ok(!Object.values(chat.state.entries).some((e) => e.kind === "user" && e.pending), "and Claude took it");
  chat.dispose();
});

test("a CLI killed by a signal is an error, not an idle close", async () => {
  const { chat } = makeChat("basic");
  chat.opts.env.FAKE_CLAUDE_SIGNAL = "SIGKILL";
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  await once(chat, "closed");
  assert.equal(chat.state.process, "error");
  assert.match(chat.state.processError, /SIGKILL/);
  chat.dispose();
});

test("a CLI that dies during a held /compact starts nothing again: the whole draft goes back, marked not sent", async () => {
  const { chat, spawns, dir } = makeChat("basic");
  const inputs = path.join(dir, "inputs.jsonl");
  chat.opts.env.FAKE_CLAUDE_INPUT_LOG = inputs;
  chat.opts.env.FAKE_CLAUDE_SIGNAL = "SIGKILL";
  const unsent = [];
  chat.on("unsent", (t) => unsent.push(t));
  chat.sendAfterCompact("/compact focus on: the loader", "now add the blink test");
  await once(chat, "closed");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(spawns().length, 1, "no process started after the crash");
  const sent = fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o).filter((o) => o.type === "user").map((o) => o.message.content);
  assert.deepEqual(sent, ["/compact focus on: the loader"], "the held rest never went out");
  assert.deepEqual(unsent, ["/compact focus on: the loader", "now add the blink test"], "both back in the draft");
  const users = chat.state.timeline.map((id) => chat.state.entries[id]).filter((e) => e.kind === "user");
  assert.deepEqual(users.map((e) => [e.text, !!e.pending, !!e.unsent]), [
    ["/compact focus on: the loader", false, true],
    ["now add the blink test", false, true],
  ]);
  assert.equal(chat.state.process, "error");
  chat.dispose();
});

test("a message the CLI never took before it died goes back to the draft", async () => {
  const { chat, spawns } = makeChat("basic");
  chat.opts.env.FAKE_CLAUDE_SIGNAL = "SIGKILL";
  const unsent = [];
  chat.on("unsent", (t) => unsent.push(t));
  chat.send("make the widget blink");
  await once(chat, "closed");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(unsent, ["make the widget blink"]);
  assert.equal(spawns().length, 1);
  chat.dispose();
});

test("a crash in a new chat's first turn: the next message starts it again by the same id, whatever the CLI had written", async () => {
  // What the dead CLI left in the transcript, and how the next process must start for the CLI to take the id.
  for (const [left, how] of [
    ["prompt", "resume"],
    ["queue", "session-id"],
    [null, "session-id"],
  ]) {
    const { chat, spawns, dir } = makeChat("basic");
    const config = path.join(dir, "config");
    Object.assign(chat.opts.env, { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_STRICT: "1", FAKE_CLAUDE_SIGNAL: "SIGKILL" });
    if (left) chat.opts.env.FAKE_CLAUDE_TRANSCRIPT = left;
    const unsent = [];
    chat.on("unsent", (t) => unsent.push(t));
    const Q = "Run the bash command `echo hello-from-bash` and then reply with just: done";
    let closed = once(chat, "closed");
    chat.send(Q);
    await closed;
    assert.deepEqual(unsent, [Q], `${left}: back in the draft`);
    delete chat.opts.env.FAKE_CLAUDE_SIGNAL;
    const turn = turns(chat, 1);
    closed = once(chat, "closed");
    chat.send(Q);
    const ended = await Promise.race([turn.then(() => "a turn"), closed.then(() => `an exit: ${chat.state.processError}`)]);
    assert.equal(ended, "a turn", `${left}: the next message starts the chat`);
    const a = spawns()[1].argv;
    if (how === "resume") assert.ok(a.includes(`--resume=${chat.sessionId}`) && !a.includes("--session-id"), `${left}: ${a.join(" ")}`);
    else assert.equal(a[a.indexOf("--session-id") + 1], chat.sessionId, `${left}: ${a.join(" ")}`);
    const project = path.join(config, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    const aside = fs.existsSync(project) ? fs.readdirSync(project).filter((f) => f.startsWith(`${chat.sessionId}.jsonl.`)) : [];
    assert.equal(aside.length, left === "queue" ? 1 : 0, `${left}: only a transcript with no message is set aside: ${aside}`);
    chat.dispose();
  }
});

test("a local slash command the CLI ran is sent, though nothing echoes it: a later crash gives back only what it never took", async () => {
  const { chat, spawns } = makeChat("slash");
  const unsent = [];
  chat.on("unsent", (t) => unsent.push(t));
  const users = () => top(chat.state).filter((e) => e.kind === "user").map((e) => [e.text, !!e.pending, !!e.unsent]);
  let t = turns(chat, 1);
  chat.send("/context");
  await t;
  t = turns(chat, 1);
  chat.send("/cost");
  await t;
  assert.deepEqual(users(), [["/context", false, false], ["/cost", false, false]], "each one ran: neither waits on Claude");
  assert.deepEqual(chat.state.unconfirmed, []);
  // Closed when idle; much later the next process dies on the owner's next message.
  let closed = once(chat, "closed");
  chat.closeProcess();
  await closed;
  chat.opts.env.FAKE_CLAUDE_SIGNAL = "SIGKILL";
  closed = once(chat, "closed");
  chat.send("now fix the loader");
  await closed;
  assert.equal(spawns().length, 2);
  assert.deepEqual(unsent, ["now fix the loader"], "only the message the CLI never took goes back to the draft");
  assert.deepEqual(users(), [["/context", false, false], ["/cost", false, false], ["now fix the loader", false, true]]);
  chat.dispose();
});

test("a result names its local command: only that command's message is confirmed, never one still queued or held", () => {
  let s = core.initialState("11111111-2222-4333-8444-555555555555");
  for (const [n, text, held] of [[1, "/compact focus on: the loader", false], [2, "/context", true], [3, "/cost", false], [4, "/context", false]]) s = core.reduce(s, { type: "_sent", n, text, images: 0, held });
  s = core.reduce(s, { type: "user", message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } });
  s = core.reduce(s, { type: "result", subtype: "success", is_error: false, local_command: "compact" });
  assert.deepEqual(s.unconfirmed, ["s:2", "s:3", "s:4"], "/compact's own output confirmed it; its result confirms nothing else");
  s = core.reduce(s, { type: "result", subtype: "success", is_error: false, local_command: "context" });
  assert.deepEqual(s.unconfirmed, ["s:2", "s:3"], "the /context that was sent, not the held one");
  s = core.reduce(s, { type: "result", subtype: "success", is_error: false });
  assert.deepEqual(s.unconfirmed, ["s:2", "s:3"], "a prompt's result confirms nothing by itself");
});

test("a transcript rewritten in place, larger or the same size, is read again from the start", () => {
  const root = tmp("rewrite-");
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const sid = "55555555-3333-4444-8555-666666666666";
    const pdir = path.join(root, "projects", "-w");
    fs.mkdirSync(pdir, { recursive: true });
    const file = path.join(pdir, `${sid}.jsonl`);
    const line = (o) => JSON.stringify(o) + "\n";
    const user = (t) => line({ type: "user", cwd: "/w", message: { role: "user", content: t } });
    const reply = (id, t) => line({ type: "assistant", message: { id, content: [{ type: "text", text: t }] } });
    const texts = (rec) => rec.chat.state.timeline.map((id) => rec.chat.state.entries[id].text);
    let mtime = Date.now() / 1000 - 100;
    const write = (text) => {
      fs.writeFileSync(file, text); // in place: the same inode
      fs.utimesSync(file, mtime, (mtime += 10));
    };
    write(user("alpha first") + reply("a1", "alpha reply"));
    const m = new core.ChatManager(() => ({ claudePath: FAKE, idleMs: 60000, log: () => {} }));
    const idx = new core.TranscriptIndex(path.join(root, "projects"));
    const rec = m.openViewer(sid, "/w", null, null, false);
    assert.equal(idx.list(["/w"], 0)[0].firstPrompt, "alpha first");
    // Rewritten larger: another first exchange, more after it.
    write(user("bravo first") + reply("b1", "bravo reply") + user("bravo second"));
    m.reloadViewer(sid);
    assert.deepEqual(texts(rec), ["bravo first", "bravo reply", "bravo second"]);
    assert.equal(idx.list(["/w"], 0)[0].firstPrompt, "bravo first");
    // Rewritten to the very same size.
    const size = fs.statSync(file).size;
    write(user("delta first") + reply("b1", "delta reply") + user("delta second"));
    assert.equal(fs.statSync(file).size, size);
    m.reloadViewer(sid);
    assert.deepEqual(texts(rec), ["delta first", "delta reply", "delta second"]);
    assert.equal(idx.list(["/w"], 0)[0].firstPrompt, "delta first");
    // An append still reads only what was added.
    const got = [];
    m.on("event", (_sid, e) => got.push(e.type));
    m.on("snapshot", () => got.push("snapshot"));
    fs.appendFileSync(file, reply("d2", "delta more"));
    m.reloadViewer(sid);
    assert.deepEqual(got, ["assistant"]);
    m.dispose();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test("a background subagent's permission prompt outlives the main turn's end", () => {
  let s = core.initialState("x");
  const fold = (es) => es.forEach((e) => (s = core.reduce(s, e)));
  fold([
    { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "bg", run_in_background: true } }] } },
    { type: "system", subtype: "task_started", tool_use_id: "toolu_agent", is_backgrounded: true },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "bg" }] },
    { type: "result", subtype: "success" },
    // The background subagent asks after the main turn ended.
    { type: "assistant", parent_tool_use_id: "toolu_agent", message: { id: "m2", content: [{ type: "tool_use", id: "toolu_sub", name: "Bash", input: { command: "make flash" } }] } },
    { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "make flash" }, tool_use_id: "toolu_sub" } },
    // The owner writes something else meanwhile; that turn asks too, and is stopped.
    { type: "_sent", n: 1, text: "meanwhile, check the README" },
    { type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "toolu_main", name: "Bash", input: { command: "cat README.md" } }] } },
    { type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "cat README.md" }, tool_use_id: "toolu_main" } },
    { type: "result", subtype: "error_during_execution", is_error: true },
  ]);
  assert.deepEqual(s.pending.map((p) => p.requestId), ["r1"], "the subagent still waits; the stopped turn's prompt is gone");
  assert.equal(core.chatStatus(s), "waiting");
  fold([{ type: "control_cancel_request", request_id: "r1" }]);
  assert.deepEqual(s.pending, []);
});

test("a transcript folds in linear time, to the same state as line by line", () => {
  const lines = [];
  const pad = "x".repeat(200);
  for (let i = 0; i < 4000; i++) {
    lines.push({ type: "user", uuid: `u${i}`, message: { role: "user", content: `prompt ${i} ${pad}` } });
    lines.push({ type: "assistant", message: { id: `m${i}a`, content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }] } });
    lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `out ${i}` }] } });
    lines.push({ type: "assistant", message: { id: `m${i}b`, content: [{ type: "text", text: `reply ${i} ${pad}` }] } });
  }
  const t0 = Date.now();
  const all = core.reduceAll(core.initialState("x"), lines);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `16,000 lines in ${ms} ms (line by line copying everything took 41 s)`);
  assert.equal(all.timeline.length, 12000);
  // Same as one at a time, on a part small enough to fold that way.
  let one = core.initialState("x");
  for (const e of lines.slice(0, 800)) one = core.reduce(one, e);
  assert.deepEqual(core.reduceAll(core.initialState("x"), lines.slice(0, 800)), one);
  // And a state handed out before is not changed by a later fold.
  const before = core.reduceAll(core.initialState("x"), lines.slice(0, 4));
  const snap = JSON.stringify(before);
  core.reduceAll(before, lines.slice(4, 40));
  assert.equal(JSON.stringify(before), snap);
});

test("following a long chat folds what was added in one pass, to the same state as line by line", () => {
  const turn = (i) => {
    const pad = "x".repeat(200);
    return [
      { type: "user", uuid: `u${i}`, message: { role: "user", content: `prompt ${i} ${pad}` } },
      { type: "assistant", message: { id: `m${i}a`, content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `out ${i}` }] } },
      { type: "assistant", message: { id: `m${i}b`, content: [{ type: "text", text: `reply ${i} ${pad}` }] } },
    ];
  };
  const history = [];
  for (let i = 0; i < 4000; i++) history.push(...turn(i));
  const chat = new core.Chat({ sessionId: "44444444-2222-4333-8444-555555555555", cwd: "/w", claudePath: FAKE, existing: true, idleMs: 60000 });
  chat.preload(history);
  const got = [];
  chat.on("event", (e) => got.push(e.type));
  const more = [];
  for (let i = 0; i < 50; i++) more.push(...turn(10000 + i));
  const t0 = performance.now();
  chat.follow(more.slice(0, 48));
  chat.follow(more.slice(48));
  const ms = performance.now() - t0;
  // Line by line, 48 and then 152 lines on 12,000 entries took about 1.1 s every 3 s tick (review r2 L-A).
  assert.ok(ms < 150, `200 lines followed in ${ms.toFixed(0)} ms`);
  assert.equal(got.filter((t) => t !== "_snapshot").length, 48, "a small batch goes to the page as its lines");
  assert.equal(got.at(-1), "_snapshot", "a large one as a snapshot");
  let one = core.reduceAll(core.initialState("44444444-2222-4333-8444-555555555555"), history.slice(-400));
  const two = core.reduceAll(one, more);
  for (const e of more) one = core.reduce(one, e);
  assert.deepEqual(two, one, "the same state as line by line");
  chat.dispose();
});

test("a live foreign thread follows its transcript by what was added, as events", () => {
  const root = tmp("follow-");
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const sid = "22222222-3333-4444-8555-666666666666";
    const pdir = path.join(root, "projects", "-w");
    fs.mkdirSync(pdir, { recursive: true });
    const file = path.join(pdir, `${sid}.jsonl`);
    const line = (o) => JSON.stringify(o) + "\n";
    fs.writeFileSync(file, line({ type: "user", cwd: "/w", message: { role: "user", content: "first" } }) + line({ type: "custom-title", customTitle: "Named here" }));
    const m = new core.ChatManager(() => ({ claudePath: FAKE, idleMs: 60000, log: () => {} }));
    const got = [];
    m.on("event", (_sid, e) => got.push(e.type));
    m.on("snapshot", () => got.push("snapshot"));
    const rec = m.openViewer(sid, "/w", null, null, false);
    assert.equal(rec.chat.state.title, "Named here");
    got.length = 0;
    // The session goes on: a reply, Claude's renewed ai-title (the custom name stays), half a line still being written.
    fs.appendFileSync(file, line({ type: "assistant", message: { id: "a1", content: [{ type: "text", text: "second" }] } }) + line({ type: "ai-title", aiTitle: "Claude's own" }) + '{"type":"user","mess');
    m.reloadViewer(sid);
    assert.deepEqual(got, ["assistant"], "the new line as an event, not a snapshot");
    assert.equal(rec.chat.state.title, "Named here");
    fs.appendFileSync(file, 'age":{"role":"user","content":"third"}}\n');
    m.reloadViewer(sid);
    const texts = rec.chat.state.timeline.map((id) => rec.chat.state.entries[id].text);
    assert.deepEqual(texts, ["first", "second", "third"], "the half line once it was whole");
    // The index reads what was added too.
    const idx = new core.TranscriptIndex(path.join(root, "projects"));
    assert.equal(idx.list(["/w"], 0)[0].title, "Named here");
    fs.appendFileSync(file, line({ type: "custom-title", customTitle: "Renamed" }));
    assert.equal(idx.list(["/w"], 0)[0].title, "Renamed");
    m.dispose();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// A stopped or failed compaction, through a scripted CLI (test/fake-compact.mjs).
function compactChat(env = {}) {
  const dir = tmp("compact-");
  const logFile = path.join(dir, "in.jsonl");
  const FC = path.join(here, "fake-compact.mjs");
  fs.chmodSync(FC, 0o755);
  const chat = new core.Chat({ sessionId: "33333333-2222-4333-8444-555555555555", cwd: dir, claudePath: FC, existing: false, idleMs: 600000, env: { ...process.env, FC_LOG: logFile, ...env } });
  const sent = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((o) => o.type === "user").map((o) => o.message.content) : []);
  const unsent = [];
  chat.on("unsent", (t) => unsent.push(t));
  return { chat, sent, unsent };
}
const held = (chat) => chat.state.timeline.map((id) => chat.state.entries[id]).filter((e) => e.kind === "user" && (e.held || e.unsent));

test("Stop during a held /compact: its rest is not sent, then or later, and goes back to the draft", async () => {
  const { chat, sent, unsent } = compactChat();
  chat.sendAfterCompact("/compact focus on: the widget", "now add the blink test");
  await waitFor(() => chat.state.compacting);
  const stopped = turns(chat, 1);
  await chat.interrupt();
  await stopped;
  assert.deepEqual(unsent, ["now add the blink test"], "back to the draft");
  assert.deepEqual(held(chat).map((e) => [e.text, !!e.pending, !!e.unsent]), [["now add the blink test", false, true]], "shown as not sent");
  let t = turns(chat, 1);
  chat.send("something else");
  await t;
  t = turns(chat, 1);
  chat.send("auto"); // a later turn auto-compacts
  await t;
  assert.deepEqual(sent(), ["/compact focus on: the widget", "something else", "auto"], "the old rest never went out");
  chat.dispose();
});

test("a held /compact that fails gives its rest back too", async () => {
  const { chat, sent, unsent } = compactChat({ FC_FAIL: "1" });
  const failed = turns(chat, 1);
  chat.sendAfterCompact("/compact focus on: the widget", "now add the blink test");
  await failed;
  assert.deepEqual(unsent, ["now add the blink test"]);
  const t = turns(chat, 1);
  chat.send("auto");
  await t;
  assert.deepEqual(sent(), ["/compact focus on: the widget", "auto"]);
  chat.dispose();
});
