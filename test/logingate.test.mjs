// The login's warm-up while its token is due (decision 105): the gate, the
// chat process that waits on it, the Haiku calls it skips, and a turn that
// still ends on the CLI's refresh lock. The lock's own failure is not
// recorded: refreshlock*.jsonl carry the CLI's made-up reply as a transcript
// of 2.1.287 holds it, inside basic.jsonl's recorded turns.

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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-gate-"));
const tmp = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const MIN = 60_000;
const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A login folder whose credentials file says the token expires at `expiresAt`; the tokens are made up. */
function loginFolder(expiresAt) {
  const dir = tmp("login-");
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up", refreshToken: "made-up", expiresAt, scopes: [] } }));
  return dir;
}

/** A warm-up stand-in: counts its calls, settles when `finish` is called, and moves the token's expiry to `fresh` then. */
function fakeWarm(dir, fresh) {
  const w = { calls: 0, finish: () => {} };
  w.fn = () => {
    w.calls++;
    return new Promise((r) => {
      w.finish = (err = null) => {
        if (fresh !== undefined) fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: fresh } }));
        r(err);
      };
    });
  };
  return w;
}

// ------------------------------------------------------------ the gate

test("a token is due within the CLI's 5-minute margin, and only `expiresAt` is read from the credentials file", () => {
  const now = 1_000_000_000_000;
  assert.equal(core.refreshDue(now + 10 * MIN, now), false);
  assert.equal(core.refreshDue(now + 5 * MIN, now), true);
  assert.equal(core.refreshDue(now - MIN, now), true);
  assert.equal(core.refreshDue(null, now), false, "no expiry to read: never due");
  const dir = loginFolder(now);
  assert.equal(core.tokenExpiry(dir), now);
  assert.equal(core.tokenExpiry(tmp("none-")), null, "no credentials file");
  fs.writeFileSync(path.join(dir, ".credentials.json"), "{not json");
  assert.equal(core.tokenExpiry(dir), null);
  assert.equal(core.loginDir({ CLAUDE_CONFIG_DIR: dir }), dir);
  assert.equal(core.loginDir({}), path.join(os.homedir(), ".claude"));
});

test("with a fresh token or no credentials file nothing waits and Haiku runs", () => {
  const warm = { calls: 0 };
  const gate = new core.LoginGate({ warm: async () => (warm.calls++, null), log: () => {} });
  const fresh = { CLAUDE_CONFIG_DIR: loginFolder(Date.now() + 60 * MIN) };
  const none = { CLAUDE_CONFIG_DIR: tmp("none-") };
  for (const env of [fresh, none]) {
    assert.equal(gate.wait(env), null);
    assert.equal(gate.quiet(env), false);
  }
  assert.equal(warm.calls, 0);
});

test("a due token: one warm-up for the folder, Haiku quiet while it runs, a chat's wait settled by it; then nothing waits", async () => {
  const dir = loginFolder(Date.now() - MIN);
  const env = { CLAUDE_CONFIG_DIR: dir };
  const w = fakeWarm(dir, Date.now() + 8 * 60 * MIN);
  const log = [];
  const gate = new core.LoginGate({ warm: w.fn, log: (l) => log.push(l) });
  assert.equal(gate.quiet(env), true, "a due token starts the warm-up");
  const a = gate.wait(env);
  const b = gate.wait(env);
  assert.ok(a && b);
  assert.equal(gate.quiet(env), true);
  assert.equal(w.calls, 1, "one warm-up, joined by every caller");
  let settled = false;
  a.then(() => (settled = true));
  await sleep(30);
  assert.equal(settled, false, "the chat waits for the warm-up");
  w.finish();
  await a;
  await b;
  assert.equal(gate.wait(env), null);
  assert.equal(gate.quiet(env), false);
  assert.ok(log.some((l) => /warm-up done .* token fresh/.test(l)), log.join("\n"));
  // Another login's folder is its own.
  const other = { CLAUDE_CONFIG_DIR: loginFolder(Date.now() - MIN) };
  assert.ok(gate.wait(other));
  assert.equal(w.calls, 2);
  w.finish();
});

test("a chat waits on a warm-up for at most the cap, and a failed warm-up settles its wait too", async () => {
  const dir = loginFolder(Date.now() - MIN);
  const env = { CLAUDE_CONFIG_DIR: dir };
  const w = fakeWarm(dir);
  const gate = new core.LoginGate({ warm: w.fn, log: () => {}, maxWaitMs: 50 });
  const t0 = Date.now();
  await gate.wait(env);
  assert.ok(Date.now() - t0 < 1000, "the cap let it go");
  assert.equal(gate.quiet(env), true, "the warm-up still runs: Haiku stays quiet");
  w.finish("lock busy");
  await sleep(10);
  const thrown = new core.LoginGate({ warm: async () => { throw new Error("spawn failed"); }, log: () => {} });
  await thrown.wait(env);
});

test("recover: at once when another process has refreshed meanwhile, else warm-ups a pause apart, and false when they run out", async () => {
  const fresh = { CLAUDE_CONFIG_DIR: loginFolder(Date.now() + 60 * MIN) };
  let calls = 0;
  const gate = new core.LoginGate({ warm: async () => (calls++, "lock busy"), log: () => {}, pauseMs: 5 });
  assert.equal(await gate.recover(fresh), true);
  assert.equal(calls, 0);
  const stuck = { CLAUDE_CONFIG_DIR: loginFolder(Date.now() - MIN) };
  assert.equal(await gate.recover(stuck), false);
  assert.equal(calls, 3);
  const none = { CLAUDE_CONFIG_DIR: tmp("none-") };
  assert.equal(await gate.recover(none), true, "no expiry to read: one warm-up is taken as enough");
  assert.equal(calls, 4);
  const dir = loginFolder(Date.now() - MIN);
  const w = fakeWarm(dir, Date.now() + 60 * MIN);
  const ok = new core.LoginGate({ warm: w.fn, log: () => {}, pauseMs: 5 });
  const r = ok.recover({ CLAUDE_CONFIG_DIR: dir });
  await waitFor(() => w.calls === 1);
  w.finish();
  assert.equal(await r, true);
});

test("the warm-up is one stripped Haiku call under the login's environment", async () => {
  const dir = tmp("warm-");
  const argsLog = path.join(dir, "args.jsonl");
  const err = await core.warmUp(FAKE, { ...process.env, CLAUDE_CONFIG_DIR: dir, FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_HAIKU_NONE: path.join(here, "fixtures", "haiku", "ghost.jsonl") });
  assert.equal(err, null);
  const [call] = lines(argsLog);
  assert.ok(call.argv.includes("-p"));
  assert.equal(call.argv[call.argv.indexOf("--model") + 1], "haiku");
  assert.equal(call.prompt, "OK");
  assert.equal(call.env.EMBARCH_DESK_INTERNAL, "1", "the desk's hooks stay out of it");
});

// ------------------------------------------------------------ Haiku

test("a quiet login skips the assistant's calls: no `claude -p` starts", async () => {
  const dir = tmp("haiku-");
  const argsLog = path.join(dir, "args.jsonl");
  const log = [];
  let quiet = true;
  const a = new core.HaikuAssistant(() => ({ claudePath: FAKE, enabled: true, log: (l) => log.push(l), env: { ...core.haikuEnv(), FAKE_CLAUDE_ARGS_LOG: argsLog }, quiet: () => quiet }));
  const input = { draft: "Run the tests and ", lastReply: "The widget driver now builds.", item: null, library: [], context: null };
  assert.equal(await a.ghost("s1", input, () => {}), null);
  // With a reference, or the cards call is not made at all (97).
  assert.equal(await a.cards("s1", { ...input, references: [{ id: "r1", line: "x", prs: [] }] }), null);
  assert.deepEqual(lines(argsLog), []);
  assert.ok(log.some((l) => /haiku ghost: skipped, the login is being refreshed/.test(l)), log.join("\n"));
  quiet = false;
  await a.ghost("s1", input, () => {});
  assert.equal(lines(argsLog).length, 1, "a fresh login runs it");
  a.dispose();
});

// ------------------------------------------------------------ a chat's process

function makeChat(name, opts = {}) {
  const dir = tmp("chat-");
  const argsLog = path.join(dir, "args.jsonl");
  const inputLog = path.join(dir, "input.jsonl");
  const log = [];
  const chat = new core.Chat({
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: dir,
    claudePath: FAKE,
    existing: false,
    idleMs: 60000,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture(name), FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_CLAUDE_INPUT_LOG: inputLog },
    log: (l) => log.push(l),
    gate: opts.gate,
    recover: opts.recover,
  });
  const notes = () => Object.values(chat.state.entries).filter((e) => e.kind === "note").map((e) => e.text);
  return { chat, spawns: () => lines(argsLog), inputs: () => lines(inputLog).map((l) => l.o), log, notes };
}

test("a chat's process spawns only once the warm-up is done, and what was sent meanwhile goes after its initialize", async () => {
  let release;
  const ready = new Promise((r) => (release = r));
  let asked = 0;
  const { chat, spawns, inputs, log } = makeChat("basic", { gate: () => (asked++, ready) });
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  assert.equal(chat.state.process, "starting");
  await sleep(150);
  assert.deepEqual(spawns(), [], "nothing spawned while the login refreshes");
  release();
  await new Promise((r) => chat.once("turn", r));
  assert.equal(spawns().length, 1);
  const sent = inputs();
  assert.equal(sent[0].request?.subtype, "initialize", "the initialize is still the first line");
  assert.equal(sent[1].type, "user");
  assert.equal(asked, 1);
  assert.ok(log.some((l) => /token is due: the process starts after its warm-up/.test(l)));
  chat.dispose();
});

test("a chat closed or disposed while its process waits on the warm-up never spawns it", async () => {
  let release;
  const ready = new Promise((r) => (release = r));
  const { chat, spawns } = makeChat("basic", { gate: () => ready });
  chat.send("Reply with just: ok");
  chat.dispose();
  release();
  await sleep(150);
  assert.deepEqual(spawns(), []);
  const p = new core.ClaudeProcess({ claudePath: FAKE, cwd: os.tmpdir(), sessionId: "11111111-2222-4333-8444-555555555555", resume: false, permissionMode: "default", ready: new Promise(() => {}) });
  const exit = new Promise((r) => p.once("exit", r));
  p.start();
  const ask = assert.rejects(p.request("get_context_usage", {}, 60000), /not started/);
  p.close();
  assert.deepEqual(await exit, { code: 0, signal: null, stderr: "" });
  await ask;
  assert.equal(p.exited, true);
});

test("a turn that ends on the CLI's refresh lock before any step: the login is recovered, then the message goes again, once", async () => {
  let recovered = 0;
  const { chat, inputs, notes, log } = makeChat("refreshlock", { recover: async () => (recovered++, true) });
  const ended = [];
  chat.on("turn", (o) => ended.push(o));
  chat.send("Reply with just: ok");
  await waitFor(() => ended.length === 2);
  assert.equal(ended[0].is_error, true);
  assert.equal(recovered, 1);
  const users = inputs().filter((l) => l.type === "user");
  assert.equal(users.length, 2);
  assert.deepEqual(users[1].message, users[0].message, "the same message");
  assert.notEqual(users[1].uuid, users[0].uuid, "under its own uuid");
  assert.ok(notes().includes(core.LOCK_RESEND_NOTE));
  const s = chat.state;
  const top = s.timeline.map((id) => s.entries[id]);
  assert.equal(top.filter((e) => e.kind === "user").length, 2);
  assert.equal(top.at(-1).text, "ok");
  assert.ok(log.some((l) => /sent again after the login's refresh/.test(l)));
  chat.dispose();
});

test("a turn that hits the lock after a step ran sends nothing again; a login that stays due says so", async () => {
  let recovered = 0;
  const { chat, inputs, notes } = makeChat("refreshlockstep", { recover: async () => (recovered++, false) });
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  await new Promise((r) => chat.once("turn", r));
  await waitFor(() => notes().includes(core.LOCK_STALE_NOTE));
  assert.equal(recovered, 1);
  assert.ok(notes().includes(core.LOCK_REFRESH_NOTE));
  assert.equal(inputs().filter((l) => l.type === "user").length, 1);
  chat.dispose();
});

test("without a recover, a turn on the lock is left as the CLI ended it", async () => {
  const { chat, inputs, notes } = makeChat("refreshlock");
  chat.send("Reply with just: ok");
  await new Promise((r) => chat.once("turn", r));
  await sleep(100);
  assert.equal(inputs().filter((l) => l.type === "user").length, 1);
  assert.ok(!notes().includes(core.LOCK_RESEND_NOTE));
  chat.dispose();
});

test("only the CLI's refresh-lock reply is taken for one", () => {
  const reply = (text) => ({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] } });
  assert.equal(core.isRefreshLockError(reply("Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.")), true);
  assert.equal(core.isRefreshLockError(reply("Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh)")), true);
  assert.equal(core.isRefreshLockError(reply("API Error: 500")), false);
  assert.equal(core.isRefreshLockError({ type: "user", message: { content: [{ type: "text", text: "another Claude Code process is refreshing it" }] } }), false, "the owner quoting it");
});
