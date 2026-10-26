// What the CLI sends Claude is never the owner's bubble (decision 89): a
// background task's notification is a row linked to its card, another
// session's message a collapsed row, and neither is a message to edit,
// rewind to or match to one the owner sent. Against recorded real sessions
// (notifymid, notifyidle) and the transcript one of them wrote.

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
const wire = (n) =>
  fs
    .readFileSync(path.join(here, "fixtures", "wire", `${n}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((l) => l.d === "out")
    .map((l) => l.o);
const fold = (events) => core.reduceAll(core.initialState("11111111-2222-4333-8444-555555555555"), events);
const top = (s) => s.timeline.map((id) => s.entries[id]);
const kind = (s, k) => top(s).filter((e) => e.kind === k);
const rows = (s) => top(s).filter((e) => e.kind === "note" && e.tone === "task");
const agentOf = (s) => Object.values(s.entries).find((e) => e.kind === "tool" && e.name === "Agent");

test("mid-turn: the replayed notification is one row linked to the Agent card, and no user entry", () => {
  const s = fold(wire("notifymid"));
  assert.equal(kind(s, "user").length, 1, "only the owner's own prompt");
  assert.ok(!top(s).some((e) => "text" in e && /task-notification|<output-file>/.test(e.text)));
  const r = rows(s);
  assert.equal(r.length, 1);
  assert.equal(r[0].tool, agentOf(s).id);
  assert.equal(r[0].text, 'Agent "Reply with PING" completed');
  assert.ok(top(s).indexOf(r[0]) > top(s).indexOf(agentOf(s)), "after the card it points to");
});

test("idle: a task that ends after the turn gets its row ahead of the reply the CLI starts", () => {
  const s = fold(wire("notifyidle"));
  assert.equal(kind(s, "user").length, 1);
  const r = rows(s);
  assert.equal(r.length, 1, "one row, and none for the subagent's own shell");
  assert.equal(r[0].tool, agentOf(s).id);
  assert.match(r[0].text, /^Agent "[^"]+" completed$/);
  const at = top(s).indexOf(r[0]);
  const last = top(s).at(-1);
  assert.equal(last.kind, "text");
  assert.equal(last.text, "PING");
  assert.equal(at, top(s).length - 2, "directly above the self-started reply");
});

test("an idle row waits for the reply, and an owner's message drops it", () => {
  const events = wire("notifyidle");
  const upto = events.findIndex((o) => o.type === "system" && o.subtype === "init" && events.indexOf(o) > 20);
  const s = fold(events.slice(0, upto));
  assert.equal(rows(s).length, 0, "nothing in the timeline before the turn starts");
  assert.equal(s.noticed.length, 1);
  const t = core.reduce(s, { type: "user", message: { role: "user", content: "next" } });
  assert.equal(t.noticed.length, 0);
});

test("a line from another session is a collapsed message row, a hand-back is not one", () => {
  const msg = 'Another Claude session sent a message:\n<agent-message from="build-helper" id="1">run the tests please</agent-message>';
  let s = fold([{ type: "user", message: { role: "user", content: msg }, origin: { kind: "peer" } }]);
  assert.equal(kind(s, "user").length, 0);
  const [n] = kind(s, "note");
  assert.equal(n.tone, "peer");
  assert.equal(n.text, "Message from build-helper");
  assert.equal(n.detail, "run the tests please");
  s = fold([{ type: "user", message: { role: "user", content: msg }, origin: { kind: "peer", handback: true } }]);
  assert.deepEqual(top(s), []);
});

test("the owner's own lines still give a user entry: origin human, none, or the panel's sdk", () => {
  for (const extra of [{ origin: { kind: "human" } }, {}, { turnOrigin: "sdk", promptSource: "sdk" }]) {
    const s = fold([{ type: "user", message: { role: "user", content: "hello there" }, ...extra }]);
    assert.deepEqual(kind(s, "user").map((e) => e.text), ["hello there"], JSON.stringify(extra));
  }
});

test("a line of the CLI's is never matched to a pending message of the owner's", () => {
  let s = core.initialState("11111111-2222-4333-8444-555555555555");
  s = core.reduce(s, { type: "_sent", id: "u1", text: "run the tests please", uuid: "00000000-0000-4000-8000-000000000001" });
  const same = 'Another Claude session sent a message:\n<agent-message from="x">run the tests please</agent-message>';
  for (const o of [{ origin: { kind: "peer" }, content: same }, { origin: { kind: "hook" }, content: "run the tests please" }, { origin: { kind: "peer" }, uuid: "00000000-0000-4000-8000-000000000001", content: "run the tests please" }]) {
    s = core.reduce(s, { type: "user", message: { role: "user", content: o.content }, origin: o.origin, ...(o.uuid ? { uuid: o.uuid } : {}) });
  }
  const mine = Object.values(s.entries).filter((e) => e.kind === "user");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].pending, true, "still waiting for its own echo");
});

test("reload: the notification a transcript records as a queued command gives the same row", () => {
  const file = path.join(here, "fixtures", "transcripts", "575f17ad-b329-4aa6-8538-514640217fc2.jsonl");
  const { events } = core.readTranscript(file);
  const s = fold(events);
  assert.equal(kind(s, "user").length, 1);
  const r = rows(s);
  assert.equal(r.length, 1);
  assert.equal(r[0].tool, agentOf(s).id);
  assert.equal(r[0].text, 'Agent "Reply with PING" completed');
});

test("the assistant's prompt history and the panel read one rule", () => {
  const o = { type: "user", message: { content: "x" } };
  assert.equal(core.originKind({ ...o, origin: { kind: "task-notification" } }), "task-notification");
  assert.equal(core.originKind({ ...o, origin: { kind: "human" } }), "human");
  assert.equal(core.originKind(o), "human");
  assert.equal(core.originKind({ ...o, turnOrigin: "sdk" }), "sdk");
});

// A background agent's card shows the subagent's report (decision 90). The
// hand-back line is the shape seen in an owner's transcript on CLI 2.1.287:
// no recording put it on the wire, so the wire test below uses the fallback
// that was recorded (notifyidle: the subagent's last reply, parent_tool_use_id
// set to the card), and the hand-back is built by hand from that shape.
const REPORT = "Found two files.\n\n- a.txt\n- b.txt";
const handback = (from, extra = {}) => ({
  type: "user",
  isMeta: true,
  message: { role: "user", content: `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back]\n${REPORT}\n</agent-message>` },
  origin: { kind: "peer", handback: true, from, senderTaskId: from, name: "worker", body: REPORT, ...extra },
});

test("wire: the card's result is the subagent's last reply, and the launch reply is not", () => {
  const s = fold(wire("notifyidle"));
  const a = agentOf(s);
  assert.equal(a.result, "PING");
  assert.equal(a.reportFrom, "text");
  assert.ok(!a.result.includes("Async agent launched"));
  assert.equal(a.structured.isAsync, true, "the launch reply's record is kept");
});

test("a hand-back is the report, found by its task id, and wins over the subagent's last reply", () => {
  const events = wire("notifyidle");
  const task = events.find((o) => o.type === "system" && o.subtype === "task_started" && o.task_type === "local_agent").task_id;
  const s = fold([...events, handback(task)]);
  const a = agentOf(s);
  assert.equal(a.result, REPORT);
  assert.equal(a.reportFrom, "handback");
  assert.equal(kind(s, "user").length, 1, "no bubble for it");
  assert.equal(rows(s).length, 1, "the notification's row is unchanged");
  // Without origin.body, the text between the tags, frame removed.
  const t = fold([...events, handback(task, { body: undefined })]);
  assert.equal(agentOf(t).result, REPORT);
  // A late launch reply, or later subagent text, never replaces it.
  const late = events.find((o) => o.type === "user" && JSON.stringify(o).includes("Async agent launched"));
  const u = fold([...events.filter((o) => o !== late), handback(task), late]);
  assert.equal(agentOf(u).result, REPORT);
  // One for a task nobody knows is dropped.
  assert.equal(agentOf(fold([...events, handback("zzz")])).result, "PING");
});

test("reload: a transcript's hand-back line gives the card the same result", () => {
  const src = path.join(here, "fixtures", "transcripts", "575f17ad-b329-4aa6-8538-514640217fc2.jsonl");
  const agentId = "ac4da7e8888589400";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
  const file = path.join(dir, "575f17ad-b329-4aa6-8538-514640217fc2.jsonl");
  const line = { ...handback(agentId), uuid: "00000000-0000-4000-8000-0000000000aa", timestamp: "2026-10-26T05:22:30.000Z", sessionId: "575f17ad-b329-4aa6-8538-514640217fc2", isSidechain: false };
  fs.writeFileSync(file, fs.readFileSync(src, "utf8").replace(/\n?$/, "\n") + JSON.stringify(line) + "\n");
  try {
    const s = fold(core.readTranscript(file).events);
    const a = agentOf(s);
    assert.equal(a.result, REPORT);
    assert.equal(a.reportFrom, "handback");
    assert.equal(kind(s, "user").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
