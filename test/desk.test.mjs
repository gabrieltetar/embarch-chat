// The desk client against a scratch embarch-desk (never the live one on
// :4891): its own data and config folders and port, from a binary built
// from ../embarch-desk. Set EMBARCH_DESK_BIN to the binary; without one the
// scratch-desk tests skip and the pure thread-list tests still run.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { ScratchDesk, haveDesk, haveOldDesk, OLD_BIN } from "./scratch-desk.mjs";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

const PORT = 4980;
const PROBE_PORT = 4981;
let desk = null;
let dir = null;
let client = null;

before(async () => {
  if (!haveDesk) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-desk-"));
  desk = await new ScratchDesk(dir, PORT).start();
  client = desk.client;
});

after(async () => {
  await desk?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const live = { skip: !haveDesk ? "EMBARCH_DESK_BIN not set" : false };

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
  // Only Start work leaves a start, server-side; the test seeds the store as it would.
  const id = await desk.withStart({ item_id: item, folder, prompt: "Read the issue and start." });
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

test("the desk refuses a start posted to the mailbox: only Start work leaves one", live, async () => {
  await assert.rejects(client.call("POST", "/mailbox", { kind: "start", item_id: "x", folder: "/work/x", prompt: "rm -rf" }), (err) => err.status === 400);
  assert.deepEqual(await client.mailbox("/work/x"), []);
});

test("Jump to another window's chat leaves a focus entry", live, async () => {
  const folder = "/work/other-window";
  const { id } = await client.postFocus("0b0e1a1e-0000-4000-8000-000000000001", folder);
  const e = (await client.mailbox(folder)).find((x) => x.id === id);
  assert.equal(e.kind, "focus");
  assert.equal(e.session_id, "0b0e1a1e-0000-4000-8000-000000000001");
});

test("a window on another desk than the open one asks for its own desk's cards; a deleted desk is a 404", live, async () => {
  const repo = (n) => {
    fs.mkdirSync(path.join(dir, n), { recursive: true });
    return path.join(dir, n);
  };
  const a = await client.call("POST", "/desks", { name: "Desk A", firmware_repos: [repo("fw-a")] });
  const b = await client.call("POST", "/desks", { name: "Desk B", firmware_repos: [repo("fw-b")] });
  const idOf = (r) => r.id ?? r.desk?.id;
  await client.call("POST", "/open", { desk: idOf(a) });
  const { id: onA } = await client.call("POST", "/items", { title: "ABC-201 on desk A", desk: idOf(a) });
  const { id: onB } = await client.call("POST", "/items", { title: "ABC-202 on desk B", desk: idOf(b) });
  const open = await client.view();
  assert.ok(open.cards.some((c) => c.id === onA) && !open.cards.some((c) => c.id === onB), "the plain view is the open desk's");
  const vb = await client.view(idOf(b));
  assert.ok(vb.cards.some((c) => c.id === onB) && !vb.cards.some((c) => c.id === onA), "?desk= is that desk's");
  assert.ok("notes_ms" in vb.cards.find((c) => c.id === onB), "a card carries notes_ms");
  await client.call("DELETE", `/desks/${idOf(b)}`);
  await assert.rejects(client.view(idOf(b)), (err) => err.status === 404);
});

test("a wrong token is refused after one re-read", live, async () => {
  const bad = new core.DeskClient({ baseUrl: `http://127.0.0.1:${PORT}`, tokenPath: path.join(dir, "no-token") });
  await assert.rejects(bad.view(), (err) => err.status === 401);
});

test("the desk is this machine's: only http on a loopback address is ever called", () => {
  for (const ok of ["http://127.0.0.1:4891", "http://localhost:4891/", "http://[::1]:4891", "http://127.0.0.2:1"]) assert.ok(core.loopbackUrl(ok), ok);
  for (const no of ["http://10.0.0.1:4891", "http://127.0.0.1.example.com:4891", "https://127.0.0.1:4891", "http://user:pw@127.0.0.1:4891", "http://example.invalid", "file:///etc/passwd", "not a url", ""]) {
    assert.equal(core.loopbackUrl(no), null, no);
  }
});

test("a desk URL off this machine is refused before anything is sent, the token included", async () => {
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-refuse-"));
  const secret = path.join(secretDir, "secret");
  fs.writeFileSync(secret, "sk-FAKE-not-real");
  // A listener on this machine's own non-loopback address, where a reachable host would be.
  const addr = Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  const seen = [];
  const srv = addr ? http.createServer((req, res) => (seen.push(req.headers.authorization ?? ""), res.end("{}"))) : null;
  if (srv) await new Promise((r) => srv.listen(PROBE_PORT, addr, r));
  try {
    for (const url of [addr ? `http://${addr}:${PROBE_PORT}` : "http://10.255.255.1:1", "http://desk.example.invalid:4891"]) {
      const c = new core.DeskClient({ baseUrl: url, tokenPath: secret });
      assert.ok(c.refusal);
      await assert.rejects(c.view(), (err) => err.refused === true && !err.unreachable, url);
      await assert.rejects(c.mailbox("/work/x"), (err) => err.refused === true, url);
      await assert.rejects(c.assign("0b0e1a1e-0000-4000-8000-00000000000f", { untracked: true }), (err) => err.refused === true, url);
    }
    assert.deepEqual(seen, [], "nothing reached the other host");
  } finally {
    if (srv) await new Promise((r) => srv.close(r));
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
});

test("a stopped desk reads as unreachable", async () => {
  // Nothing listens on the probe port's loopback side.
  const c = new core.DeskClient({ baseUrl: `http://127.0.0.1:${PROBE_PORT}`, tokenPath: "/nonexistent" });
  await assert.rejects(c.view(), (err) => err.unreachable === true);
});

// ------------------------------------------------------------ an older desk

test("the mark is read back from the session: the desk's answer to it, 200 or 400, decides nothing", async () => {
  // A desk on the probe port that answers the mark either way, and keeps it or not.
  let answer = 200;
  let keeps = true;
  const kept = new Set();
  const srv = http.createServer((req, res) => {
    const sid = /^\/sessions\/([^/]+)/.exec(req.url)?.[1];
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "POST" && req.url.endsWith("/assign")) {
        if (keeps && JSON.parse(body).client === "embarch-chat") kept.add(sid);
        res.writeHead(answer, { "content-type": "application/json" });
        return res.end(answer === 200 ? "{}" : JSON.stringify({ error: "give an issue key or a title" }));
      }
      if (req.method === "GET" && sid) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ session_id: sid, ...(keeps ? { client: kept.has(sid) ? "embarch-chat" : null } : {}), work_item: null }));
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(PROBE_PORT, "127.0.0.1", r));
  try {
    const c = new core.DeskClient({ baseUrl: `http://127.0.0.1:${PROBE_PORT}`, tokenPath: "/nonexistent" });
    const sid = (n) => `0b0e1a1e-0000-4000-8000-0000000000${n}`;
    assert.equal(await c.markClient(sid("b1")), true, "a 200 that kept it");
    answer = 400;
    assert.equal(await c.markClient(sid("b2")), true, "a 400 that kept it (desk b722b3b)");
    keeps = false;
    assert.equal(await c.markClient(sid("b3")), false, "a 400 that kept nothing (an older desk)");
    answer = 200;
    assert.equal(await c.markClient(sid("b4")), false, "a 200 that kept nothing");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/** Desk A open, desk B the window's, an item on each; a DeskService for a window in B's repo. */
async function twoDesks(c, root) {
  const repo = (n) => {
    fs.mkdirSync(path.join(root, n), { recursive: true });
    return path.join(root, n);
  };
  const idOf = (r) => r.id ?? r.desk?.id;
  const a = idOf(await c.call("POST", "/desks", { name: "Desk A", firmware_repos: [repo("fw-a")] }));
  const b = idOf(await c.call("POST", "/desks", { name: "Desk B", firmware_repos: [repo("fw-b")] }));
  await c.call("POST", "/open", { desk: a });
  const { id: onA } = await c.call("POST", "/items", { title: "ABC-211 on the open desk", desk: a });
  const { id: onB } = await c.call("POST", "/items", { title: "ABC-210 on the window's desk", desk: b });
  const chats = new core.ChatManager(() => ({ claudePath: "/bin/false", idleMs: 60000, log: () => {} }));
  const svc = new core.DeskService(() => c, chats, () => [path.join(root, "fw-b")], () => {});
  await svc.poll();
  const items = () => svc.groups.map((g) => g.item?.id).filter(Boolean);
  return { svc, onA, onB, items };
}

test("on a desk that reads ?desk=, a window on another desk shows its own desk's cards and no notice", live, async () => {
  assert.equal(await client.readsDeskParam(), true);
  const sid = "0b0e1a1e-0000-4000-8000-0000000000c1";
  assert.equal(await client.markClient(sid), true, "the mark is kept");
  assert.equal((await client.session(sid)).work_item, null, "and moves no item");
  const root = fs.mkdtempSync(path.join(dir, "two-"));
  const { svc, onA, onB, items } = await twoDesks(client, root);
  try {
    assert.ok(items().includes(onB) && !items().includes(onA), JSON.stringify(items()));
    assert.equal(svc.notice, null);
  } finally {
    svc.dispose();
  }
});

test("on a desk older than the panel: not another desk's cards, and a line to update it", { skip: haveOldDesk ? false : "EMBARCH_DESK_OLD_BIN not set" }, async () => {
  // The probe port is free by now: the old desk takes it for this test only.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-olddesk-"));
  const old = await new ScratchDesk(path.join(root, "desk"), PROBE_PORT, path.join(root, "claude"), OLD_BIN).start();
  try {
    const c = old.client;
    assert.equal(await c.readsDeskParam(), false, "it ignores ?desk=");
    assert.equal(await c.markClient("0b0e1a1e-0000-4000-8000-0000000000d1"), false, "it keeps no client");
    const { svc, onA, onB, items } = await twoDesks(c, root);
    try {
      assert.ok(!items().includes(onA), `the open desk's card is not shown as this window's: ${JSON.stringify(items())}`);
      assert.ok(!items().includes(onB), "the old desk cannot give the window's desk's cards");
      assert.match(svc.notice, /^Update embarch-desk: the running one predates this panel — only chats in this window's repos show\.$/);
      svc.noteMark(false);
      assert.match(svc.notice, /Update embarch-desk/);
    } finally {
      svc.dispose();
    }
  } finally {
    await old.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("an ended chat a card keeps shows its transcript's title, not its folder's name", () => {
  const sid = "03ac71e1-6c27-4537-8d5d-a88242b53312";
  const row = { session_id: sid, name: "fw", status: "ended", state: "ended", waiting_for: null, last_ms: 1, client: "embarch-chat", cwd: "/work/fw" };
  const live = { session_id: "s-live", name: "terminal name", state: "busy", last_ms: 2, cwd: "/work/fw" };
  const v = view([card("w1", "ABC-1", [row, live])]);
  const groups = core.buildThreads({
    view: v,
    desk: DESK,
    repos: ["/work/fw"],
    own: [],
    past: [
      { sessionId: sid, title: "Blink the widget LED", firstPrompt: "start", cwd: "/work/fw", lastMs: 1 },
      { sessionId: "s-live", title: "an older title", firstPrompt: null, cwd: "/work/fw", lastMs: 1 },
    ],
    itemOf: {},
    now: 5,
  });
  const titles = Object.fromEntries(groups[0].threads.map((t) => [t.sessionId, t.title]));
  assert.equal(titles[sid], "Blink the widget LED");
  assert.equal(titles["s-live"], "terminal name", "a live session keeps its agent's name");
});

test("cards asked for by the window's desk all belong to it", () => {
  const v = view([card("w1", "ABC-1", [], { repo_path: "/elsewhere" }), card("w2", "ABC-2", [], { repo_path: "/work/fw" })], [], OTHER);
  const scoped = core.buildThreads({ view: v, desk: DESK, repos: ["/work/fw"], own: [], past: [], itemOf: {}, now: 5, scopedTo: DESK.id });
  assert.deepEqual(scoped.map((g) => g.key), ["w1", "w2"]);
  const open = core.buildThreads({ view: v, desk: DESK, repos: ["/work/fw"], own: [], past: [], itemOf: {}, now: 5 });
  assert.deepEqual(open.map((g) => g.key), ["w2"], "the open desk's view still keeps to the window's repos");
});
