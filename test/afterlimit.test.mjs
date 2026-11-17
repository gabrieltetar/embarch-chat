// A chat the usage limit cuts off waits for the reset, then continues
// (decision 109); and the Limits menu's handoff switch (103). The limit's
// own turn is not recorded over the panel's wire: limit*.jsonl are built
// here from refreshlock.jsonl's recorded turns, the made-up reply swapped
// for the one a 2.1.322 transcript holds [measured 2026-11-16], with the
// `rate_limit_event` usage.ts reads (99) before it.

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
fs.chmodSync(FAKE, 0o755);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-limit-"));
const tmp = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const waitFor = async (pred, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const LIMIT_TEXT = "You've hit your 5-hour limit · resets 11:30pm (Europe/Lisbon)";

/** The made-up reply as a 2.1.322 transcript holds it. */
function limitReplyLine(base, text = LIMIT_TEXT) {
  const o = structuredClone(base);
  o.message.content = [{ type: "text", text }];
  o.error = "rate_limit";
  o.apiError = "usage_limit_reached";
  o.isApiErrorMessage = true;
  return o;
}

/**
 * A recording of `turns` turns, each "limit" (cut off: the event and the
 * made-up reply) or "ok" (refreshlock.jsonl's second, recorded turn).
 */
function fixtureOf(turns, { limit = "five_hour", resetsAt }) {
  const rec = fs.readFileSync(path.join(here, "fixtures", "wire", "refreshlock.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cut = rec.findIndex((l, i) => i > 0 && l.d === "in");
  const first = rec.slice(0, cut);
  const okTurn = rec.slice(cut);
  const replyAt = first.findIndex((l) => l.o.type === "assistant");
  const event = { d: "out", o: { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: limit, utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.4, resetsAt: resetsAt + 86400 } } }, uuid: "0b7c1e2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d", session_id: first[1].o.session_id } };
  const limitTurn = [...first.slice(0, replyAt), event, { d: "out", o: limitReplyLine(first[replyAt].o) }, ...first.slice(replyAt + 1)];
  const out = turns.flatMap((t) => (t === "limit" ? limitTurn : okTurn));
  const file = path.join(tmp("fx-"), "limit.jsonl");
  fs.writeFileSync(file, out.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function makeChat(fixture, prefs = {}) {
  const dir = tmp("chat-");
  const inputLog = path.join(dir, "input.jsonl");
  const log = [];
  const chat = new core.Chat({
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: dir,
    claudePath: FAKE,
    existing: false,
    idleMs: 60000,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture, FAKE_CLAUDE_INPUT_LOG: inputLog },
    log: (l) => log.push(l),
    limits: { prefs: { ...core.DEFAULT_LIMIT_PREFS, ...prefs }, handoffTool: true },
    limitSlackMs: 0,
  });
  const notes = () => Object.values(chat.state.entries).filter((e) => e.kind === "note").map((e) => e.text);
  const users = () => lines(inputLog).map((l) => l.o).filter((l) => l.type === "user");
  return { chat, log, notes, users };
}

// ------------------------------------------------------------ what a hit is

test("the CLI's made-up limit reply is taken for a hit, a plain 429 or Claude's own words are not", () => {
  const reply = (text, extra = {}) => ({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, ...extra });
  assert.equal(core.limitReply(reply(LIMIT_TEXT, { error: "rate_limit", apiError: "usage_limit_reached" })), LIMIT_TEXT);
  assert.equal(core.limitReply(reply(LIMIT_TEXT)), LIMIT_TEXT, "the words alone, should the stream drop the fields");
  assert.equal(core.limitReply(reply("You've reached your Fable limit.")), "You've reached your Fable limit.");
  assert.equal(core.limitReply(reply("API Error: Request rejected (429) · rate limited", { error: "rate_limit" })), null, "a 429 the CLI retries");
  assert.equal(core.limitReply(reply("I see you've hit your limit of patience")), null);
  assert.equal(core.limitReply({ type: "user", message: { content: [{ type: "text", text: LIMIT_TEXT }] } }), null, "the owner quoting it");
});

test("a limit falls under the session's switch or the week's; an overage limit under none", () => {
  assert.equal(core.limitWindow("five_hour"), "session");
  for (const l of ["seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]) assert.equal(core.limitWindow(l), "weekly", l);
  assert.equal(core.limitWindow("overage"), null);
  assert.equal(core.limitWindow(null, LIMIT_TEXT), "session", "from the words");
  assert.equal(core.limitWindow(null, "You've hit your weekly limit · resets Wed 6am"), "weekly");
  assert.equal(core.limitWindow(null, "You've reached your Fable limit."), null);
});

test("the reset the words name, on this machine's clock, and not in another zone", () => {
  const now = new Date(2026, 10, 16, 17, 7).getTime(); // Mon 16 Nov 2026, 17:07
  const at = (s) => new Date(s * 1000);
  const z = "Europe/Lisbon";
  let r = core.resetOfText("You've hit your 5-hour limit · resets 11:30pm (Europe/Lisbon)", now, z);
  assert.deepEqual([at(r).getDate(), at(r).getHours(), at(r).getMinutes()], [16, 23, 30]);
  r = core.resetOfText("resets 5am", now, z);
  assert.equal(at(r).getDate(), 17, "a time already past today is tomorrow's");
  r = core.resetOfText("You've hit your weekly limit · resets Wed 6am", now, z);
  assert.deepEqual([at(r).getDay(), at(r).getDate(), at(r).getHours()], [3, 18, 6]);
  r = core.resetOfText("resets Nov 18, 6am", now, z);
  assert.deepEqual([at(r).getMonth(), at(r).getDate(), at(r).getHours()], [10, 18, 6]);
  assert.equal(core.resetOfText("resets 11:30pm (Europe/Paris)", now, z), null, "another zone: not guessed");
  assert.equal(core.resetOfText("resets soon", now, z), null);
});

test("the event's limit and reset win over the words; without a rejected event the words say", () => {
  const now = Date.now();
  const hit = core.limitHitOf(LIMIT_TEXT, { status: "rejected", limit: "seven_day", resetsAt: 1795006800 }, now);
  assert.deepEqual([hit.limit, hit.window, hit.resetsAt], ["seven_day", "weekly", 1795006800]);
  const words = core.limitHitOf("You've hit your 5-hour limit · resets 11:30pm", { status: "allowed_warning", limit: "five_hour", resetsAt: 1 }, now);
  assert.deepEqual([words.limit, words.window], [null, "session"]);
  assert.ok(words.resetsAt * 1000 > now);
  assert.equal(core.limitHitOf("You've reached your Fable limit.", null, now), null);
});

test("the handoff's switch picks card or immediate at each call; without one, the setting does", () => {
  assert.equal(core.handoffHow({ autoHandoff: true }, "card"), "immediate");
  assert.equal(core.handoffHow({ autoHandoff: false }, "immediate"), "card");
  assert.equal(core.handoffHow({}, "immediate"), "immediate");
});

// ------------------------------------------------------------ a chat's wait

test("a turn the 5-hour limit cuts off waits for its reset, then the menu's message goes on its own, once", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 2;
  const { chat, notes, users, log } = makeChat(fixtureOf(["limit", "ok"], { resetsAt }), { text: "carry on" });
  const ended = [];
  chat.on("turn", (o) => ended.push(o));
  chat.send("Reply with just: ok");
  await waitFor(() => ended.length === 1);
  const w = chat.state.limitWait;
  assert.ok(w?.armed, "armed");
  assert.deepEqual([w.limit, w.window, w.resetsAt], ["five_hour", "session", resetsAt]);
  assert.equal(users().length, 1, "nothing before the reset");
  await waitFor(() => ended.length === 2);
  const sent = users();
  assert.equal(sent.length, 2);
  assert.ok(JSON.stringify(sent[1].message).includes("carry on"), "the menu's message");
  assert.ok(notes().some((n) => /5-hour limit reset: "carry on" went on its own/.test(n)), notes().join("\n"));
  assert.equal(chat.state.limitWait, null, "the wait is over");
  assert.ok(log.some((l) => /limit hit: five_hour/.test(l)));
  assert.equal(chat.limitTries, 0, "its turn got through: the count starts again");
  chat.dispose();
});

test("a weekly limit waits unarmed with its switch off, and arms when the owner turns it on", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 1;
  const { chat, users } = makeChat(fixtureOf(["limit", "ok"], { limit: "seven_day", resetsAt }));
  const ended = [];
  chat.on("turn", (o) => ended.push(o));
  chat.send("Reply with just: ok");
  await waitFor(() => ended.length === 1);
  assert.equal(chat.state.limitWait?.window, "weekly");
  assert.equal(chat.state.limitWait?.armed, false, "off by default");
  await sleep(1500);
  assert.equal(users().length, 1, "past the reset, nothing went");
  chat.setLimitPrefs({ weekly: true });
  assert.equal(chat.state.limitPrefs.weekly, true);
  await waitFor(() => ended.length === 2);
  assert.equal(users().length, 2, "its reset is past: it goes at once");
  chat.dispose();
});

test("Cancel and a message of the owner's each take the wait away", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 2;
  const { chat, users } = makeChat(fixtureOf(["limit", "ok"], { resetsAt }));
  const ended = [];
  chat.on("turn", (o) => ended.push(o));
  chat.send("Reply with just: ok");
  await waitFor(() => ended.length === 1);
  assert.ok(chat.state.limitWait?.armed);
  chat.cancelWait();
  assert.equal(chat.state.limitWait, null);
  await sleep(2500);
  assert.equal(users().length, 1, "cancelled: nothing went");
  chat.dispose();

  const b = makeChat(fixtureOf(["limit", "ok"], { resetsAt: Math.floor(Date.now() / 1000) + 30 }));
  const done = [];
  b.chat.on("turn", (o) => done.push(o));
  b.chat.send("Reply with just: ok");
  await waitFor(() => done.length === 1);
  assert.ok(b.chat.state.limitWait?.armed);
  b.chat.send("Reply with just: ok");
  await waitFor(() => done.length === 2);
  assert.equal(b.chat.state.limitWait, null, "the owner's turn got through: nothing waits");
  b.chat.dispose();
});

test("a continue the limit still turns back twice in a row stops, and says so", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) - 1;
  const { chat, notes, users } = makeChat(fixtureOf(["limit", "limit", "limit"], { resetsAt }));
  const ended = [];
  chat.on("turn", (o) => ended.push(o));
  chat.send("Reply with just: ok");
  await waitFor(() => ended.length === 3);
  await sleep(200);
  assert.equal(users().length, 3, "the owner's, then two continues");
  const w = chat.state.limitWait;
  assert.equal(w?.stopped, true);
  assert.equal(w?.armed, false);
  assert.ok(notes().some((n) => /still turned Claude back after 2 continues/.test(n)), notes().join("\n"));
  chat.dispose();
});

test("a reload carries the menu and an armed wait, which goes at its reset", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 1;
  const { chat, users } = makeChat(fixtureOf(["ok"], { resetsAt }));
  chat.restoreLimits({ prefs: { text: "go on", handoff: true }, wait: { limit: "five_hour", window: "session", resetsAt, hitAt: Date.now(), armed: true }, fruitless: 1 });
  assert.equal(chat.autoHandoff, true);
  assert.equal(chat.limitTries, 1);
  const ended = [];
  chat.on("turn", (o) => ended.push(o));
  await waitFor(() => ended.length === 1);
  assert.ok(JSON.stringify(users()[0].message).includes("go on"));
  chat.dispose();
});
