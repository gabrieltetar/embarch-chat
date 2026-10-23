// The desk client against a scratch embarch-desk (never the live one on
// :4891): its own data and config folders and port, from a binary built
// from ../embarch-desk. Set EMBARCH_DESK_BIN to the binary; without one the
// scratch-desk tests skip and the pure thread-list tests still run.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

const BIN = process.env.EMBARCH_DESK_BIN;
const PORT = 4950 + Math.floor(Math.random() * 30);
let desk = null;
let dir = null;
let client = null;

before(async () => {
  if (!BIN || !fs.existsSync(BIN)) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-desk-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.mkdirSync(path.join(dir, "config"));
  desk = spawn(BIN, ["serve"], {
    env: { ...process.env, EMBARCH_DESK_DATA_DIR: path.join(dir, "data"), EMBARCH_DESK_CONFIG_DIR: path.join(dir, "config"), EMBARCH_DESK_PORT: String(PORT) },
    stdio: "ignore",
  });
  client = new core.DeskClient({ baseUrl: `http://127.0.0.1:${PORT}`, tokenPath: path.join(dir, "config", "desk-token") });
  for (let i = 0; i < 100; i++) {
    try {
      await client.call("GET", "/health");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("scratch desk did not start");
});

after(() => {
  desk?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const live = { skip: !BIN ? "EMBARCH_DESK_BIN not set" : false };

test("assign marks the session as this panel's, and /view reports it", live, async () => {
  const { id } = await client.call("POST", "/items", { title: "ABC-123 a test item", desk: "none" });
  const sid = "0b0e1a1e-0000-4000-8000-000000000001";
  const r = await client.assign(sid, { item_id: id });
  assert.equal(r.item_id, id);
  const v = await client.view();
  const row = v.sessions.find((s) => s.session_id === sid);
  assert.equal(row.client, "embarch-chat");
  assert.equal(row.item_id, id);
  assert.ok(["idle", "busy", "waiting", "ended"].includes(row.state));
  const card = v.cards.find((c) => c.id === id);
  assert.equal(card.live_sessions.find((s) => s.session_id === sid).client, "embarch-chat");
  const s = await client.session(sid);
  assert.equal(s.work_item.id, id);
});

test("an untracked chat, and a new title, assign too", live, async () => {
  assert.equal((await client.assign("0b0e1a1e-0000-4000-8000-000000000002", { untracked: true })).untracked, true);
  const r = await client.assign("0b0e1a1e-0000-4000-8000-000000000003", { new_title: "A fresh piece of work", desk: "none" });
  assert.ok(r.item_id);
});

test("the mailbox: a start entry for this folder, taken once", live, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-124 mailbox item", desk: "none" });
  const folder = "/work/repo-abc-124";
  const { id } = await client.call("POST", "/mailbox", { kind: "start", item_id: item, folder, prompt: "Read the issue and start." });
  const entries = await client.mailbox(folder);
  const e = entries.find((x) => x.id === id);
  assert.equal(e.kind, "start");
  assert.equal(e.item_id, item);
  assert.equal(e.prompt, "Read the issue and start.");
  assert.deepEqual(await client.mailbox("/work/another-folder"), []);
  const got = await client.take(id);
  assert.equal(got.id, id);
  assert.equal(await client.take(id), null, "a second take is a 409");
  await assert.rejects(client.take("no-such-entry"), (err) => err.status === 404);
});

test("Jump to another window's chat leaves a focus entry", live, async () => {
  const folder = "/work/other-window";
  const { id } = await client.postFocus("0b0e1a1e-0000-4000-8000-000000000001", folder);
  const e = (await client.mailbox(folder)).find((x) => x.id === id);
  assert.equal(e.kind, "focus");
  assert.equal(e.session_id, "0b0e1a1e-0000-4000-8000-000000000001");
});

test("a wrong token is refused after one re-read", live, async () => {
  const bad = new core.DeskClient({ baseUrl: `http://127.0.0.1:${PORT}`, tokenPath: path.join(dir, "no-token") });
  await assert.rejects(bad.view(), (err) => err.status === 401);
});

test("a stopped desk reads as unreachable", async () => {
  const c = new core.DeskClient({ baseUrl: "http://127.0.0.1:9", tokenPath: "/nonexistent" });
  await assert.rejects(c.view(), (err) => err.unreachable === true);
});

// ------------------------------------------------------------ the list

const DESK = { id: "k1", name: "Example", firmware_repos: ["/work/fw"] };
const OTHER = { id: "k2", name: "Other", firmware_repos: ["/work/other"] };

function card(id, key, sessions = [], extra = {}) {
  return {
    id,
    title: `${key} title`,
    issue: { key, url: `https://linear.example/${key}`, title: `${key} title`, state_name: "In Progress" },
    repo_path: "/work/fw",
    prs: [],
    last_activity_ms: 1000,
    live_sessions: sessions,
    tiles: [{ id: `${id}@2026-10-23`, date: "2026-10-23", seconds: 3600 }],
    ...extra,
  };
}

function view(cards, sessions = [], open = DESK) {
  return { now_ms: 5000, today: "2026-10-23", cards, desks: [DESK, OTHER], open_desk: open, ignore: ["/work/fw/fleet"], sessions };
}

test("the window's desk is the one whose repo holds its folder, else the open desk", () => {
  assert.equal(core.resolveDesk(["/work/fw-abc-123"], [DESK, OTHER], OTHER).id, "k2", "a sibling worktree folder is not inside the repo");
  assert.equal(core.resolveDesk(["/work/fw"], [DESK, OTHER], OTHER).id, "k1");
  assert.equal(core.resolveDesk(["/work/fw/sub"], [DESK, OTHER], OTHER).id, "k1");
  assert.equal(core.resolveDesk(["/elsewhere"], [DESK, OTHER], OTHER).id, "k2");
});

test("threads group by work item, waiting-on-you first, Untracked last", () => {
  const v = view(
    [
      card("w1", "ABC-1", [{ session_id: "s1", name: "terminal one", state: "busy", last_ms: 4000, cwd: "/work/fw", client: null }]),
      card("w2", "ABC-2", [
        { session_id: "s2", name: "idle one", state: "idle", last_ms: 4500, cwd: "/work/fw" },
        { session_id: "s3", name: "asks", state: "waiting", waiting_for: "permission: Bash", last_ms: 3000, cwd: "/work/fw" },
      ]),
    ],
    [{ session_id: "s9", name: "loose", state: "idle", last_ms: 4200, cwd: "/work/fw", item_id: null, desk_id: "k1" }],
  );
  const groups = core.buildThreads({
    view: v,
    desk: DESK,
    repos: ["/work/fw"],
    own: [{ sessionId: "o1", title: "mine", status: "waiting", itemId: "w1", lastMs: 4900, cwd: "/work/fw", waitingFor: "your answer" }],
    past: [
      { sessionId: "p1", title: "old chat", firstPrompt: "x", cwd: "/work/fw", lastMs: 100 },
      { sessionId: "p2", title: "fleet chat", firstPrompt: "x", cwd: "/work/fw/fleet", lastMs: 200 },
      { sessionId: "p3", title: "elsewhere", firstPrompt: "x", cwd: "/work/unrelated", lastMs: 300 },
    ],
    itemOf: { p1: { id: "w2", title: "ABC-2 title" } },
    now: 5000,
  });
  assert.deepEqual(groups.map((g) => g.key), ["w1", "w2", "untracked"], "both cards wait; desk order kept; untracked last");
  const w1 = groups[0];
  assert.deepEqual(w1.threads.map((t) => [t.sessionId, t.state, t.ours]), [["o1", "waiting", true], ["s1", "busy", false]]);
  assert.equal(w1.item.issueKey, "ABC-1");
  assert.equal(w1.item.todaySeconds, 3600);
  const w2 = groups[1];
  assert.deepEqual(w2.threads.map((t) => t.sessionId), ["s3", "s2", "p1"], "waiting, then idle, then the past chat");
  assert.equal(w2.threads[2].state, "ended");
  assert.deepEqual(groups[2].threads.map((t) => t.sessionId), ["s9"], "the fleet and other repos stay out");
  assert.deepEqual(core.waitingThreads(groups).map((t) => t.sessionId), ["s3", "o1"], "oldest waiting first");
});

test("a group that waits moves ahead of the desk's order", () => {
  const v = view([card("w1", "ABC-1", [{ session_id: "a", state: "idle", last_ms: 1, cwd: "/work/fw" }]), card("w2", "ABC-2", [{ session_id: "b", state: "waiting", last_ms: 1, cwd: "/work/fw" }])]);
  const groups = core.buildThreads({ view: v, desk: DESK, repos: ["/work/fw"], own: [], past: [], itemOf: {}, now: 5 });
  assert.deepEqual(groups.map((g) => g.key), ["w2", "w1"]);
});

test("when the window's desk is not the open one, only cards in its repos show", () => {
  const v = view([card("w1", "ABC-1", [], { repo_path: "/work/other" }), card("w2", "ABC-2", [], { repo_path: "/work/fw" })], [], OTHER);
  const groups = core.buildThreads({ view: v, desk: DESK, repos: ["/work/fw"], own: [], past: [], itemOf: {}, now: 5 });
  assert.deepEqual(groups.map((g) => g.key), ["w2"]);
});

test("without a desk the window's own chats still list", () => {
  const groups = core.buildThreads({
    view: null,
    desk: null,
    repos: ["/work/fw"],
    own: [{ sessionId: "o1", title: null, status: "idle", itemId: null, lastMs: 1, cwd: "/work/fw" }],
    past: [],
    itemOf: {},
    now: 5,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].item, null);
  assert.equal(groups[0].threads[0].title, "New chat");
});
