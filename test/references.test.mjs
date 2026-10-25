// The desk's reference index in the chat (decision 88): the local match of
// a draft against it for the cards call, the prompt's <desk_references>
// block and its cap, the recorded Haiku call that turns "the widget PR" into
// the PR itself, and bare keys and PR numbers in Claude's prose as links only
// when the index knows them. All on a made-up index (refs-index.mjs).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX, OWN, VAGUE } from "./refs-index.mjs";
import { REFS_CASE } from "./record-haiku.mjs";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fake-claude.mjs");
fs.chmodSync(FAKE, 0o755);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-refs-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const own = { ownKey: OWN.key, ownPrs: OWN.prs };
const WIDGET = 'ABC-154 "Create the Widget" Done · PR owner/repo#36 "Widget" merged';

// ------------------------------------------------------------ the local match

test("a vague pointer at another item's PR finds that PR and the issue it closed, on one line", () => {
  assert.deepEqual(core.deskReferences(INDEX, VAGUE, own), [WIDGET]);
  // "test" is in three titles of seven: a word that common tells nothing alone.
  assert.ok(!core.deskReferences(INDEX, VAGUE, own).some((l) => l.includes("UART")));
  // The chat's own item and its PR are already in the prompt: its words find nothing.
  assert.deepEqual(core.deskReferences(INDEX, "write the gadget parser docs like the parser PR", own), ['ABC-171 "Make the gadget parser stream" In Progress']);
  assert.deepEqual(core.deskReferences(INDEX, "finish the gadget parser", { ownKey: "ABC-171" }).slice(0, 1), ['ABC-170 "Add the gadget parser" In Progress · PR owner/repo#44 "Gadget parser" draft']);
});

test("a key, an owner/repo#N or a PR link the draft names comes first, whatever its words", () => {
  assert.deepEqual(core.deskReferences(INDEX, "follow up on abc-150 before the widget work", own), ['ABC-150 "Document the release process" Done · PR owner/docs#12 "Document the release process" merged', WIDGET]);
  assert.deepEqual(core.deskReferences(INDEX, "do as owner/docs#12 did", own), ['ABC-150 "Document the release process" Done · PR owner/docs#12 "Document the release process" merged']);
  assert.deepEqual(core.deskReferences(INDEX, "see https://github.com/owner/repo/pull/38 first", own), ['ABC-162 "Flash the dev board from CI" Done · PR owner/repo#38 "Flash from CI" merged']);
  // A key the index does not know is no reference.
  assert.deepEqual(core.deskReferences(INDEX, "what about XYZ-9 and UTF-8?", own), []);
});

test("a draft whose words no title shares gets no references, and no index none at all", () => {
  assert.deepEqual(core.deskReferences(INDEX, "why is the console so quiet today", own), []);
  assert.deepEqual(core.deskReferences(null, VAGUE, own), []);
  assert.deepEqual(core.deskReferences({ desk_id: null, synced_ms: null, issues: [], prs: [] }, VAGUE, own), []);
  assert.deepEqual(core.deskReferences(INDEX, "   ", own), []);
});

test("#N that two repos share lists both, for a card each; owner/repo#N is the one", () => {
  assert.deepEqual(core.deskReferences(INDEX, "add a test like #36 did", own), [WIDGET, 'PR owner/docs#36 "Release notes template" merged']);
  assert.deepEqual(core.deskReferences(INDEX, "add a test like PR 36 did", own), [WIDGET, 'PR owner/docs#36 "Release notes template" merged']);
  assert.deepEqual(core.deskReferences(INDEX, "add a test like owner/docs#36 did", own), ['PR owner/docs#36 "Release notes template" merged']);
});

test("the block holds at most 8 lines and about 600 tokens, best first, each issue and PR once", () => {
  const issues = Array.from({ length: 40 }, (_, i) => ({ key: `ABC-${500 + i}`, title: `Widget calibration step ${i} ${"with a long tail ".repeat(i % 3 ? 1 : 12)}`, state: "Done", url: `https://linear.app/acme/issue/ABC-${500 + i}` }));
  const prs = issues.map((x, i) => ({ repo: "owner/repo", number: 100 + i, title: `Calibration ${i}`, state: "merged", draft: false, url: `https://github.com/owner/repo/pull/${100 + i}`, branch: `abc-${500 + i}`, keys: [x.key] }));
  const lines = core.deskReferences({ desk_id: "k", synced_ms: 1, issues, prs }, "redo the widget calibration like before", {});
  assert.ok(lines.length <= core.REFS_LINES && lines.length >= 3, `${lines.length} lines`);
  assert.ok(lines.join("\n").length <= core.REFS_CHARS, `${lines.join("\n").length} chars`);
  assert.equal(new Set(lines).size, lines.length);
  for (const l of lines) assert.ok(l.length < 400, "a long title is clipped");
  assert.equal(lines[0].split(" ")[0], "ABC-500", "newest first among equals");
  // Each issue's PR rides on its line, and is not listed again.
  assert.ok(lines.every((l) => /^ABC-\d+ ".*" Done · PR owner\/repo#\d+ "Calibration \d+" merged$/.test(l)), lines.join("\n"));
});

test("the cards prompt carries the block and the rule; ghost text and the turn never do (26)", () => {
  const references = core.deskReferences(INDEX, VAGUE, own);
  const input = { ...REFS_CASE, references };
  const cards = core.cardsPrompt(input);
  assert.ok(cards.includes(`<desk_references>\nIssues and PRs on this desk that the draft names, or whose titles share its words, best first:\n${WIDGET}\n</desk_references>`), cards);
  assert.match(cards, /Check it first: when the draft points at an issue, a PR, a test or a file only vaguely/);
  assert.ok(cards.indexOf("<desk_references>") < cards.indexOf("<draft>"));
  // The work item's own PRs by title (from its card, or the index when the card has none).
  assert.ok(cards.includes('<work_item>ABC-170 Add the gadget parser · In Progress · PR owner/repo#44 "Gadget parser" draft</work_item>'));
  for (const p of [core.ghostPrompt(input), core.turnPrompt(input, { chips: true, name: false })]) {
    assert.ok(!p.includes("desk_references") && !p.includes(WIDGET) && !p.includes("Check it first"), p);
  }
  // No references: the cards prompt is as it was, the rule and the block left out.
  const plain = core.cardsPrompt({ ...input, references: [] });
  assert.ok(!plain.includes("desk_references") && !plain.includes("Check it first"));
  assert.equal(core.prLine({ repo: "owner/repo", number: 7, title: 'A "quoted"\ntitle', state: "open", draft: true }), "PR owner/repo#7 \"A 'quoted' title\" draft");
});

// ------------------------------------------------------------ the recorded call (fake-claude.mjs)

test("the recorded cards call for the vague widget PR replaces the phrase with the PR itself, in one call", async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "s-"));
  const argsLog = path.join(dir, "args.jsonl");
  const a = new core.HaikuAssistant(() => ({
    claudePath: FAKE,
    enabled: true,
    log: () => {},
    env: { ...core.haikuEnv(), FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_HAIKU_CARDS: path.join(here, "fixtures", "haiku", "cards-refs.jsonl") },
  }));
  try {
    const cards = await a.cards("s1", REFS_CASE);
    const calls = fs.readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 1, "one call: no extra wave");
    assert.ok(calls[0].prompt.includes(WIDGET), "the references went with it");
    const card = cards.find((c) => c.category === "missing");
    assert.ok(card, JSON.stringify(cards));
    assert.equal(card.edit.op, "replace");
    assert.ok(VAGUE.includes(card.edit.find) && /widget PR/.test(card.edit.find), card.edit.find);
    assert.match(card.edit.with, /owner\/repo#36/);
    assert.match(card.edit.with, /Widget/);
    assert.ok(!/\[/.test(card.edit.with), "named, not asked");
    assert.match(core.applyEdit(VAGUE, card.edit), /^Let's include a test just like PR owner\/repo#36 .*Widget.* did, with the same structure$/);
  } finally {
    a.dispose();
  }
});

// ------------------------------------------------------------ prose (refprose.ts)

test("a key or PR in prose is a link only when the index knows it, to Linear or GitHub, never elsewhere", () => {
  core.setRefs(null);
  assert.equal(core.proseRefs("Done in ABC-154 and owner/repo#36."), null, "no index, no links");
  core.setRefs(INDEX);
  try {
    const parts = core.proseRefs("Done in ABC-154, see owner/repo#36 and #38; XYZ-1, UTF-8 and #36 stay text.");
    const links = parts.filter((p) => typeof p !== "string");
    assert.deepEqual(
      links.map((l) => [l.label, l.url]),
      [
        ["ABC-154", "https://linear.app/acme/issue/ABC-154/create-the-widget"],
        ["owner/repo#36", "https://github.com/owner/repo/pull/36"],
        ["#38", "https://github.com/owner/repo/pull/38"],
      ],
    );
    assert.equal(parts.filter((p) => typeof p === "string").join(""), "Done in , see  and ; XYZ-1, UTF-8 and #36 stay text.", "#36 two repos share: text");
    assert.match(links[0].title, /^ABC-154 Create the Widget · Done\nOpens in Linear: /);
    assert.match(links[1].title, /^owner\/repo#36 Widget · merged\nOpens in GitHub: /);
    // A lower-case key, one inside a word or a path, and a branch name are text.
    assert.equal(core.proseRefs("abc-154, xABC-154, src/ABC-154.c and abc-154-create-the-widget"), null);
    // A link the index carries to another host is no link.
    core.setRefs({ issues: [{ ...INDEX.issues[5], url: "https://linear.app.evil.example/x" }], prs: [{ ...INDEX.prs[3], url: "http://github.com/owner/repo/pull/36" }] });
    assert.equal(core.proseRefs("ABC-154 and #36"), null);
  } finally {
    core.setRefs(null);
  }
});
