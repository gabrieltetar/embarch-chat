// The Haiku assistant (decisions/assistant.md in embarch-doc/embarch-chat) and the library
// (decisions 7, 13, 38): the pure edits and the instant wave,
// real recorded Haiku calls replayed by fake-claude.mjs, the owner's prompt
// history on synthetic transcripts (never the owner's own), and the plugin's
// entries.

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
const root = path.dirname(here);
const FAKE = path.join(here, "fake-claude.mjs");
fs.chmodSync(FAKE, 0o755);

// Every scratch folder of this run, under one root removed at the end.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-assist-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const scratch = () => fs.mkdtempSync(path.join(ROOT, "s-"));
const recorded = (name) =>
  fs
    .readFileSync(path.join(here, "fixtures", "haiku", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const answer = (name) => recorded(name).find((e) => e.o.type === "result").o.result;

const INPUT = {
  draft: "",
  lastReply: "The widget driver now builds.",
  item: { key: "ABC-123", title: "Make the widget blink", state: "In Progress", prs: ["PR #42 open"] },
  library: ["embarch-chat:build-flash-verify"],
  context: { percentage: 34, totalTokens: 68000, maxTokens: 200000 },
};

function assistant(over = {}) {
  const dir = scratch();
  const argsLog = path.join(dir, "args.jsonl");
  const lines = [];
  const a = new core.HaikuAssistant(() => ({
    claudePath: FAKE,
    enabled: true,
    log: (l) => lines.push(l),
    env: { ...core.haikuEnv(), FAKE_CLAUDE_ARGS_LOG: argsLog, ...over },
  }));
  const calls = () => (fs.existsSync(argsLog) ? fs.readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { a, calls, lines };
}

// ------------------------------------------------------------ edits (37, 36)

test("a card's edit applies to the draft, or not at all once its text is gone", () => {
  assert.equal(core.applyEdit("fix the build", { op: "append", text: "on the dev board" }), "fix the build on the dev board");
  assert.equal(core.applyEdit("fix the build ", { op: "append", text: "\n\nThen flash it." }), "fix the build\n\nThen flash it.");
  assert.equal(core.applyEdit("fix the build", { op: "prepend", text: "/compact focus on: the build\n" }), "/compact focus on: the build\nfix the build");
  assert.equal(core.applyEdit("fix the build", { op: "replace", find: "the build", with: "the UART build" }), "fix the UART build");
  assert.equal(core.applyEdit("fix it", { op: "replace", find: "the build", with: "x" }), null, "stale: its text is gone");
  assert.equal(core.applyEdit("fix the build on the dev board", { op: "append", text: "on the dev board" }), null, "already there");
  const h = core.applyEdit("now the release notes", { op: "handoff" });
  assert.match(h, /^Write a handoff for a fresh chat/);
  assert.match(h, /What the fresh chat should do next: now the release notes$/);
  assert.equal(core.applyEdit(h, { op: "handoff" }), null, "a handoff request is not wrapped twice");
});

test("a replace edit puts its text in as written, at the first whole word it names (37, 88)", () => {
  // A PR title with `$` in it: String.replace would read `$'`, `$&`, `` $` `` and `$$` as its own patterns.
  const title = 'PR owner/repo#36 "Cost $\' $& $` $$ cut"';
  assert.equal(core.applyEdit("do as the widget PR did", { op: "replace", find: "the widget PR", with: title }), `do as ${title} did`);
  // "the PR" inside "the PRs list" is not the phrase: the first whole one is, else the first at all.
  assert.equal(core.applyEdit("check the PRs list, then the PR", { op: "replace", find: "the PR", with: "PR #36" }), "check the PRs list, then PR #36");
  assert.equal(core.applyEdit("check the PRs list", { op: "replace", find: "the PR", with: "PR #36" }), "check PR #36s list", "no whole one: the first");
  assert.equal(core.applyEdit("rethe PR and the PR", { op: "replace", find: "the PR", with: "X" }), "rethe PR and X");
  assert.equal(core.applyEdit("see (the PR) now", { op: "replace", find: "(the PR)", with: "X" }), "see X now", "punctuation at its ends is its own edge");
  // A combining mark is part of its word: "cafe" is not the start of "café" written as e + U+0301.
  assert.equal(core.applyEdit("the cafe\u0301 menu, then the cafe", { op: "replace", find: "cafe", with: "X" }), "the cafe\u0301 menu, then the X");
  assert.equal(core.applyEdit("the cafe\u0301s and the cafe\u0301", { op: "replace", find: "cafe\u0301", with: "X" }), "the cafe\u0301s and the X", "a phrase that ends in a mark");
  // An astral letter is a letter, read as one code point, not two halves: at either end of the draft's match or the phrase.
  assert.equal(core.applyEdit("\u{1D400}bc then bc", { op: "replace", find: "bc", with: "X" }), "\u{1D400}bc then X");
  assert.equal(core.applyEdit("bc\u{1D400} then bc", { op: "replace", find: "bc", with: "X" }), "bc\u{1D400} then X");
  assert.equal(core.applyEdit("x\u{1D400}b, \u{1D400}b", { op: "replace", find: "\u{1D400}b", with: "X" }), "x\u{1D400}b, X", "a phrase that starts with one");
  assert.equal(core.applyEdit("b\u{1D400}x, b\u{1D400}", { op: "replace", find: "b\u{1D400}", with: "X" }), "b\u{1D400}x, X", "a phrase that ends with one");
});

test("the preview is a word diff: added words, removed words, the rest as is", () => {
  const d = core.wordDiff("fix the flash thing", "fix the flash driver on the board");
  assert.deepEqual(
    d.map((p) => [p.t, p.s]),
    [
      ["same", "fix the flash "],
      ["del", "thing"],
      ["add", "driver on the board"],
    ],
  );
  assert.equal(d.filter((p) => p.t !== "del").map((p) => p.s).join(""), "fix the flash driver on the board");
  assert.equal(d.filter((p) => p.t !== "add").map((p) => p.s).join(""), "fix the flash thing");
  assert.deepEqual(core.wordDiff("same", "same"), [{ t: "same", s: "same" }]);
});

test("the compact card's draft splits into its /compact line and the rest", () => {
  assert.deepEqual(core.splitCompact("/compact focus on: the UART driver\nadd a ring buffer"), { compact: "/compact focus on: the UART driver", rest: "add a ring buffer" });
  assert.equal(core.splitCompact("/compact focus on: x"), null, "a bare /compact is one message");
  assert.equal(core.splitCompact("please /compact\nthen"), null);
  assert.equal(core.compactLine("  the UART\n driver "), "/compact focus on: the UART driver");
});

test("a handoff is the fenced block when there is one, else the whole reply", () => {
  assert.equal(core.extractHandoff("Here it is:\n\n```handoff\n# Goal\nShip it.\n```\n\nDone."), "# Goal\nShip it.");
  assert.equal(core.extractHandoff("  just text  "), "just text");
});

// ------------------------------------------------------------ the instant wave (26)

test("the prefix match takes the owner's most-sent prompt that starts with the draft", () => {
  const prompts = [
    { text: "continue with the next step", n: 2, lastMs: 10 },
    { text: "continue", n: 15, lastMs: 5 },
    { text: "commit it", n: 7, lastMs: 20 },
    { text: "check the log\nand the build", n: 9, lastMs: 1 },
  ];
  assert.equal(core.prefixMatch(prompts, "con"), "tinue");
  assert.equal(core.prefixMatch(prompts, "Continue "), "with the next step", "case aside");
  assert.equal(core.prefixMatch(prompts, "co"), "ntinue");
  assert.equal(core.prefixMatch(prompts, "ch"), "eck the log", "to the end of its line");
  assert.equal(core.prefixMatch(prompts, "continue"), " with the next step");
  assert.equal(core.prefixMatch(prompts, "zz"), null);
  assert.equal(core.prefixMatch(prompts, ""), null);
});

test("typing through the ghost text keeps the rest of it", () => {
  assert.equal(core.ghostRest("cont", "con", "tinue"), "inue");
  assert.equal(core.ghostRest("continue", "con", "tinue"), null, "all taken");
  assert.equal(core.ghostRest("conx", "con", "tinue"), null, "typed past it");
  assert.equal(core.ghostRest("co", "con", "tinue"), null, "deleted back");
});

// ------------------------------------------------------------ reading Haiku's answers

test("the recorded ghost call streams a completion that grows to the final one", () => {
  let text = "";
  const seen = [];
  for (const e of recorded("ghost")) {
    const d = e.o.event?.delta;
    if (e.d !== "out" || d?.type !== "text_delta") continue;
    text += d.text;
    const p = core.partialCompletion(text);
    if (p !== null && p !== seen.at(-1)) seen.push(p);
  }
  assert.ok(seen.length >= 3, `streamed in steps: ${JSON.stringify(seen)}`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].startsWith(seen[i - 1]));
  assert.equal(seen.at(-1), core.parseObject(answer("ghost")).completion);
  assert.equal(core.cleanCompletion("now flash it on the", seen.at(-1)), seen.at(-1));
  assert.equal(core.cleanCompletion("fix it ", " now"), "now", "no double space");
  assert.equal(core.cleanCompletion("fix it", "fix it now"), " now", "never a repeat of the draft");
});

test("the recorded cards parse into edits that apply to their draft", () => {
  const cards = core.parseCards(core.parseObject(answer("cards")), "fix the flash thing", "t");
  assert.ok(cards.length >= 1);
  for (const c of cards) {
    assert.ok(["missing", "improve"].includes(c.category));
    assert.ok(core.applyEdit("fix the flash thing", c.edit) !== null);
  }
  const ctx = core.parseCards(core.parseObject(answer("cards-context")), "now write the release notes for the whole quarter", "t");
  assert.deepEqual(ctx.find((c) => c.category === "context")?.edit, { op: "handoff" });
  const draft = "the widget is done. next, move on to the UART driver: add a ring buffer for RX and a test for it";
  const compact = core.parseCards(core.parseObject(answer("cards-compact")), draft, "t").find((c) => c.kind === "compact");
  assert.ok(compact);
  assert.match(core.applyEdit(draft, compact.edit), /^\/compact focus on: .+\nthe widget is done/);
  assert.deepEqual(core.parseCards({ cards: [{ category: "missing", title: "x", edit: { op: "replace", find: "absent", with: "y" } }, { category: "bogus", title: "y" }] }, "draft", "t"), []);
});

test("the recorded turn gives chips and a name", () => {
  const t = core.parseTurn(core.parseObject(answer("turn")));
  assert.ok(t.chips.length >= 2 && t.chips.length <= 4, JSON.stringify(t.chips));
  assert.ok(t.name && t.name.split(/\s+/).length <= 8, t.name);
  assert.deepEqual(core.parseTurn({ chips: ["Done", "done", "", 3, "go", "a", "b", "c"] }).chips, ["Done", "go", "a", "b"]);
});

test("the prompts carry what the assistant sees (27), and the draft only where it judges one", () => {
  const i = { ...INPUT, draft: "now flash it on the", lastReply: "x".repeat(9000) };
  const g = core.ghostPrompt(i);
  assert.match(g, /^TASK: ghost/);
  for (const s of ["ABC-123 Make the widget blink · In Progress · PR #42 open", "34% of 200K", "/embarch-chat:build-flash-verify", "<draft>now flash it on the</draft>"]) assert.ok(g.includes(s), s);
  assert.ok(g.length < 6000, "the last reply is capped");
  assert.match(core.cardsPrompt(i), /^TASK: cards/);
  const t = core.turnPrompt({ ...i, cliSuggestion: "go ahead" }, { chips: true, name: false });
  assert.ok(!t.includes("<draft>") && t.includes('"go ahead"') && !t.includes('"name"'));
  assert.ok(core.contextBlock({ ...INPUT, item: null }).includes("untracked"));
});

// ------------------------------------------------------------ one call (26)

test("each Haiku call is one stripped, unsaved, streamed claude -p with thinking off, the prompt on stdin", async () => {
  const { a, calls } = assistant();
  const partials = [];
  const got = await a.ghost("s1", { ...INPUT, draft: "now flash it on the" }, (t) => partials.push(t));
  assert.equal(got, core.parseObject(answer("ghost")).completion);
  assert.ok(partials.length >= 2 && partials.at(-1) === got, "streamed");
  const c = calls()[0];
  const v = (f) => c.argv[c.argv.indexOf(f) + 1];
  assert.ok(c.argv.includes("-p"));
  assert.equal(v("--model"), "haiku");
  assert.equal(v("--max-thinking-tokens"), "0");
  assert.equal(v("--tools"), "");
  assert.equal(v("--setting-sources"), "");
  assert.equal(v("--output-format"), "stream-json");
  for (const f of ["--no-session-persistence", "--include-partial-messages", "--strict-mcp-config"]) assert.ok(c.argv.includes(f), f);
  assert.ok(!c.argv.some((x) => x.includes("now flash it on the")), "not on the command line");
  assert.ok(c.prompt.includes("<draft>now flash it on the</draft>"), "on stdin");
  assert.equal(c.env.EMBARCH_DESK_INTERNAL, "1", "the desk keeps out");
  // A neutral folder of its own: empty, the owner's only, not the shared temp folder.
  assert.notEqual(fs.realpathSync(c.cwd), fs.realpathSync(os.tmpdir()));
  assert.equal(fs.realpathSync(path.dirname(c.cwd)), fs.realpathSync(os.tmpdir()));
  assert.equal(fs.statSync(c.cwd).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(c.cwd), []);
  a.dispose();
  assert.ok(!fs.existsSync(c.cwd), "removed with the window");
});

test("the next keystroke cancels a stale call", async () => {
  const { a, lines } = assistant({ FAKE_HAIKU_DELAY_MS: "40" });
  const p = a.ghost("s1", { ...INPUT, draft: "now flash" }, () => {});
  await new Promise((r) => setTimeout(r, 120));
  a.cancel("s1");
  assert.equal(await p, null);
  assert.ok(lines.some((l) => /haiku ghost #\d+: cancelled/.test(l)), lines.join("\n"));
  a.dispose();
  // A new call for the same chat cancels the one before it.
  const { a: b } = assistant();
  const first = b.cards("s1", { ...INPUT, draft: "fix the flash thing" });
  const second = b.cards("s1", { ...INPUT, draft: "fix the flash thing" });
  assert.equal(await first, null);
  assert.ok((await second).length >= 1);
  b.dispose();
});

test("off, the assistant makes no call", async () => {
  const a = new core.HaikuAssistant(() => ({ claudePath: "/nonexistent", enabled: false, log: () => {} }));
  assert.equal(await a.ghost("s", { ...INPUT, draft: "x" }, () => {}), null);
  assert.equal(await a.cards("s", { ...INPUT, draft: "x" }), null);
});

// ------------------------------------------------------------ chips and names (25, 12, 34)

test("after a turn on screen: chips with the CLI's own guess among them, and a name after the first", async () => {
  const { a, calls } = assistant();
  const named = [];
  const emitted = [];
  a.on("chips", (sid, chips) => emitted.push(chips));
  a.suggestion("s1", "flash it");
  await a.turnEnded("s1", () => INPUT, { onScreen: true, firstTurn: true, rename: async (n) => named.push(n) });
  const chips = a.chipsFor("s1");
  assert.equal(chips[0].text, "flash it");
  assert.equal(chips[0].source, "cli");
  assert.ok(chips.length >= 3 && chips.length <= 4, JSON.stringify(chips));
  assert.equal(new Set(chips.map((c) => c.text.toLowerCase())).size, chips.length, "no repeats");
  assert.deepEqual(named, [core.parseTurn(core.parseObject(answer("turn"))).name]);
  assert.equal(calls()[0].task, "turn");
  // The next turn: chips again, no second name.
  await a.turnEnded("s1", () => INPUT, { onScreen: true, firstTurn: false, rename: async (n) => named.push(n) });
  assert.equal(named.length, 1);
  assert.ok(!calls()[1].prompt.includes('"name"'));
  a.sent("s1");
  assert.deepEqual(a.chipsFor("s1"), [], "spent by the next message");
  assert.deepEqual(emitted.at(-1), []);
  a.dispose();
});

test("the owner's reply right after the first turn does not cost the chat its name (12)", async () => {
  const { a, lines } = assistant({ FAKE_HAIKU_DELAY_MS: "40" });
  const named = [];
  const p = a.turnEnded("s3", () => INPUT, { onScreen: true, firstTurn: true, rename: async (n) => named.push(n) });
  await new Promise((r) => setTimeout(r, 150));
  // The CLI's own chip is up at once; the owner clicks it.
  a.suggestion("s3", "go ahead");
  a.sent("s3");
  await p;
  assert.deepEqual(named, [core.parseTurn(core.parseObject(answer("turn"))).name], lines.join("\n"));
  assert.deepEqual(a.chipsFor("s3"), [], "its chips were spent by the reply");
  a.dispose();
});

test("a name that did not come back is asked again after the next turn", async () => {
  const env = { FAKE_HAIKU_TURN: "/nonexistent/recording.jsonl" };
  const dir = scratch();
  const a = new core.HaikuAssistant(() => ({ claudePath: FAKE, enabled: true, log: () => {}, env: { ...core.haikuEnv(), FAKE_CLAUDE_ARGS_LOG: path.join(dir, "args.jsonl"), ...env } }));
  const named = [];
  await a.turnEnded("s4", () => INPUT, { onScreen: false, firstTurn: true, rename: async (n) => named.push(n) });
  assert.deepEqual(named, [], "the call failed");
  delete env.FAKE_HAIKU_TURN;
  await a.turnEnded("s4", () => INPUT, { onScreen: false, firstTurn: false, rename: async (n) => named.push(n) });
  assert.equal(named.length, 1, "named on the next turn");
  await a.turnEnded("s4", () => INPUT, { onScreen: false, firstTurn: false, rename: async (n) => named.push(n) });
  assert.equal(named.length, 1, "once");
  a.dispose();
});

test("off screen: the name only; the chips wait until the chat is opened (34)", async () => {
  const { a, calls } = assistant();
  const named = [];
  await a.turnEnded("s2", () => INPUT, { onScreen: false, firstTurn: true, rename: async (n) => named.push(n) });
  assert.equal(named.length, 1);
  assert.ok(!calls()[0].prompt.includes('"chips"'), "no chips asked");
  assert.deepEqual(a.chipsFor("s2"), []);
  await a.shown("s2", () => INPUT);
  assert.ok(a.chipsFor("s2").length >= 2);
  await a.shown("s2", () => INPUT);
  assert.equal(calls().length, 2, "once");
  // A later off-screen turn of a named chat makes no call at all.
  await a.turnEnded("s2", () => INPUT, { onScreen: false, firstTurn: false, rename: async () => {} });
  assert.equal(calls().length, 2);
  a.dispose();
});

// ------------------------------------------------------------ the handoff and compact sequences, on recorded sessions

function makeChat(name, dir) {
  const inputs = path.join(dir, "inputs.jsonl");
  const chat = new core.Chat({
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: dir,
    claudePath: FAKE,
    existing: false,
    idleMs: 60000,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: path.join(here, "fixtures", "wire", `${name}.jsonl`), FAKE_CLAUDE_INPUT_LOG: inputs },
  });
  const read = () => fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { chat, inputs: read };
}
const nextTurn = (chat) => new Promise((r) => chat.once("turn", (o, n) => r(n)));
/** How many lines the recorded compact session writes up to the end of its compaction. */
const compactionEnd = () => {
  const outs = fs
    .readFileSync(path.join(here, "fixtures", "wire", "compact.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.d === "out");
  const b = outs.findIndex((e) => e.o.subtype === "compact_boundary");
  return outs.findIndex((e, i) => i > b && e.o.type === "result") + 1;
};

test("the compact card's draft: its /compact line, the compaction finished, then the rest (36)", async () => {
  const { chat, inputs } = makeChat("compact", scratch());
  chat.send("@note.txt what is the secret? One word.");
  assert.equal(await nextTurn(chat), 1);
  const split = core.splitCompact("/compact focus on: the secret word in note.txt\nWhat was the secret word? One word.");
  chat.sendAfterCompact(split.compact, split.rest);
  const held = Object.values(chat.state.entries).find((e) => e.kind === "user" && e.held);
  assert.equal(held.text, "What was the secret word? One word.");
  assert.ok(held.pending, "shown at once, waiting");
  assert.equal(await nextTurn(chat), 2, "the compaction is not a turn of its own");
  const users = inputs().filter((x) => x.o.type === "user");
  assert.deepEqual(users.map((x) => x.o.message.content), ["@note.txt what is the secret? One word.", split.compact, split.rest]);
  assert.ok(users[2].written >= compactionEnd(), "the rest went only after the compaction ended");
  const s = chat.state;
  assert.ok(Object.values(s.entries).some((e) => e.kind === "note" && e.tone === "compact"));
  assert.equal(s.entries[held.id].pending, false, "echoed back");
  assert.equal(s.entries[s.timeline.at(-1)].text, "MANGO");
  chat.dispose();
});

test("a compact draft queued while a turn runs waits for its own compaction, not that turn's end", async () => {
  const { chat, inputs } = makeChat("compact", scratch());
  chat.send("@note.txt what is the secret? One word.");
  chat.sendAfterCompact("/compact focus on: the secret word in note.txt", "What was the secret word? One word.");
  assert.equal(await nextTurn(chat), 1, "the running turn ends as a turn");
  assert.equal(await nextTurn(chat), 2);
  const users = inputs().filter((x) => x.o.type === "user");
  assert.equal(users.length, 3);
  assert.ok(users[2].written >= compactionEnd(), "the rest went after the compaction ended, not after the first turn");
  const results = chat.state.timeline.map((id) => chat.state.entries[id]).filter((e) => e.kind === "note" && e.tone === "compact");
  assert.equal(results.length, 1);
  chat.dispose();
});

test("a turn that wrote a handoff offers a fresh chat with it (36)", async () => {
  const { a } = assistant();
  const { chat } = makeChat("handoff", scratch());
  const sid = chat.sessionId;
  const turn = (onScreen) => a.turnEnded(sid, () => ({ ...INPUT, lastReply: core.lastReply(chat.state) }), { onScreen, firstTurn: false, rename: async () => {} });
  chat.send("Read note.txt and tell me the secret in one word.");
  await nextTurn(chat);
  await turn(true);
  assert.ok(!a.chipsFor(sid).some((c) => c.action === "freshChat"));
  a.sent(sid, { handoff: true });
  chat.send(core.handoffRequest("Next: write the secret into a file named answer.txt."));
  await nextTurn(chat);
  await turn(true);
  const chips = a.chipsFor(sid);
  assert.deepEqual(chips[0], { text: "Fresh chat with this handoff", source: "handoff", action: "freshChat" });
  const h = a.handoffFor(sid);
  assert.match(h, /^# Handoff/);
  assert.ok(!h.includes("```"), "the block alone");
  assert.match(h, /MANGO/);
  a.sent(sid);
  assert.equal(a.handoffFor(sid), null);
  chat.dispose();
  a.dispose();
});

test("the CLI's own guess arrives after the turn, from --prompt-suggestions (25)", async () => {
  const { chat } = makeChat("suggest", scratch());
  const got = [];
  chat.on("suggestion", (s) => got.push(s));
  chat.send("I am setting up a small Node project in this folder. Run `echo setup` with bash, then suggest what I should do first, in two sentences.");
  await nextTurn(chat);
  const t0 = Date.now();
  while (!got.length && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, ["npm init -y"]);
  assert.ok(!chat.state.timeline.some((id) => chat.state.entries[id].text === "npm init -y"), "not a message");
  chat.dispose();
});

// ------------------------------------------------------------ the owner's prompts (26)

const line = (o) => JSON.stringify({ type: "user", timestamp: new Date().toISOString(), ...o });

test("only what the owner typed counts as a past prompt", () => {
  const hp = (o) => core.humanPrompt(JSON.parse(line(o)));
  assert.equal(hp({ origin: { kind: "human" }, message: { content: "flash it" } }), "flash it");
  assert.equal(hp({ origin: { kind: "human" }, message: { content: [{ type: "text", text: "<ide_selection>x</ide_selection>" }, { type: "text", text: "explain this" }] } }), "explain this");
  assert.equal(hp({ origin: { kind: "human" }, message: { content: "<command-name>/review</command-name><command-args>ABC-123</command-args>" } }), "/review ABC-123");
  assert.equal(hp({ message: { content: "an older transcript's prompt" } }), "an older transcript's prompt");
  assert.equal(hp({ origin: { kind: "task-notification" }, message: { content: "a task finished" } }), null);
  assert.equal(hp({ origin: { kind: "human" }, isMeta: true, message: { content: "meta" } }), null);
  assert.equal(hp({ origin: { kind: "human" }, isSidechain: true, message: { content: "subagent" } }), null);
  assert.equal(hp({ message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } }), null);
  assert.equal(hp({ turnOrigin: "sdk", message: { content: "a program's" } }), null);
  assert.equal(hp({ origin: { kind: "human" }, message: { content: "[Request interrupted by user]" } }), null);
  assert.equal(hp({ origin: { kind: "human" }, message: { content: "x".repeat(500) } }), null, "a paste is not a prompt to complete");
});

test("the history reads transcripts of the last 30 days, counts repeats, and reads only what is new", async () => {
  const dir = scratch();
  const proj = path.join(dir, "-work-a");
  fs.mkdirSync(proj);
  const t1 = path.join(proj, "11111111-0000-4000-8000-000000000001.jsonl");
  const human = (text) => line({ origin: { kind: "human" }, message: { role: "user", content: text } });
  fs.writeFileSync(t1, [human("continue"), line({ message: { content: [{ type: "tool_result", tool_use_id: "x", content: "continue" }] } }), human("continue"), human("check the log")].join("\n") + "\n");
  const old = path.join(proj, "11111111-0000-4000-8000-000000000002.jsonl");
  fs.writeFileSync(old, human("ancient") + "\n");
  const longAgo = (Date.now() - 40 * 86_400_000) / 1000;
  fs.utimesSync(old, longAgo, longAgo);
  fs.mkdirSync(path.join(proj, "sub"));
  fs.writeFileSync(path.join(proj, "sub", "nested.jsonl"), human("a subagent's") + "\n");
  const h = new core.PromptHistory(dir);
  await h.refresh();
  assert.deepEqual(
    h.prompts().map((p) => [p.text, p.n]),
    [
      ["continue", 2],
      ["check the log", 1],
    ],
  );
  const v = h.version;
  // An unfinished line waits for its end.
  fs.appendFileSync(t1, human("push").slice(0, 30));
  await h.refresh();
  assert.equal(h.prompts().length, 2);
  assert.equal(h.version, v, "nothing new");
  fs.appendFileSync(t1, human("push").slice(30) + "\n" + human("continue") + "\n");
  await h.refresh();
  assert.deepEqual(Object.fromEntries(h.prompts().map((p) => [p.text, p.n])), { continue: 3, "check the log": 1, push: 1 });
  assert.equal(h.prompts()[0].text, "continue", "most-sent first");
  assert.equal(h.version, v + 1);
});

// ------------------------------------------------------------ the library (7, 13, 38, 39)

test("the plugin holds the decided entries, each with its category", () => {
  const entries = core.pluginEntries(path.join(root, "plugin"));
  assert.deepEqual(
    entries.map((e) => [e.name, e.kind, e.category, e.plugin]).sort(),
    [
      ["build-flash-verify", "skill", "Bench", "embarch-chat"],
      ["embarch-claude-md", "command", "Repo setup", "embarch-chat"],
      ["embarch-permissions", "command", "Repo setup", "embarch-chat"],
    ],
  );
  for (const e of entries) assert.ok(e.description && e.description.length > 20, e.name);
  const mk = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(mk.plugins[0].source, "./plugin");
  assert.equal(mk.plugins[0].name, entries[0].plugin);
});

test("the library: the plugin's entries and the owner's commands, by category, Other last", () => {
  const user = scratch();
  fs.mkdirSync(path.join(user, "client"));
  fs.writeFileSync(path.join(user, "notes.md"), "Just a prompt, no frontmatter.\n");
  fs.writeFileSync(path.join(user, "client", "release.md"), '---\ndescription: "Cut a release"\ncategory: Git\n---\nbody\n');
  fs.writeFileSync(path.join(user, "embarch-permissions.md"), "---\ncategory: Mine\n---\nthe owner's own\n");
  const lib = core.readLibrary(path.join(root, "plugin"), user);
  const by = core.byCategory(lib);
  assert.deepEqual(
    by.map((g) => [g.category, g.entries.map((e) => e.name)]),
    [
      ["Bench", ["build-flash-verify"]],
      ["Git", ["release"]],
      ["Mine", ["embarch-permissions"]],
      ["Repo setup", ["embarch-claude-md"]],
      ["Other", ["notes"]],
    ],
  );
  assert.equal(lib.find((e) => e.name === "embarch-permissions").source, "user", "a name the owner reuses is theirs");
  assert.equal(lib.find((e) => e.name === "release").description, "Cut a release");
});

test("an entry is typed as the session knows it: a plugin's as <plugin>:<name>", () => {
  const e = { name: "embarch-permissions", category: "Repo setup", source: "plugin", plugin: "embarch-chat", kind: "command" };
  const mine = { name: "notes", category: "Other", source: "user", kind: "command" };
  assert.equal(core.invocation(e, []), "embarch-chat:embarch-permissions", "before the session starts");
  assert.equal(core.invocation(e, ["compact", "embarch-chat:embarch-permissions"]), "embarch-chat:embarch-permissions");
  assert.equal(core.invocation(e, ["compact", "embarch-permissions"]), "embarch-permissions");
  assert.equal(core.invocation(e, ["compact"]), null, "the plugin is not installed");
  assert.equal(core.invocation(mine, ["compact", "notes"]), "notes");
  assert.equal(core.frontmatter('---\nname: x\ndescription: "say \\"hi\\""\n---\n').description, 'say "hi"');
});

test("a name given with rename_session wins over Claude's renewed ai-title (12)", () => {
  const text = [
    { type: "ai-title", aiTitle: "Read the issue" },
    { type: "custom-title", customTitle: "Widget blink driver" },
    { type: "ai-title", aiTitle: "Later title" },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");
  const { events, meta } = core.transcriptEvents(text);
  assert.equal(meta.title, "Widget blink driver");
  assert.deepEqual(events.map((e) => e.title), ["Read the issue", "Widget blink driver"]);
});
