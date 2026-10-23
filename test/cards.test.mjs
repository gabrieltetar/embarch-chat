// The cards in the conversation (decisions 76–79) against recorded real
// sessions, replayed by fake-claude.mjs: a compaction's card keeps its
// summary, a plan is approved into auto mode or sent back with comments on
// its lines, an "always allow" goes where the owner picked, and an answered
// question leaves its picks in the timeline.

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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-cards-"));
// A test that fails before its dispose leaves no process behind to hold the run open.
const chats = [];
after(() => {
  for (const c of chats) c.dispose();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function makeChat(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, "chat-"));
  const chat = new core.Chat({
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: dir,
    claudePath: FAKE,
    existing: false,
    idleMs: 60000,
    mode: opts.mode,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture(name), FAKE_CLAUDE_ARGS_LOG: path.join(dir, "args.jsonl"), FAKE_CLAUDE_INPUT_LOG: path.join(dir, "input.jsonl") },
  });
  chats.push(chat);
  // Every line the chat wrote to the CLI, in order.
  const inputs = () => (fs.existsSync(path.join(dir, "input.jsonl")) ? fs.readFileSync(path.join(dir, "input.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).o) : []);
  return { chat, inputs };
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
const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const entries = (s, kind) => Object.values(s.entries).filter((e) => e.kind === kind);
const top = (s) => s.timeline.map((id) => s.entries[id]);

// ---- the compaction's card (decision 76)

test("a compaction is one card, Claude Code's line with the summary inside; /compact's own 'Compacted' adds nothing", async () => {
  const { chat } = makeChat("compact");
  chat.send("@note.txt what is the secret? One word.");
  await turns(chat, 1);
  chat.send("/compact focus on: the secret word in note.txt");
  await turns(chat, 1);
  const cards = entries(chat.state, "note").filter((n) => n.tone === "compact");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].text, "Compacted chat · manual · 1k tokens freed");
  assert.match(cards[0].summary, /^This session is being continued from a previous conversation/);
  assert.match(cards[0].summary, /MANGO/, "the summary kept the fact");
  assert.ok(!entries(chat.state, "note").some((n) => n.tone === "info" && n.text === "Compacted"), "no second line");
  assert.equal(entries(chat.state, "user").filter((u) => u.text.startsWith("This session")).length, 0, "the summary is no message of the owner's");
  chat.dispose();
});

test("a resumed transcript folds its compaction the same way: the boundary's camelCase metadata, the summary flagged isCompactSummary", () => {
  const file = path.join(here, "fixtures", "transcripts", "e116c4c3-e84d-4880-9034-5cfae473abb6.jsonl");
  const { events } = core.readTranscript(file);
  const s = core.reduceAll(core.initialState("e116c4c3-e84d-4880-9034-5cfae473abb6"), events);
  const shown = top(s);
  const card = shown.find((e) => e.kind === "note" && e.tone === "compact");
  assert.equal(card.text, "Compacted chat · manual · 0k tokens freed");
  assert.match(card.summary, /continued from a previous conversation/);
  assert.deepEqual(
    shown.map((e) => (e.kind === "note" ? `note:${e.tone}` : e.kind)),
    ["user", "text", "note:compact", "user"],
    "the /compact itself after its card, and no 'Compacted' line",
  );
  // Folded one line at a time, the same.
  let one = core.initialState("x");
  for (const e of events) one = core.reduce(one, e);
  assert.equal(top(one).find((e) => e.kind === "note").summary, card.summary);
});

test("an auto compaction's card says auto; a synthetic message not after a compaction is still dropped", () => {
  let s = core.initialState("x");
  s = core.reduce(s, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000 } });
  s = core.reduce(s, { type: "user", isSynthetic: true, message: { role: "user", content: "the summary" } });
  s = core.reduce(s, { type: "user", isSynthetic: true, message: { role: "user", content: "a later synthetic line" } });
  const notes = entries(s, "note");
  assert.deepEqual(
    notes.map((n) => [n.text, n.summary]),
    [["Compacted chat · auto · 150k tokens freed", "the summary"]],
  );
  assert.equal(entries(s, "user").length, 0);
});

// ---- the plan card (decision 77)

const PLAN_PROMPT = "Plan how to create hello.txt containing hi, then present the plan for approval with ExitPlanMode. Keep the plan to two lines. After approval, create the file.";
const nextPlan = async (chat) => {
  await waitFor(() => chat.state.pending.some((p) => p.form === "plan"));
  return chat.state.pending.find((p) => p.form === "plan");
};

test("Yes, and use auto mode: the mode is set first, then the plan allowed; the chat stays in auto and the Write asks nothing", async () => {
  const { chat, inputs } = makeChat("planautoon", { mode: "plan" });
  chat.send(PLAN_PROMPT);
  const p = await nextPlan(chat);
  await chat.approvePlan(p, "auto");
  await turns(chat, 1);
  const sent = inputs().filter((o) => o.type === "control_response" || o.request?.subtype === "set_permission_mode");
  assert.deepEqual(
    sent.map((o) => (o.type === "control_request" ? `${o.request.subtype}:${o.request.mode}` : o.response.response.behavior)),
    ["set_permission_mode:auto", "allow"],
  );
  assert.equal(sent[1].response.response.updatedPermissions, undefined, "the mode was set, not passed as a permission");
  assert.equal(chat.state.mode, "auto");
  assert.equal(entries(chat.state, "tool").find((t) => t.name === "Write").status, "done");
  assert.equal(chat.state.pending.length, 0);
  chat.dispose();
});

test("a plan sent back with a comment on its line, in Claude Code's words; the next one approved into auto on a model that refuses it falls back to accept edits", async () => {
  const { chat, inputs } = makeChat("planauto", { mode: "plan" });
  chat.send(PLAN_PROMPT);
  const first = await nextPlan(chat);
  const line = String(first.input.plan).split("\n")[0];
  const comment = { id: "c1", start: 0, end: 0, selectedText: line, comment: "Name the file greeting.txt instead." };
  chat.planComments(first.requestId, [comment]);
  assert.deepEqual(chat.state.pending[0].comments, [comment], "the card has it");
  chat.keepPlanning(chat.state.pending[0], "");
  await waitFor(() => inputs().some((o) => o.type === "control_response"));
  const deny = inputs().find((o) => o.type === "control_response");
  assert.equal(deny.response.response.behavior, "deny");
  assert.equal(deny.response.response.message, `User chose to stay in plan mode and continue planning\n\nComments on the plan:\n[Re: "${line}"] Name the file greeting.txt instead.`);
  assert.equal(deny.response.response.interrupt, undefined, "with a comment, Claude goes on planning");
  await waitFor(() => chat.state.pending.some((p) => p.form === "plan" && p.requestId !== first.requestId));
  const second = chat.state.pending.find((p) => p.form === "plan");
  assert.match(String(second.input.plan), /greeting\.txt/, "Claude took the comment");
  await chat.approvePlan(second, "auto");
  await turns(chat, 1);
  const modes = inputs()
    .filter((o) => o.type === "control_request" && o.request.subtype === "set_permission_mode")
    .map((o) => o.request.mode);
  assert.deepEqual(modes, ["auto", "acceptEdits"]);
  assert.equal(chat.state.mode, "acceptEdits");
  assert.ok(entries(chat.state, "note").some((n) => n.text === "Approved with edits accepted: Cannot set permission mode to auto: auto mode unavailable for this model."));
  assert.equal(entries(chat.state, "tool").filter((t) => t.name === "Write" && /greeting\.txt$/.test(String(t.input.file_path)))[0].status, "done");
  chat.dispose();
});

test("Yes, and manually approve edits: ask mode, the plan allowed with the CLI's own setMode, and the Write that follows asks", async () => {
  const { chat, inputs } = makeChat("planmanual", { mode: "plan" });
  chat.send(PLAN_PROMPT);
  const p = await nextPlan(chat);
  await chat.approvePlan(p, "default");
  await waitFor(() => chat.state.pending.some((x) => x.toolName === "Write"));
  assert.equal(chat.state.mode, "default");
  await waitFor(() => inputs().some((o) => o.type === "control_response"));
  const allow = inputs().find((o) => o.type === "control_response");
  assert.deepEqual(allow.response.response.updatedPermissions, [{ type: "setMode", mode: "default", destination: "session" }]);
  chat.allow(chat.state.pending[0]);
  await turns(chat, 1);
  chat.dispose();
});

test("keep planning's words: typed text after the rejection's own, comments listed, and with neither the turn stops", () => {
  assert.deepEqual(core.planFeedback("", []), { message: core.KEEP_PLANNING, interrupt: true });
  assert.deepEqual(core.planFeedback("  use the DK board ", []), { message: core.REJECTED_BECAUSE + "use the DK board", interrupt: false });
  const c = [
    { id: "a", start: 0, end: 0, selectedText: "1. Flash", comment: "build first" },
    { id: "b", start: 2, end: 3, selectedText: "3. Run\n4. Read", comment: "on COM17" },
  ];
  assert.equal(core.planFeedback("wait", c).message, `${core.REJECTED_BECAUSE}wait\n\nComments on the plan:\n[Re: "1. Flash"] build first\n[Re: "3. Run\n4. Read"] on COM17`);
});

// ---- where an "always allow" goes (decision 78)

test("Always allow saves the rule where the owner picked, and to this session; the same command then asks nothing", async () => {
  const { chat, inputs } = makeChat("permdest");
  chat.send("Run the bash command `node -e 1+1` and then reply with just: done");
  await waitFor(() => chat.state.pending.length === 1);
  const p = chat.state.pending[0];
  assert.deepEqual(p.suggestions.map((x) => [x.type, x.destination]), [["addRules", "localSettings"]]);
  chat.allow(p, { destination: "projectSettings" });
  await turns(chat, 1);
  const allow = inputs().find((o) => o.type === "control_response").response.response;
  assert.deepEqual(allow.updatedPermissions.map((x) => [x.type, x.rules[0].ruleContent, x.destination]), [
    ["addRules", "node -e 1+1", "projectSettings"],
    ["addRules", "node -e 1+1", "session"],
  ]);
  assert.equal(chat.state.mode, "default", "nothing else came with it");
  chat.send("Run the bash command `node -e 1+1` once more and then reply with just: done");
  await turns(chat, 1);
  assert.equal(chat.state.pending.length, 0, "the rule answered in this session");
  assert.ok(entries(chat.state, "tool").filter((t) => t.name === "Bash").every((t) => t.status === "done"));
  chat.dispose();
});

test("the suggestions as the card lists them, where it starts, and what the owner's picks send", () => {
  const s = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch marker.txt" }], behavior: "allow", destination: "localSettings" },
    { type: "addDirectories", directories: ["/work/rec/permdest"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ];
  assert.deepEqual(
    s.map(core.grantOf).map((g) => [g.text, g.placed]),
    [
      ["Bash(touch marker.txt)", true],
      ["access to permdest/", true],
      ["accept edits for this session", false],
    ],
  );
  assert.equal(core.grantOf({ type: "addRules", rules: [{ toolName: "mcp__embarch-api__flash" }] }).text, "mcp__embarch-api__flash");
  assert.equal(core.defaultDestination(s, undefined), "localSettings", "the most lasting place the CLI named");
  assert.equal(core.defaultDestination(s, "userSettings"), "userSettings", "the owner's last pick");
  assert.equal(core.defaultDestination(s, "../../etc"), "localSettings", "never a place outside Claude Code's four");
  assert.equal(core.defaultDestination([s[2]], undefined), "session");
  assert.deepEqual(core.alwaysPermissions(s, [0], "userSettings"), [
    { ...s[0], destination: "userSettings" },
    { ...s[0], destination: "session" },
  ], "saved, and given to this session");
  assert.deepEqual(core.alwaysPermissions(s, [1], "session"), [{ ...s[1], destination: "session" }]);
  assert.deepEqual(core.alwaysPermissions(s, [2], "userSettings"), [s[2]], "a mode change keeps the CLI's place");
  assert.deepEqual(core.alwaysPermissions(s, [], "userSettings"), []);
  assert.deepEqual(core.alwaysPermissions(s, undefined, undefined), s, "as the CLI suggested");
});

// ---- the question's row (decision 79)

test("an answered question keeps its picks — two of a multi-select, and Other with a line break — from the CLI's own record and from its result text", async () => {
  const { chat, inputs } = makeChat("questionmulti");
  chat.send("Use the AskUserQuestion tool once, with two questions: which fruits I like (multiSelect true; options apple, pear, plum) and which board to use (options DK, EVK). Then tell me in one line what I picked.");
  await waitFor(() => chat.state.pending.length === 1);
  const p = chat.state.pending[0];
  const [q1, q2] = core.questionsOf(p.input);
  const answers = { [q1.question]: "Apple, Pear", [q2.question]: "P0.13 LED1\nP0.14 LED2" };
  chat.answerQuestion(p, answers);
  await turns(chat, 1);
  assert.deepEqual(inputs().find((o) => o.type === "control_response").response.response.updatedInput.answers, answers, "the line break went as typed");
  const t = entries(chat.state, "tool").find((x) => x.name === "AskUserQuestion");
  assert.equal(t.status, "done");
  assert.deepEqual(core.questionAnswers(t), answers, "the CLI's own record");
  assert.deepEqual(core.questionAnswers({ input: t.input, result: t.result }), answers, "its result text says the same");
  assert.deepEqual(core.splitAnswer(q1, answers[q1.question]), { picked: ["Apple", "Pear"] });
  assert.deepEqual(core.splitAnswer(q2, answers[q2.question]), { picked: [], other: "P0.13 LED1\nP0.14 LED2" });
  chat.dispose();
});

test("an answer read back as Claude Code reads it: the longest label first, Other after the picks, nothing for a question not answered", () => {
  const q = { question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "A, B" }, { label: "C" }] };
  assert.deepEqual(core.splitAnswer(q, "A, B, C"), { picked: ["A, B", "C"] });
  assert.deepEqual(core.splitAnswer(q, "C, pins 3 and 4"), { picked: ["C"], other: "pins 3 and 4" });
  assert.deepEqual(core.splitAnswer({ ...q, multiSelect: false }, "A"), { picked: ["A"] });
  const t = { input: { questions: [q, { question: "Port?", options: [] }] }, result: 'The user answered: "Which?"="C". You can now continue with these answers in mind.' };
  assert.deepEqual(core.questionAnswers(t), { "Which?": "C" });
  assert.equal(core.questionAnswers({ input: t.input, result: "The user did not answer the questions." }), null);
});
