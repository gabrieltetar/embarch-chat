// Resuming a past chat here (decisions 31, 32) against a scratch desk: the
// window starts while the desk is down, so it has not resolved the chat's
// work item when the owner opens it; the desk comes back and the owner
// writes. The desk must keep the session on its item with its spans — the
// time of its open tile — and only learn that this panel runs it now.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ScratchDesk, haveDesk } from "./scratch-desk.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const skip = haveDesk ? false : "EMBARCH_DESK_BIN not set";

const mock = require("./vscode-mock.cjs");
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? mock.vscode : load.call(this, request, ...rest);
};

const FAKE = path.join(here, "fake-claude.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 10000, what = "condition") => {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};

let dir, desk, ext, context, folder, threadsView, chatView, item;
const S = crypto.randomUUID();
let tileBefore = 0;

const tileSeconds = async () => {
  const v = await desk.client.view();
  return v.cards.find((c) => c.id === item)?.tiles.find((t) => t.date === v.today)?.seconds ?? 0;
};
const lastSnapshot = () => [...chatView.webview.posted].reverse().find((m) => m.t === "snapshot");
const lastGroups = () => [...threadsView.webview.posted].reverse().find((m) => m.t === "groups");

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-resume-"));
  folder = path.join(dir, "work");
  fs.mkdirSync(folder);
  const claude = path.join(dir, "claude");
  desk = await new ScratchDesk(path.join(dir, "desk"), 4984, claude).start();
  ({ id: item } = await desk.client.call("POST", "/items", { title: "ABC-123 seeded item", desk: "none" }));
  // A terminal session on the item, with two seconds of time on today's tile.
  const hook = (name, extra = {}) => desk.client.call("POST", "/hook", { hook_event_name: name, session_id: S, cwd: folder, ...extra });
  await hook("SessionStart");
  await desk.client.call("POST", `/sessions/${S}/assign`, { item_id: item });
  await hook("UserPromptSubmit", { prompt: "go" });
  await sleep(2200);
  await hook("Stop");
  await hook("SessionEnd");
  tileBefore = await tileSeconds();
  // Its transcript, as Claude Code writes it.
  const pdir = path.join(claude, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(pdir, { recursive: true });
  const ts = new Date(Date.now() - 20 * 60_000).toISOString();
  const lines = [
    { type: "user", cwd: folder, sessionId: S, timestamp: ts, uuid: crypto.randomUUID(), message: { role: "user", content: "start" } },
    { type: "assistant", cwd: folder, sessionId: S, timestamp: ts, uuid: crypto.randomUUID(), message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "ai-title", aiTitle: "Terminal work on the widget", sessionId: S },
  ];
  fs.writeFileSync(path.join(pdir, `${S}.jsonl`), lines.map((o) => JSON.stringify(o)).join("\n") + "\n");

  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.FAKE_CLAUDE_ARGS_LOG = path.join(dir, "args.jsonl");
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "basic.jsonl");
  fs.chmodSync(FAKE, 0o755);
  Object.assign(mock.state.config, {
    "embarchChat.claudePath": FAKE,
    "embarchChat.deskUrl": desk.url,
    "embarchChat.deskTokenPath": desk.tokenPath,
    "embarchChat.assistant": false,
    "embarchUi.port": 1,
  });
  mock.state.folders = [folder];
  // The window starts while the desk is down (VS Code before the desk, or a desk restart).
  await desk.stop();
  ext = require("../dist/extension.js");
  context = { subscriptions: [], extensionUri: mock.vscode.Uri.file(root) };
  ext.activate(context);
  threadsView = new mock.FakeView();
  chatView = new mock.FakeView();
  mock.state.providers.get("embarchChat.threads").provider.resolveWebviewView(threadsView);
  mock.state.providers.get("embarchChat.chat").provider.resolveWebviewView(chatView);
  threadsView.webview.fromPage({ t: "ready" });
  chatView.webview.fromPage({ t: "ready" });
});

after(async () => {
  if (ext) ext.deactivate();
  for (const d of context?.subscriptions ?? []) d.dispose?.();
  await desk?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.FAKE_CLAUDE_ARGS_LOG;
  Module._load = load;
});

test("a past chat opened while the desk is down, written to once it is back, keeps its item and its time", { skip }, async () => {
  assert.ok(tileBefore >= 2, `the seeded tile has its time (${tileBefore} s)`);
  const g = await waitFor(() => lastGroups()?.groups.find((x) => x.threads.some((t) => t.sessionId === S)), 8000, "the past chat in the list");
  assert.equal(g.key, "untracked", "the window has not resolved its item");
  threadsView.webview.fromPage({ t: "open", sid: S });
  const snap = await waitFor(() => lastSnapshot()?.state.sessionId === S && lastSnapshot(), 3000, "the opened chat");
  assert.equal(snap.view.resumable, true);
  assert.equal(snap.header.untracked, true);

  // The desk comes back; the owner writes before the window polls it again.
  await desk.start();
  chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
  await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "result"), 8000, "the resumed turn");
  const argv = fs
    .readFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).argv)
    .filter((a) => !a.includes("--version") && a[0] !== "agents");
  assert.ok(argv.at(-1).includes(`--resume=${S}`), "resumed by its id");

  const s = await waitFor(async () => {
    const x = await desk.client.session(S);
    return x.client === "embarch-chat" && x;
  }, 5000, "the desk to hear this panel runs it");
  assert.equal(s.untracked, false, "not untracked");
  assert.equal(s.work_item?.id, item, "still on its item");
  assert.equal(await tileSeconds(), tileBefore, "its time is kept");

  // And the header learns the item.
  await mock.state.commands.get("embarchChat.refresh")();
  const h = await waitFor(() => {
    const m = [...chatView.webview.posted].reverse().find((x) => x.t === "header" || x.t === "snapshot");
    return m?.header?.itemId === item && m.header;
  }, 5000, "the header on its item");
  assert.equal(h.untracked, false);
});
