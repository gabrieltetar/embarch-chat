// Promptu in the chat (decisions 94–98), on the Node side: the CLI wrapper
// (src/promptu/cli.ts), one run per chat from the rough prompt to the
// prompt for the draft (runs.ts), the card's state (service.ts) and the
// pure helpers (text.ts) — against test/fake-promptu.mjs, never a model.
// With PROMPTU_BIN naming a build of embarch-promptu, the real CLI runs one
// pass too, offline (its `claude` is a path that does not exist), in
// scratch config, state and Claude folders: never the owner's.

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
const FAKE = path.join(here, "fake-promptu.mjs");
fs.chmodSync(FAKE, 0o755);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-promptu-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const scratch = () => fs.mkdtempSync(path.join(ROOT, "s-"));

function setup(env = {}, bin = FAKE) {
  const dir = scratch();
  const lines = [];
  const cli = new core.PromptuCli(() => ({ bin, log: (l) => lines.push(l), env: { ...process.env, FAKE_PROMPTU_DIR: dir, ...env } }));
  const runs = new core.PromptuRuns(cli, (l) => lines.push(l));
  const views = [];
  runs.on("view", (sid, v) => views.push(v));
  const calls = () => (fs.existsSync(path.join(dir, "log.jsonl")) ? fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, cli, runs, views, calls, lines };
}
const SID = "11111111-0000-4000-8000-000000000001";
const BEGIN = { rough: "add a watchdog to the loader", origin: "enter", have: ["desk"], quick: false };

// ------------------------------------------------------------ the binary and its failures

test("the binary is the setting's path, or the first executable of its name on PATH", () => {
  const d = scratch();
  const exe = path.join(d, "promptu");
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(d, "plain"), "x", { mode: 0o644 });
  fs.mkdirSync(path.join(d, "dir-named-promptu", "promptu"), { recursive: true });
  assert.equal(core.findBinary("promptu", `/nonexistent:${d}`), exe);
  assert.equal(core.findBinary("promptu", path.join(d, "dir-named-promptu")), null, "a folder of that name is not it");
  assert.equal(core.findBinary(exe, ""), exe);
  assert.equal(core.findBinary(path.join(d, "plain"), ""), null, "not executable");
  assert.equal(core.findBinary("promptu", ""), null);
  assert.equal(core.findBinary("", d), null);
});

test("whatever goes wrong is one line: not installed, a non-zero exit, a timeout, no JSON", async () => {
  const missing = setup({}, "/nonexistent/promptu");
  const r1 = await missing.cli.patterns(ROOT);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /^promptu is not installed here \(\/nonexistent\/promptu\): set embarchChat\.promptuPath/);
  const failing = setup({ FAKE_PROMPTU_FAIL: "prep:2:no rough prompt on stdin" });
  const r2 = await failing.cli.prep("x", { cwd: ROOT, have: [] });
  assert.equal(r2.error, "promptu prep failed (exit 2): no rough prompt on stdin");
  const slow = setup({ FAKE_PROMPTU_SLEEP_MS: "3000" });
  const t0 = Date.now();
  const r3 = await slow.cli.run(["prep", "--have", "none"], { cwd: ROOT, stdin: "x", timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 2000, "killed at the timeout");
  assert.equal(r3.error, "promptu prep took over 0 s");
  const d = scratch();
  const noJson = path.join(d, "promptu");
  fs.writeFileSync(noJson, "#!/bin/sh\necho hello\n", { mode: 0o755 });
  const r4 = await setup({}, noJson).cli.patterns(ROOT);
  assert.equal(r4.error, "promptu patterns printed no JSON");
});

test("prep is called with the parts, the forced pattern, Quick mode as --rec and Start work as --start, the rough prompt on stdin, in the chat's folder", async () => {
  const s = setup();
  const cwd = scratch();
  await s.cli.prep("fix it\nnow", { cwd, have: ["desk", "embarch-api"], pattern: "debug-failure", quick: true, start: true });
  await s.cli.prep("fix it", { cwd, have: [] });
  const [a, b] = s.calls();
  assert.deepEqual(a.args, ["--have", "desk,embarch-api", "--pattern", "debug-failure", "--rec", "--start"]);
  assert.equal(a.stdin, "fix it\nnow");
  assert.equal(fs.realpathSync(a.cwd), fs.realpathSync(cwd));
  assert.deepEqual(b.args, ["--have", "none"]);
});

// ------------------------------------------------------------ a run, page by page (96)

test("a run: prep plans a page, the owner answers it, nothing is left, render writes the prompt for the draft", async () => {
  const s = setup({ FAKE_PROMPTU_PAGES: "2" });
  await s.runs.begin(SID, { ...BEGIN, cwd: ROOT });
  const v = s.runs.view(SID);
  assert.equal(v.phase, "ask");
  assert.deepEqual(v.step.pages[0].ids, ["done", "goal"]);
  assert.deepEqual(s.views.slice(0, 1).map((x) => [x.phase, x.doing]), [["working", "prep"]], "the dialog shows at once, working");
  await s.runs.answer(SID, v.seq, core.cleanInput({ answers: { done: "Build and tests pass (Recommended)", goal: { other: "so field units recover" } } }));
  const v2 = s.runs.view(SID);
  assert.deepEqual(v2.step.pages[0].ids, ["rules"], "the next page, as next plans it");
  await s.runs.answer(SID, v2.seq, core.cleanInput({ answers: { rules: ["Use another checkout (Recommended)"] } }));
  assert.equal(s.runs.view(SID), null, "the dialog closes");
  const r = s.runs.take(SID);
  assert.equal(s.runs.take(SID), null, "taken once");
  assert.match(r.prompt, /^## Goal\nadd a watchdog to the loader\n/);
  assert.match(r.prompt, /— promptu implement-issue@1 asked=done:rec,goal:rec,rules:rec$/);
  assert.equal(r.origin, "enter");
  assert.deepEqual(
    s.calls().map((c) => c.cmd),
    ["prep", "next", "next", "render"],
  );
  assert.deepEqual(s.calls()[1].stdin && JSON.parse(s.calls()[1].stdin).answers.goal, { other: "so field units recover" });
});

test("Esc keeps the answers given and takes the rest as assumptions; Accept all takes every recommendation", async () => {
  const s = setup();
  await s.runs.begin(SID, { ...BEGIN, cwd: ROOT });
  await s.runs.finish(SID, s.runs.view(SID).seq, core.cleanInput({ answers: { done: "I'll judge it" } }), "assume");
  const r = s.runs.take(SID);
  assert.match(r.prompt, /asked=done:rec assume=goal$/);
  const render = s.calls().at(-1);
  assert.deepEqual(render.args, [render.args[0], "--rest", "assume"]);
  assert.deepEqual(JSON.parse(render.stdin), { answers: { done: "I'll judge it" } });
  const t = setup();
  await t.runs.begin(SID, { ...BEGIN, cwd: ROOT });
  await t.runs.finish(SID, t.runs.view(SID).seq, {}, "recommended");
  assert.deepEqual(t.calls().at(-1).args.slice(1), ["--rest", "recommended"]);
  assert.ok(t.runs.take(SID).prompt);
});

test("the chip row is a page too: its pick goes as the pattern", async () => {
  const s = setup({ FAKE_PROMPTU_CHOOSE: "1" });
  await s.runs.begin(SID, { ...BEGIN, cwd: ROOT });
  const v = s.runs.view(SID);
  assert.deepEqual(v.step.choose.ids, ["_pattern"]);
  await s.runs.answer(SID, v.seq, core.cleanInput({ pattern: "debug-failure" }));
  assert.equal(s.runs.view(SID).step.pattern.id, "debug-failure");
});

test("Quick mode asks nothing: prep --rec is done, and render writes the prompt", async () => {
  const s = setup();
  await s.runs.begin(SID, { ...BEGIN, cwd: ROOT, quick: true });
  assert.ok(s.runs.take(SID).prompt);
  assert.deepEqual(
    s.calls().map((c) => [c.cmd, c.args.includes("--rec")]),
    [
      ["prep", true],
      ["render", false],
    ],
  );
  assert.ok(s.views.every((v) => v === null || (v.quick && v.phase === "working")), "no page was shown");
});

test("a failure is one line and no prompt; Start work's starter comes back instead (96)", async () => {
  const s = setup({ FAKE_PROMPTU_FAIL: "render:1:the run could not be read" });
  await s.runs.begin(SID, { ...BEGIN, cwd: ROOT, origin: "start", start: true, fallback: "Read ABC-7 — the old starter" });
  await s.runs.finish(SID, s.runs.view(SID).seq, {}, "assume");
  const r = s.runs.take(SID);
  assert.equal(r.prompt, undefined);
  assert.equal(r.error, "promptu render failed (exit 1): the run could not be read");
  assert.equal(r.fallback, "Read ABC-7 — the old starter");
  const missing = setup({}, "/nonexistent/promptu");
  await missing.runs.begin(SID, { ...BEGIN, cwd: ROOT });
  const r2 = missing.runs.take(SID);
  assert.match(r2.error, /^promptu is not installed here/);
  assert.equal(r2.fallback, undefined, "Enter's own draft stays as typed: nothing to put in it");
});

test("Esc while the pass reads the prompt cancels it: no prompt, the draft as typed; stale answers do nothing", async () => {
  const s = setup({ FAKE_PROMPTU_SLEEP_MS: "4000" });
  const p = s.runs.begin(SID, { ...BEGIN, cwd: ROOT });
  await new Promise((r) => setTimeout(r, 150));
  const v = s.runs.view(SID);
  assert.equal(v.phase, "working");
  const t0 = Date.now();
  s.runs.cancel(SID, v.seq);
  await p;
  assert.ok(Date.now() - t0 < 2000, "the pass was stopped");
  assert.deepEqual(s.runs.take(SID), { sid: SID, seq: v.seq, origin: "enter", rough: BEGIN.rough, cancelled: true });
  await s.runs.answer(SID, v.seq, {});
  await s.runs.finish(SID, v.seq, {}, "assume");
  assert.equal(s.runs.take(SID), null);
  assert.deepEqual(
    s.calls().map((c) => c.cmd),
    ["prep"],
  );
});

test("Start work's pass reads the work item from a private file, cut to 2,000 characters, gone once prep is done", async () => {
  const s = setup();
  const text = "The loader should retry after a reset. ".repeat(80);
  await s.runs.begin(SID, { ...BEGIN, cwd: ROOT, origin: "start", start: true, desk: { key: "ABC-7", title: "Loader retries", url: "https://linear.app/x/issue/ABC-7", id: "w9", text } });
  const [prep] = s.calls();
  assert.ok(prep.args.includes("--start") && prep.args.includes("--desk"));
  assert.equal(prep.deskMode, "600");
  assert.equal(prep.desk.key, "ABC-7");
  assert.equal(prep.desk.id, "w9");
  assert.equal(prep.desk.text.length, core.DESK_TEXT_MAX);
  assert.ok(prep.desk.text.endsWith("…"));
  assert.ok(!fs.existsSync(prep.args[prep.args.indexOf("--desk") + 1]), "removed after prep");
  assert.equal(s.runs.view(SID).step.filled[0].source, "desk");
});

test("a chat that goes takes its run with it", async () => {
  const s = setup({ FAKE_PROMPTU_SLEEP_MS: "1500" });
  const first = s.runs.begin(SID, { ...BEGIN, cwd: ROOT });
  await new Promise((r) => setTimeout(r, 100));
  s.runs.forget(SID);
  await first;
  assert.equal(s.runs.view(SID), null);
  assert.equal(s.runs.take(SID), null);
});

test("a run goes with its chat: an idle close waits while its dialog or its prompt is the owner's, then nothing of it is left; a crash and a dropped view take it too (41, 96)", async () => {
  const FAKE_CLAUDE = path.join(here, "fake-claude.mjs");
  fs.chmodSync(FAKE_CLAUDE, 0o755);
  const was = process.env.FAKE_CLAUDE_FIXTURE;
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "basic.jsonl");
  const s = setup();
  const manager = new core.ChatManager(() => ({ claudePath: FAKE_CLAUDE, idleMs: 300, log: () => {}, hold: (sid) => s.runs.holdReason(sid) }));
  manager.on("closed", (sid) => s.runs.forget(sid));
  manager.on("released", (sid) => s.runs.forget(sid));
  const until = async (pred, ms = 5000, what = "it") => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  try {
    const rec = manager.create(SID, scratch(), null, null);
    const turned = new Promise((r) => manager.once("turn", r));
    rec.chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
    await turned;
    // A pass mid-task (a forced pattern): its dialog keeps the process past its idle time.
    await s.runs.begin(SID, { ...BEGIN, cwd: ROOT });
    const seq = s.runs.view(SID).seq;
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(rec.chat.running, "held while the dialog is open");
    assert.equal(rec.chat.holdReason(), "a Promptu dialog is open");
    // Done, its prompt not taken by a page yet: still the owner's.
    await s.runs.finish(SID, seq, {}, "recommended");
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(rec.chat.running, "held while its prompt waits");
    assert.ok(s.runs.take(SID).prompt);
    await until(() => !rec.chat.running, 5000, "the idle close once nothing is the owner's");
    // A crash with a prompt waiting: forgotten, so it never lands in the chat resumed later.
    const turned2 = new Promise((r) => manager.once("turn", r));
    rec.chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
    await turned2;
    await s.runs.begin(SID, { ...BEGIN, cwd: ROOT });
    const views = s.views.length;
    process.kill(rec.chat.pid, "SIGKILL");
    await until(() => !rec.chat.running, 5000, "the crash");
    assert.equal(s.runs.view(SID), null);
    assert.equal(s.runs.take(SID), null);
    assert.equal(s.views.at(-1), null, "the page is told the dialog went");
    assert.ok(s.views.length > views);
    // A read-only view dropped: its run goes with it.
    const other = "33333333-0000-4000-8000-000000000009";
    manager.openViewer(other, scratch(), null, null, true);
    await s.runs.begin(other, { ...BEGIN, cwd: ROOT });
    assert.ok(s.runs.view(other));
    manager.release(other);
    assert.equal(s.runs.view(other), null);
    assert.equal(s.runs.take(other), null);
  } finally {
    manager.dispose();
    if (was === undefined) delete process.env.FAKE_CLAUDE_FIXTURE;
    else process.env.FAKE_CLAUDE_FIXTURE = was;
  }
});

test("answers from a page keep to the forms next and render take", () => {
  assert.deepEqual(
    core.cleanInput({
      pattern: "debug-failure",
      answers: { done: "x", rules: ["a", 3, "b"], goal: { other: "why" }, attached: { labels: ["a"], other: "probe" }, "bad key": "x", _rest: "Keep going", n: 4, o: {} },
      extra: 1,
    }),
    { pattern: "debug-failure", answers: { done: "x", rules: ["a", "b"], goal: { other: "why" }, attached: { labels: ["a"], other: "probe" }, _rest: "Keep going" } },
  );
  assert.deepEqual(core.cleanInput(null), {});
  assert.equal(core.cleanInput({ answers: { done: "y".repeat(9000) } }).answers.done.length, 4000);
});

// ------------------------------------------------------------ the card's state (95)

test("the card: on by default, Quick mode off, switched in the extension's own state; the patterns read once", async () => {
  const data = {};
  const store = { get: (k, d) => (k in data ? data[k] : d), update: async (k, v) => void (data[k] = v) };
  const s = setup();
  const svc = new core.PromptuService(s.cli, store, () => {});
  const changed = new Promise((r) => svc.once("state", r));
  const st = svc.state(ROOT);
  assert.deepEqual([st.available, st.enabled, st.quick, st.why], [true, true, false, null]);
  await changed;
  assert.deepEqual(
    svc.state(ROOT).patterns.map((p) => p.name),
    ["debug-failure", "handoff", "implement-issue"],
  );
  assert.equal(s.calls().filter((c) => c.cmd === "patterns").length, 1, "cached");
  await svc.set({ enabled: false, quick: true });
  assert.deepEqual([svc.state(ROOT).enabled, svc.quick(), svc.ready()], [false, true, false]);
  await svc.set({ enabled: "yes" });
  assert.equal(svc.state(ROOT).enabled, false, "only a boolean switches it");
  const gone = new core.PromptuService(setup({}, "/nonexistent/promptu").cli, store, () => {});
  const g = gone.state(ROOT);
  assert.deepEqual([g.available, g.patterns, gone.ready()], [false, [], false]);
  assert.match(g.why, /not installed/);
});

test("the bench tools are there when the chat's CLI lists embarch-api, else when its binary is on PATH", () => {
  assert.equal(core.embarchApiPresent([{ name: "embarch-api", status: "connected" }], () => false), true);
  assert.equal(core.embarchApiPresent([{ name: "embarch-api", status: "failed" }], () => true), false, "the CLI's word wins");
  assert.equal(core.embarchApiPresent([{ name: "other", status: "connected" }], () => true), false);
  assert.equal(core.embarchApiPresent(null, () => true), true, "before the CLI starts: the binary");
  assert.equal(core.embarchApiPresent(undefined, () => false), false);
});

test("Start work's rough prompt is `Work on KEY — title`, the title on one line; a draft with a footer went through Promptu already", () => {
  assert.equal(core.startRough("ABC-7", "Loader retries\n after  a reset", "w9"), "Work on ABC-7 — Loader retries after a reset");
  assert.equal(core.startRough("ABC-7", "", "w9"), "Work on ABC-7");
  assert.equal(core.startRough(undefined, undefined, "ABC-7 Loader"), "Work on ABC-7 Loader");
  assert.equal(core.hasFooter("## Goal\nx\n\n— promptu implement-issue@1 asked=done:rec\n"), true);
  assert.equal(core.hasFooter("— promptu none"), true);
  assert.equal(core.hasFooter("say — promptu x"), false);
  assert.equal(core.hasFooter(""), false);
});

// ------------------------------------------------------------ the real CLI, when there is a build of it

const REAL = process.env.PROMPTU_BIN;
test("the real promptu: an offline pass, a page answered, the prompt rendered — scratch folders only", { skip: REAL && fs.existsSync(REAL) ? false : "PROMPTU_BIN not set" }, async () => {
  const d = scratch();
  for (const f of ["claude", "cfg", "state", "repo"]) fs.mkdirSync(path.join(d, f), { recursive: true });
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(d, "claude"),
    PROMPTU_CONFIG_DIR: path.join(d, "cfg"),
    PROMPTU_STATE_DIR: path.join(d, "state"),
    PROMPTU_TODAY: "2026-10-30",
    PROMPTU_CLAUDE: "/nonexistent/claude",
  };
  const lines = [];
  const cli = new core.PromptuCli(() => ({ bin: REAL, log: (l) => lines.push(l), env }));
  const pats = await cli.patterns(path.join(d, "repo"));
  assert.ok(pats.ok && pats.value.some((p) => p.name === "implement-issue" && p.desk === "default"), JSON.stringify(pats));
  const runs = new core.PromptuRuns(cli, () => {});
  await runs.begin(SID, { rough: "Work on ABC-7 — Loader retries after a reset", origin: "start", start: true, have: ["desk"], quick: false, cwd: path.join(d, "repo"), desk: { key: "ABC-7", title: "Loader retries after a reset", id: "w9", url: "https://linear.app/x/issue/ABC-7", text: "Retry three times." } });
  let v = runs.view(SID);
  assert.ok(v, lines.join("\n"));
  assert.equal(v.step.offline, true);
  assert.equal(v.step.start, true);
  assert.equal(v.step.pattern.id, "implement-issue", "Start work's default");
  if (v.step.choose) {
    await runs.answer(SID, v.seq, core.cleanInput({ pattern: "implement-issue (Recommended)" }));
    v = runs.view(SID);
  }
  const page = v.step.pages[0];
  const answers = {};
  page.questions.forEach((q, i) => {
    const rec = q.options.find((o) => o.label.endsWith(" (Recommended)"));
    answers[page.ids[i]] = rec ? rec.label : { other: "so field units recover" };
  });
  await runs.finish(SID, v.seq, core.cleanInput({ answers }), "assume");
  const r = runs.take(SID);
  assert.ok(r.prompt, JSON.stringify(r));
  assert.match(r.prompt, /^## Goal\nWork on ABC-7 — Loader retries after a reset/);
  assert.match(r.prompt, /\n— promptu implement-issue@\d+ /);
  assert.ok(core.hasFooter(r.prompt));
});
