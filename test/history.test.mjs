// A chat's history over the wire (decisions 73–75), against
// recorded real sessions replayed by fake-claude.mjs: a fork by the CLI's
// own --fork-session, a file rewind and its dry run (recorded in a scratch
// folder, where it put a.txt back), the CLI's /export text, and a name given
// by hand. Run with `npm test`.

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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-history-"));
const tmp = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const SID = "11111111-2222-4333-8444-555555555555";
const PARENT = "6c563cde-6794-42ea-b651-dbbcb0946fdc";
const PARENT_FILE = path.join(here, "fixtures", "fork", `${PARENT}.jsonl`);

function makeChat(name, opts = {}) {
  const dir = tmp("chat-");
  const argsLog = path.join(dir, "args.jsonl");
  const inputLog = path.join(dir, "in.jsonl");
  const chat = new core.Chat({
    sessionId: opts.sessionId ?? SID,
    cwd: opts.cwd ?? dir,
    claudePath: FAKE,
    existing: opts.existing ?? false,
    idleMs: opts.idleMs ?? 60000,
    fork: opts.fork,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture(name), FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_CLAUDE_INPUT_LOG: inputLog, ...(opts.env ?? {}) },
  });
  // The recordings asked before each Write and Edit, and were allowed.
  chat.on("event", (e) => {
    if (e.type === "control_request" && e.request?.subtype === "can_use_tool") {
      setImmediate(() => {
        const p = chat.state.pending.find((x) => x.requestId === e.request_id);
        if (p) chat.allow(p);
      });
    }
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { chat, dir, spawns: () => read(argsLog), inputs: () => read(inputLog).map((l) => l.o) };
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
const users = (s) => s.timeline.map((id) => s.entries[id]).filter((e) => e.kind === "user");

// ------------------------------------------------------------ fork

test("a fork point is the entry before the owner's message; the first message has none", () => {
  const lines = fs.readFileSync(PARENT_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const [first, second] = lines.filter((l) => l.type === "user");
  assert.deepEqual(core.forkPoint(PARENT_FILE, second.uuid), { at: second.parentUuid });
  assert.deepEqual(core.forkPoint(PARENT_FILE, first.uuid), { at: null });
  assert.equal(core.forkPoint(PARENT_FILE, "99999999-0000-4000-8000-000000000000"), undefined, "not in the transcript");
});

test("a fork shows the parent's conversation up to its point, and nothing after", () => {
  const second = fs.readFileSync(PARENT_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "user")[1];
  const s = core.reduceAll(core.initialState(SID), core.historyUpTo(PARENT_FILE, second.parentUuid));
  assert.deepEqual(
    s.timeline.map((id) => [s.entries[id].kind, s.entries[id].text]),
    [
      ["user", "Remember the word PELICAN. Reply with just: noted"],
      ["text", "noted"],
    ],
  );
  assert.equal(s.title, null, "the fork is named on its own, not by the parent's titles");
  assert.ok(users(s)[0].uuid, "its messages keep their ids: a fork of a fork names them");
});

test("a fork's first process copies the parent with the CLI's own flags; once it exists it resumes as itself", async () => {
  const at = fs.readFileSync(PARENT_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "user")[1].parentUuid;
  const { chat, spawns } = makeChat("fork", { fork: { from: PARENT, at }, idleMs: 150 });
  chat.send("Which words did I ask you to remember? Reply with the words only.");
  await turns(chat, 1);
  const a = spawns()[0].argv;
  assert.ok(a.includes(`--resume=${PARENT}`), a.join(" "));
  assert.ok(a.includes("--fork-session"));
  assert.equal(a[a.indexOf("--session-id") + 1], chat.sessionId, "the copy is named by this chat's id");
  assert.equal(a[a.indexOf("--resume-session-at") + 1], at);
  assert.equal(chat.state.entries[chat.state.timeline.at(-1)].text, "PELICAN", "it knows only what came before the point");
  await once(chat, "closed");
  chat.send("again");
  await turns(chat, 1);
  const b = spawns()[1].argv;
  assert.ok(b.includes(`--resume=${chat.sessionId}`) && !b.includes("--fork-session") && !b.includes("--resume-session-at"), b.join(" "));
  chat.dispose();
});

test("a fork point that is not a UUID never reaches claude's command line", () => {
  assert.throws(() => core.claudeArgs({ claudePath: "claude", cwd: "/w", sessionId: SID, resume: false, permissionMode: "auto", fork: { from: PARENT, at: "--model=opus" } }), /not a fork point/);
});

// ------------------------------------------------------------ rewind

test("every chat runs with file checkpoints, and the owner's messages carry their transcript ids", async () => {
  const { chat, spawns } = makeChat("rewind");
  chat.send("Use the Write tool to create a.txt containing exactly the word: one. Then reply with just: done");
  await turns(chat, 1);
  assert.equal(spawns()[0].env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, "true");
  const [u] = users(chat.state);
  assert.equal(u.uuid, fixtureReplayUuids("rewind")[0]);
  chat.dispose();
});

test("a step rerun after a window reload runs with file checkpoints too (decision 63)", async () => {
  const { chat, spawns } = makeChat("basic", { existing: true });
  chat.continueInterrupted();
  await waitFor(() => spawns().length === 1);
  assert.equal(spawns()[0].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, "1");
  assert.equal(spawns()[0].env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, "true");
  chat.dispose();
});

/** The uuids the CLI gave the owner's messages, from their replays. */
function fixtureReplayUuids(name) {
  return fs
    .readFileSync(fixture(name), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.d === "out" && e.o.type === "user" && e.o.isReplay)
    .map((e) => e.o.uuid);
}

test("rewinding the files: a dry run says what would change, then the rewind itself", async () => {
  const { chat, inputs } = makeChat("rewind");
  chat.send("Use the Write tool to create a.txt containing exactly the word: one. Then reply with just: done");
  await turns(chat, 1);
  chat.send("Use the Edit tool to change one to two in a.txt. Then reply with just: done");
  await turns(chat, 1);
  const second = users(chat.state)[1].uuid;
  const dry = await chat.rewindFiles(second, true);
  assert.equal(dry.canRewind, true);
  assert.deepEqual(dry.filesChanged, ["/work/rec/rewind/a.txt"]);
  assert.deepEqual([dry.insertions, dry.deletions], [1, 1]);
  const done = await chat.rewindFiles(second, false);
  assert.equal(done.canRewind, true);
  assert.equal(done.skippedLinks, 0);
  const asked = inputs().filter((o) => o.type === "control_request" && o.request.subtype === "rewind_files");
  assert.deepEqual(
    asked.map((o) => o.request),
    [
      { subtype: "rewind_files", user_message_id: second, dry_run: true },
      { subtype: "rewind_files", user_message_id: second },
    ],
  );
  chat.dispose();
});

test("a closed chat is resumed for a rewind, and asked before any message", async () => {
  const first = fixtureReplayUuids("rewind")[0];
  const { chat, spawns } = makeChat("rewindresume", { existing: true });
  const dry = await chat.rewindFiles(first, true);
  assert.ok(spawns()[0].argv.includes(`--resume=${SID}`));
  assert.equal(dry.canRewind, true);
  assert.deepEqual([dry.insertions, dry.deletions], [0, 1], "a.txt did not exist before the first message");
  assert.equal(chat.state.process, "running", "a process started for a request runs, though it wrote nothing yet");
  chat.dispose();
});

test("a new chat has nothing to rewind, and starts no process for it", async () => {
  const { chat, spawns } = makeChat("basic");
  await assert.rejects(chat.rewindFiles(SID, true), /no conversation yet/);
  assert.equal(spawns().length, 0);
  chat.dispose();
});

// ------------------------------------------------------------ export

test("a new chat has nothing to export, and starts no process for it", async () => {
  const { chat, spawns } = makeChat("basic");
  await assert.rejects(chat.exportConversation(), /no conversation yet/);
  assert.equal(spawns().length, 0);
  chat.dispose();
});

test("a closed chat is resumed for its export: the CLI's own /export text, with the file name it offers", async () => {
  const { chat, spawns } = makeChat("export", { existing: true });
  const r = await chat.exportConversation();
  assert.ok(spawns()[0].argv.includes(`--resume=${SID}`));
  assert.match(r.text, /^\n?❯ Run the bash command echo hello-from-bash and then reply with just: done\n\n● Bash\(echo hello-from-bash\)\n {2}⎿\s+hello-from-bash\n\n● done$/, "as the terminal renders it, a no-break space and all");
  assert.match(r.filename, /^\d{4}-\d{2}-\d{2}-\d{6}-run-the-bash-command-echo-hello-from-bash-and-t\.txt$/);
  assert.equal(chat.state.process, "running", "a process started for a request runs, though it wrote nothing yet");
  chat.dispose();
});

test("the panel's own plain text for a chat no process may run: the owner's messages, Claude's replies and steps", () => {
  const lines = fs
    .readFileSync(fixture("basic"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.d === "out")
    .map((e) => e.o);
  const s = core.reduceAll(core.initialState(SID), lines);
  const text = core.conversationText(s);
  assert.match(text, /^❯ Run the bash command `echo hello-from-bash`/);
  assert.match(text, /● Bash\(echo hello-from-bash\)\n {2}⎿ {2}hello-from-bash/);
  assert.match(text, /● done\n\n❯ Reply with just: ok\n\n● ok\n$/);
  assert.equal(core.exportFileName(s, new Date(2026, 9, 23, 14, 5, 9)), "2026-10-23-140509-run-the-bash-command-echo-hello-from-bash-and-th.txt", "cut at 48 as the CLI cuts its own");
});

// ------------------------------------------------------------ a name by hand

test("a name given by hand to a running chat goes out with rename_session and stays", async () => {
  const { chat, inputs } = makeChat("controls");
  chat.send("@note.txt what is the secret? One word.");
  await turns(chat, 1);
  await chat.renameByHand("Widget blink bring-up");
  assert.equal(chat.state.title, "Widget blink bring-up");
  assert.ok(chat.handNamed && chat.renamed);
  assert.deepEqual(
    inputs()
      .filter((o) => o.request?.subtype === "rename_session")
      .map((o) => o.request.title),
    ["Widget blink bring-up"],
  );
  chat.dispose();
});

test("a closed chat's name by hand is Claude Code's custom-title line, and wins over a later ai-title", async () => {
  const config = tmp("config-");
  const cwd = tmp("work-");
  const file = core.transcriptPath(cwd, SID, path.join(config, "projects"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A transcript whose last line Claude did not end: the name still lands on a line of its own.
  fs.writeFileSync(file, [JSON.stringify({ type: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000001", message: { role: "user", content: "hi" }, cwd }), JSON.stringify({ type: "ai-title", aiTitle: "Greeting" })].join("\n"));
  const { chat, spawns } = makeChat("basic", { existing: true, cwd, env: { CLAUDE_CONFIG_DIR: config } });
  await chat.renameByHand("Named by hand");
  assert.equal(spawns().length, 0, "no process started for a name");
  fs.appendFileSync(file, JSON.stringify({ type: "ai-title", aiTitle: "Claude renews its own" }) + "\n");
  const { meta } = core.readTranscript(file);
  assert.equal(meta.title, "Named by hand", "after a reload the list and the chat read it back");
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"custom-title"')).length, 1);
  chat.dispose();
});

test("a chat with no transcript yet keeps its name by hand until its first turn has ended", async () => {
  const { chat, inputs } = makeChat("basic");
  await chat.renameByHand("Before the first turn");
  assert.equal(chat.state.title, "Before the first turn");
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  await turns(chat, 1);
  await waitFor(() => inputs().some((o) => o.request?.subtype === "rename_session"));
  assert.equal(inputs().find((o) => o.request?.subtype === "rename_session").request.title, "Before the first turn");
  chat.dispose();
});
