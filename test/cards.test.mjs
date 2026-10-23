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
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

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
