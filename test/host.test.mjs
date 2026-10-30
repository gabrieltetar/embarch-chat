// The built extension (dist/extension.js), activated in plain node against
// a mocked `vscode` (vscode-mock.cjs), a scratch embarch-desk
// (EMBARCH_DESK_BIN) and the fake `claude` replaying recorded sessions: a
// chat started from the + is assigned on the desk before claude runs, its
// stream reaches the chat webview, Start work's mailbox entry starts a chat
// with its prompt, and a waiting chat shows as a count. The assistant's
// Haiku calls are replayed too (test/fixtures/haiku/), and the owner's
// past prompts come from a scratch CLAUDE_CONFIG_DIR, never the real one.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT_BASE, ScratchDesk, haveDesk } from "./scratch-desk.mjs";
import { INDEX, VAGUE } from "./refs-index.mjs";

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

const PORT = PORT_BASE + 2;
const FAKE = path.join(here, "fake-claude.mjs");
const FAKE_PROMPTU = path.join(here, "fake-promptu.mjs");
let dir, desk, ext, client, folder, context;
const core = require("../test-out/core.js");

const waitFor = async (pred, ms = 10000, what = "condition") => {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

let threadsView, chatView;

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-host-"));
  fs.mkdirSync(path.join(dir, "work"));
  folder = path.join(dir, "work");
  // A scratch Claude config: one transcript with one prompt of the "owner's".
  const projects = path.join(dir, "claude", "projects", "-work-x");
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, "33333333-0000-4000-8000-000000000001.jsonl"), JSON.stringify({ type: "user", origin: { kind: "human" }, timestamp: new Date().toISOString(), message: { role: "user", content: "continue with the widget" } }) + "\n");
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
  process.env.FAKE_CLAUDE_ARGS_LOG = path.join(dir, "args.jsonl");
  desk = await new ScratchDesk(path.join(dir, "desk"), PORT, path.join(dir, "claude")).start();
  client = desk.client;

  fs.chmodSync(FAKE, 0o755);
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "basic.jsonl");
  Object.assign(mock.state.config, {
    "embarchChat.claudePath": FAKE,
    "embarchChat.deskUrl": desk.url,
    "embarchChat.deskTokenPath": desk.tokenPath,
    "embarchUi.port": 1,
    // These tests drive the sidebar's chat; chats in tabs, the default, have their own (decision 92).
    "embarchChat.chatLocation": "sidebar",
    // Promptu is not here until a test says so: never the owner's own binary (96).
    "embarchChat.promptuPath": path.join(dir, "no-promptu"),
  });
  process.env.FAKE_PROMPTU_DIR = path.join(dir, "promptu");
  fs.chmodSync(FAKE_PROMPTU, 0o755);
  mock.state.folders = [folder];
  ext = require("../dist/extension.js");
  context = { subscriptions: [], extensionUri: mock.vscode.Uri.file(root), workspaceState: new mock.Memento(), globalState: new mock.Memento() };
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
  delete process.env.FAKE_PROMPTU_DIR;
  Module._load = load;
});

const lastGroups = () => [...threadsView.webview.posted].reverse().find((m) => m.t === "groups");
const lastSnapshot = (v = chatView) => [...v.webview.posted].reverse().find((m) => m.t === "snapshot");

test("activation registers the chat's and the launcher's commands, and the views", { skip }, () => {
  for (const c of ["embarchChat.newChat", "embarchChat.openWaiting", "embarchChat.refresh", "embarchUi.start", "embarchUi.stop", "embarchUi.openInBrowser"]) {
    assert.ok(mock.state.commands.has(c), c);
  }
  assert.ok(threadsView.webview.html.includes("list.js"));
  assert.ok(chatView.webview.html.includes("chat.js"));
  assert.ok(!chatView.webview.html.includes(fs.readFileSync(desk.tokenPath, "utf8").trim()), "no token in the page");
  assert.equal(chatView.webview.posted.at(-1).t, "empty");
});

test("the status bar's right end holds EmbArch Chat's own new chat, in the mark", { skip }, () => {
  const entry = mock.state.statusItems.find((s) => s.id === "embarchChat.entry");
  assert.ok(entry?.visible, "always shown");
  assert.equal(entry.alignment, mock.vscode.StatusBarAlignment.Right);
  assert.equal(entry.text, "$(embarch-mark) EmbArch");
  assert.equal(entry.tooltip, "New EmbArch chat");
  assert.equal(entry.command, "embarchChat.newChat");
  // The icon is the extension's own, from a font it ships (decision 54).
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const icon = manifest.contributes.icons["embarch-mark"].default;
  assert.equal(icon.fontCharacter, "\\E000");
  assert.ok(fs.statSync(path.join(root, icon.fontPath)).size > 0, icon.fontPath);
  for (const c of Object.values(manifest.contributes.viewsContainers).flat()) assert.ok(fs.existsSync(path.join(root, c.icon)), c.icon);
  // The count stays where it was: the left, and only while something waits.
  const count = mock.state.statusItems.find((s) => s.command === "embarchChat.openWaiting");
  assert.equal(count.alignment, mock.vscode.StatusBarAlignment.Left);
});

test("the + picks a work item, assigns the session on the desk, and the chat runs", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-123 blink the widget", desk: "none" });
  await mock.state.commands.get("embarchChat.refresh")();
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("ABC-123 blink the widget"));
  await mock.state.commands.get("embarchChat.newChat")();
  const snap = await waitFor(() => lastSnapshot()?.state.sessionId && lastSnapshot(), 5000, "the new chat's snapshot");
  const sid = snap.state.sessionId;
  assert.equal(snap.header.itemId, item);
  assert.equal(snap.header.title, "ABC-123 blink the widget");
  assert.ok(snap.view.ours);
  // Assigned before claude starts (decision 10), as this panel's.
  const v = await client.view();
  const row = v.sessions.find((s) => s.session_id === sid);
  assert.equal(row.client, "embarch-chat");
  assert.equal(row.item_id, item);
  // The owner writes; the fake claude replays a real turn into the webview.
  chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
  await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's result");
  const kinds = new Set(chatView.webview.posted.filter((m) => m.t === "event").map((m) => m.e.type));
  for (const k of ["_sent", "_process", "system", "stream_event", "assistant", "user", "result"]) assert.ok(kinds.has(k), k);
  // The list shows it under its item, as this window's.
  await waitFor(() => lastGroups()?.groups.some((g) => g.item?.id === item && g.threads.some((t) => t.sessionId === sid && t.ours)), 5000, "the thread in the list");
});

test("Start work's mailbox entry starts a chat on the item; with Promptu not installed its prompt waits in the draft, unsent (11 reversed)", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-124 from the Desk", desk: "none" });
  const before = chatView.webview.posted.length;
  // Start work leaves the entry server-side; the test seeds the desk's store as it would.
  const prompt = "Run the bash command `echo hello-from-bash` and then reply with just: done";
  const id = await desk.withStart({ item_id: item, folder, prompt });
  const snap = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "snapshot" && m.header?.itemId === item), 10000, "the mailbox chat");
  const d = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "draft" && m.sid === snap.state.sessionId), 5000, "the draft");
  assert.equal(d.text, prompt);
  assert.ok(snap.view.ours);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!chatView.webview.posted.slice(before).some((m) => m.t === "event" && m.e.type === "_sent"), "nothing sent");
  assert.equal(await client.take(id), null, "taken once");
});

test("a chat waiting on the owner off screen shows as a count, and the click opens it", { skip }, async () => {
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "deny.jsonl");
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("Untracked"));
  await mock.state.commands.get("embarchChat.newChat")();
  const sid = await waitFor(() => {
    const s = lastSnapshot();
    return s && s.header?.untracked && s.state.sessionId;
  }, 5000, "the untracked chat");
  chatView.webview.fromPage({ t: "send", text: "touch it" });
  await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the permission prompt");
  // On screen, it counts for nothing (decision 35): the owner is looking at it.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!mock.state.statusItems.some((s) => s.visible && /waiting/.test(s.text)), "no count for the chat on screen");
  assert.equal(threadsView.badge, undefined);
  // The sidebar hides: now it is waiting off screen.
  chatView.visible = false;
  chatView.em.emit("vis");
  const item = await waitFor(() => mock.state.statusItems.find((s) => s.visible && /1 waiting/.test(s.text)), 5000, "the status bar count");
  assert.equal(item.command, "embarchChat.openWaiting");
  assert.equal(threadsView.badge?.value, 1);
  await mock.state.commands.get("embarchChat.openWaiting")();
  assert.equal(lastSnapshot().state.sessionId, sid);
  chatView.visible = true;
  chatView.em.emit("vis");
  await waitFor(() => !mock.state.statusItems.some((s) => s.visible && /waiting/.test(s.text)), 5000, "the count to go once it shows");
  const pending = lastSnapshot().state.pending[0];
  chatView.webview.fromPage({ t: "deny", requestId: pending.requestId, message: "no" });
  await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "_answered"), 3000, "the answer");
});

test("a title is text in the page, whatever it holds", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-126 Fix </title><plaintext> parsing", desk: "none" });
  await mock.state.commands.get("embarchChat.refresh")();
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("ABC-126"));
  await mock.state.commands.get("embarchChat.newChat")();
  await waitFor(() => lastSnapshot()?.header?.itemId === item, 5000, "the chat on the item");
  await mock.state.commands.get("embarchChat.openInEditor")();
  const panel = mock.state.panels.at(-1);
  assert.ok(!panel.webview.html.includes("<plaintext>"), "escaped");
  assert.match(panel.webview.html, /<title>ABC-126 Fix &lt;\/title&gt;&lt;plaintext&gt; parsing<\/title>/);
  panel.dispose();
});

test("a start the desk refuses still opens a chat, with Start work's prompt in its draft", { skip }, async () => {
  const before = chatView.webview.posted.length;
  const prompt = "Read the issue and start on it.";
  await desk.withStart({ item_id: "w-no-such-item", folder, prompt });
  const d = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "draft"), 10000, "the draft");
  assert.equal(d.text, prompt);
  const snap = chatView.webview.posted.slice(before).reverse().find((m) => m.t === "snapshot");
  assert.equal(snap.state.sessionId, d.sid);
  assert.ok(snap.view.ours);
  assert.ok(!chatView.webview.posted.slice(before).some((m) => m.t === "event" && m.e.type === "_sent"), "nothing sent");
  assert.ok(mock.state.messages.some(([k, m]) => k === "error" && /prompt waits in the draft/.test(m)));
  const s = await waitFor(() => desk.client.session(d.sid).catch(() => null), 5000, "the desk to know the chat");
  assert.equal(s.client, "embarch-chat", "marked as this panel's");
});

test("an editor tab shows the same chat", { skip }, async () => {
  const sid = lastSnapshot().state.sessionId;
  await mock.state.commands.get("embarchChat.openInEditor")();
  const panel = mock.state.panels.at(-1);
  panel.webview.fromPage({ t: "ready" });
  const snap = await waitFor(() => panel.webview.posted.find((m) => m.t === "snapshot"), 3000, "the tab's snapshot");
  assert.equal(snap.state.sessionId, sid);
  assert.equal(snap.view.inEditor, true);
  // Its tab wears the mark, a file per theme (decision 54).
  for (const theme of ["light", "dark"]) assert.ok(fs.existsSync(panel.iconPath[theme].fsPath), theme);
});

test("a terminal session in this folder lists read-only, and Jump asks Claude Code for it", { skip }, async () => {
  const sid = "7e7e7e7e-0000-4000-8000-00000000abcd";
  await client.call("POST", "/hook", { hook_event_name: "SessionStart", session_id: sid, cwd: folder });
  await client.call("POST", "/hook", { hook_event_name: "Notification", session_id: sid, cwd: folder, notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  await mock.state.commands.get("embarchChat.refresh")();
  const g = await waitFor(() => lastGroups()?.groups.find((x) => x.threads.some((t) => t.sessionId === sid)), 5000, "the terminal session in the list");
  const t = g.threads.find((x) => x.sessionId === sid);
  assert.equal(t.ours, false);
  assert.equal(t.live, true);
  threadsView.webview.fromPage({ t: "open", sid });
  const snap = await waitFor(() => {
    const s = lastSnapshot();
    return s?.state.sessionId === sid && s;
  }, 3000, "the read-only view");
  assert.equal(snap.view.readOnly, true);
  assert.equal(snap.view.ours, false);
  chatView.webview.fromPage({ t: "jump" });
  await waitFor(() => mock.state.external.some((u) => u.includes(`session=${sid}`)), 5000, "Jump to Claude Code's panel");
  chatView.webview.fromPage({ t: "send", text: "should not run" });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "_sent" && m.e.text === "should not run"), "a live foreign thread takes no input here");
});

// ------------------------------------------------------------ the assistant and the library

const posted = (pred, v = chatView) => [...v.webview.posted].reverse().find(pred);
const calls = () => fs.readFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const haikuAnswer = (name) =>
  core.parseObject(
    fs
      .readFileSync(path.join(here, "fixtures", "haiku", `${name}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .find((e) => e.o.type === "result").o.result,
  );

async function startUntracked(fixture) {
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", `${fixture}.jsonl`);
  const before = lastSnapshot()?.state.sessionId;
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("Untracked"));
  await mock.state.commands.get("embarchChat.newChat")();
  return waitFor(() => {
    const s = lastSnapshot();
    return s && s.state.sessionId !== before && s.header?.untracked && s.state.sessionId;
  }, 5000, "the new chat");
}

test("the chat page gets the library and the owner's past prompts", { skip }, async () => {
  const lib = await waitFor(() => posted((m) => m.t === "library"), 3000, "the library");
  assert.deepEqual(lib.entries.map((e) => e.name).sort(), ["build-flash-verify", "embarch-claude-md", "embarch-permissions"]);
  assert.equal(lib.assistant, true);
  const pr = await waitFor(() => posted((m) => m.t === "prompts" && m.items.length), 8000, "the past prompts");
  assert.deepEqual(pr.items.map((p) => [p.text, p.n]), [["continue with the widget", 1]]);
});

test("after a new chat's first turn on screen: the CLI's guess with Haiku's chips, and a name", { skip }, async () => {
  const sid = await startUntracked("suggest");
  const before = calls().length;
  chatView.webview.fromPage({ t: "send", text: "I am setting up a small Node project in this folder. Run `echo setup` with bash, then suggest what I should do first, in two sentences." });
  const chips = await waitFor(() => {
    const m = posted((x) => x.t === "chips" && x.sid === sid);
    return m && m.chips.some((c) => c.source === "cli") && m.chips.some((c) => c.source === "haiku") && m.chips;
  }, 8000, "the chips");
  assert.equal(chips[0].text, "npm init -y", "the CLI's own guess among them");
  assert.ok(chips.length >= 3 && chips.length <= 4);
  const name = core.parseTurn(haikuAnswer("turn")).name;
  await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_title" && m.e.title === name), 5000, "the name");
  const turn = calls().slice(before).filter((c) => c.task === "turn");
  assert.equal(turn.length, 1, "one call for chips and name together");
  assert.equal(turn[0].env.EMBARCH_DESK_INTERNAL, "1");
  assert.ok(turn[0].prompt.includes('"npm init -y"') || !turn[0].prompt.includes("Claude Code itself guessed"), "the CLI's guess, when it came first, is in the prompt");
  // The next message spends them.
  chatView.webview.fromPage({ t: "send", text: "Now run `ls` and tell me how many files there are." });
  await waitFor(() => posted((m) => m.t === "chips" && m.sid === sid)?.chips.length === 0, 3000, "the chips cleared");
});

test("the page asks for ghost text and cards; the host streams Haiku's answers back", { skip }, async () => {
  const n = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "assist", kind: "ghost", text: "now flash it on the", seq: 701 });
  const done = await waitFor(() => posted((m) => m.t === "ghost" && m.seq === 701 && m.done), 5000, "the ghost text");
  const partial = chatView.webview.posted.slice(n).filter((m) => m.t === "ghost" && m.seq === 701 && !m.done);
  assert.ok(partial.length >= 2, "streamed");
  assert.equal(done.text, haikuAnswer("ghost").completion);
  chatView.webview.fromPage({ t: "assist", kind: "cards", text: "fix the flash thing", seq: 702 });
  const c = await waitFor(() => posted((m) => m.t === "cards" && m.seq === 702), 5000, "the cards");
  // The recorded answer is all missing-context and improvement cards: Promptu's job now, so none comes (97).
  assert.deepEqual(c.cards, []);
  assert.ok(calls().some((x) => x.task === "cards"), "the cards call ran");
  const ghostCall = calls().filter((x) => x.task === "ghost").at(-1);
  for (const s of ["<draft>now flash it on the</draft>", "<claude_last_reply>", "<library_commands>"]) assert.ok(ghostCall.prompt.includes(s), s);
});

test("the compact card's draft: the host sends its /compact line, then the rest after the compaction", { skip }, async () => {
  await startUntracked("compact");
  const m0 = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "send", text: "@note.txt what is the secret? One word." });
  await waitFor(() => chatView.webview.posted.slice(m0).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the first turn");
  const n = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "send", text: "/compact focus on: the secret word in note.txt\nWhat was the secret word? One word." });
  await waitFor(() => chatView.webview.posted.slice(n).filter((m) => m.t === "event" && m.e.type === "result").length >= 2, 8000, "the compaction and the turn after it");
  const sent = chatView.webview.posted.slice(n).filter((m) => m.t === "event" && m.e.type === "_sent").map((m) => [m.e.text, !!m.e.held]);
  assert.deepEqual(sent, [
    ["/compact focus on: the secret word in note.txt", false],
    ["What was the secret word? One word.", true],
  ]);
  assert.ok(chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.subtype === "compact_boundary"));
});

test("a /compact's rest the CLI took is one of the chat's messages: its dry run reaches the CLI, and a fork from it is no refusal (review r6 L1)", { skip }, async () => {
  const dry = { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
  process.env.FAKE_CLAUDE_DRY_RUN = JSON.stringify(dry);
  try {
    await startUntracked("compact");
    const m0 = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "@note.txt what is the secret? One word." });
    await waitFor(() => chatView.webview.posted.slice(m0).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the first turn");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "/compact focus on: the secret word in note.txt\nWhat was the secret word? One word." });
    await waitFor(() => chatView.webview.posted.slice(n).filter((m) => m.t === "event" && m.e.type === "result").length >= 2, 8000, "the compaction and the turn after it");
    // The rest as the chat holds it: under the uuid the CLI's echo gave it.
    const n0 = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "ready" });
    const snap = await waitFor(() => chatView.webview.posted.slice(n0).find((m) => m.t === "snapshot"), 3000, "a snapshot");
    const rest = Object.values(snap.state.entries).find((e) => e.kind === "user" && e.text === "What was the secret word? One word.");
    chatView.webview.fromPage({ t: "rewindCheck", uuid: rest.uuid });
    const check = await waitFor(() => posted((m) => m.t === "rewindCheck" && m.uuid === rest.uuid), 5000, "the dry run's answer");
    assert.deepEqual(check.result, dry, "the CLI's dry run, not a refusal");
    const n1 = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "rewind", uuid: rest.uuid, restore: "conversation" });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(chatView.webview.posted.slice(n1).filter((m) => m.t === "event" && m.e.type === "_note" && /^Not rewound or forked/.test(m.e.text)), [], "not refused");
  } finally {
    delete process.env.FAKE_CLAUDE_DRY_RUN;
  }
});

test("a turn that wrote a handoff offers a fresh chat; the chip starts one on the same item with it", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-125 hand it over", desk: "none" });
  await mock.state.commands.get("embarchChat.refresh")();
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "handoff.jsonl");
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("ABC-125 hand it over"));
  await mock.state.commands.get("embarchChat.newChat")();
  const sid = await waitFor(() => lastSnapshot()?.header?.itemId === item && lastSnapshot().state.sessionId, 5000, "the chat on the item");
  chatView.webview.fromPage({ t: "send", text: "Read note.txt and tell me the secret in one word." });
  await waitFor(() => posted((m) => m.t === "chips" && m.sid === sid && m.chips.length), 8000, "the first turn's chips");
  chatView.webview.fromPage({ t: "send", text: core.handoffRequest("Next: write the secret into a file named answer.txt."), handoff: true });
  const chips = await waitFor(() => posted((m) => m.t === "chips" && m.sid === sid && m.chips.some((c) => c.action === "freshChat"))?.chips, 8000, "the handoff chip");
  assert.equal(chips[0].text, "Fresh chat with this handoff");
  chatView.webview.fromPage({ t: "freshChat" });
  const snap = await waitFor(() => {
    const s = lastSnapshot();
    return s && s.state.sessionId !== sid && s.header?.itemId === item && s;
  }, 5000, "the fresh chat");
  const first = await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_sent"), 3000, "its first message");
  assert.match(first.e.text, /^# Handoff/);
  assert.ok(!first.e.text.includes("```"));
  const v = await client.view();
  assert.equal(v.sessions.find((x) => x.session_id === snap.state.sessionId)?.item_id, item, "on the same work item");
  assert.ok(lastGroups().groups.some((g) => g.threads.some((t) => t.sessionId === sid)), "the old one stays in the list");
  // Back to the old chat: its chips without the spent one.
  const n = chatView.webview.posted.length;
  threadsView.webview.fromPage({ t: "open", sid });
  const back = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "chips" && m.sid === sid), 3000, "the old chat's chips");
  assert.ok(!back.chips.some((c) => c.action === "freshChat"), "its chip is spent");
});

test("a link opens once, in the browser, and only http(s); a URI is never opened as a file", { skip }, async () => {
  assert.ok(lastSnapshot()?.state.sessionId, "a chat on screen");
  fs.mkdirSync(path.join(folder, "src"), { recursive: true });
  fs.writeFileSync(path.join(folder, "src", "main.c"), "int main(void) { return 0; }\n");
  mock.state.external.length = 0;
  const opens = () => mock.state.executedArgs.filter(([id]) => id === "vscode.open");
  const before = opens().length;
  for (const url of ["vscode://anthropic.claude-code/open?prompt=hi", "mailto:someone@example.com", "command:workbench.action.terminal.new", "file:///etc/hostname", "javascript:alert(1)"]) {
    chatView.webview.fromPage({ t: "openLink", url });
    chatView.webview.fromPage({ t: "openFile", path: url });
  }
  chatView.webview.fromPage({ t: "openLink", url: "https://example.com/docs" });
  chatView.webview.fromPage({ t: "openFile", path: "src/main.c" });
  await waitFor(() => mock.state.external.length && opens().length > before, 3000, "the two that open");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(mock.state.external, ["https://example.com/docs"]);
  const got = opens().slice(before);
  assert.equal(got.length, 1);
  assert.equal(got[0][1].fsPath, path.join(folder, "src", "main.c"));
  // The sidebar's chat has no group of its own: the active one (decision 92), a tab of its own.
  assert.deepEqual([got[0][2].viewColumn, got[0][2].preview], [mock.vscode.ViewColumn.Active, false]);
});

test("a file link finds what Claude meant: its lines, a bare name from the folder, a choice among several, a message for none (decision 93)", { skip }, async () => {
  assert.ok(lastSnapshot()?.state.sessionId, "a chat on screen");
  for (const d of ["apps/one/src", "apps/two/src"]) fs.mkdirSync(path.join(folder, d), { recursive: true });
  fs.writeFileSync(path.join(folder, "apps/one/src/hal.c"), "");
  fs.writeFileSync(path.join(folder, "apps/one/src/util.c"), "");
  fs.writeFileSync(path.join(folder, "apps/two/src/util.c"), "");
  const opens = () => mock.state.executedArgs.filter(([id]) => id === "vscode.open");
  const open = async (p) => {
    const n = opens().length;
    const m = mock.state.messages.length;
    chatView.webview.fromPage({ t: "openFile", path: p });
    await waitFor(() => opens().length > n || mock.state.messages.length > m, 3000, `${p} to open or say why not`);
    return opens().length > n ? opens().at(-1) : null;
  };
  const patterns = [];
  mock.state.findFiles = async (pat) => {
    patterns.push(pat.pattern);
    const name = pat.pattern.replace(/^\*\*\//, "");
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith(`/${name}`)) hits.push(mock.vscode.Uri.file(f));
      }
    };
    walk(pat.base.fsPath);
    return hits;
  };
  try {
    // A line range is selected through its last line; `#L` is GitHub's way of writing one.
    const ranged = await open("src/main.c#L1-L3");
    assert.equal(ranged[1].fsPath, path.join(folder, "src", "main.c"));
    const sel = (o) => [o.selection.start, o.selection.end].map((p) => [p.line, p.character]);
    assert.deepEqual(sel(ranged[2]), [[0, 0], [3, 0]]);
    const at = await open("src/main.c:2:5");
    assert.deepEqual(sel(at[2]), [[1, 4], [1, 4]]);
    // A bare name the folder has once.
    const hal = await open("hal.c");
    assert.equal(hal[1].fsPath, path.join(folder, "apps/one/src/hal.c"));
    assert.equal(patterns.at(-1), "**/hal.c");
    // Two of them: the owner picks, nearest the folder's order.
    let offered = null;
    mock.state.quickPick = async (items) => ((offered = items.map((i) => i.label)), items[1]);
    const util = await open("util.c");
    assert.deepEqual(offered, ["apps/one/src/util.c", "apps/two/src/util.c"]);
    assert.equal(util[1].fsPath, path.join(folder, "apps/two/src/util.c"));
    // None: a message names it, nothing opens.
    const m = mock.state.messages.length;
    assert.equal(await open("nowhere.c"), null);
    assert.match(mock.state.messages[m][1], /No file nowhere\.c under /);
    // A folder shows in the Explorer.
    const n = mock.state.executedArgs.length;
    chatView.webview.fromPage({ t: "openFile", path: "apps/one" });
    const reveal = await waitFor(() => mock.state.executedArgs.slice(n).find(([id]) => id === "revealInExplorer"), 3000, "the Explorer");
    assert.equal(reveal[1].fsPath, path.join(folder, "apps/one"));
  } finally {
    mock.state.findFiles = async () => [];
    mock.state.quickPick = async () => undefined;
  }
});

test("an open file with unsaved changes is saved before Claude reads it — only under the chat's folder or the window's (decision 61; review r4 L1)", { skip }, async () => {
  const saved = [];
  const doc = {
    uri: mock.vscode.Uri.file("/work/rec/autosave/note.txt"),
    isDirty: true,
    save: async () => {
      saved.push(doc.uri.fsPath);
      doc.isDirty = false;
      return true;
    },
  };
  // Open but unchanged, and changed but another file: neither is saved.
  const clean = { uri: mock.vscode.Uri.file("/work/rec/autosave/other.txt"), isDirty: false, save: async () => saved.push("clean") };
  const other = { uri: mock.vscode.Uri.file("/work/rec/elsewhere/note.txt"), isDirty: true, save: async () => saved.push("other") };
  mock.state.textDocuments.push(doc, clean, other);
  /** One recorded turn: Read note.txt, then an Edit that asks; what was saved by the time it asks. */
  const turn = async () => {
    await startUntracked("autosave");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Read note.txt, then use the Edit tool to change MANGO to KIWI in it. Then reply with just: done" });
    const ask = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the Edit's permission prompt");
    const by = [...saved];
    chatView.webview.fromPage({ t: "allow", requestId: ask.e.request_id });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's end");
    return by;
  };
  try {
    // The recording's file is under neither the chat's folder nor the window's, as ~/.claude/settings.json is:
    // the hook runs before the permission check, so a Read the owner would refuse must not have saved it.
    assert.deepEqual(await turn(), [], "nothing saved outside");
    assert.ok(doc.isDirty);
    assert.ok(mock.state.output.some((l) => l.includes("autosave: /work/rec/autosave/note.txt is outside the chat's folder and the window's; not saved before Read")));
    // A folder of the window's: saved, once, before the Read.
    mock.state.folders.push("/work/rec");
    assert.deepEqual(await turn(), ["/work/rec/autosave/note.txt"], "saved once, before the Read");
    assert.ok(mock.state.output.some((l) => l.includes("autosave: /work/rec/autosave/note.txt saved before Read")));
  } finally {
    mock.state.folders = [folder];
    mock.state.textDocuments.length = 0;
  }
});

test("with the diagnostics tool on, a chat's Claude reads the Problems panel through the panel's own MCP server (decision 65)", { skip }, async () => {
  const input = path.join(dir, "input-diagnostics.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = input;
  mock.state.config["embarchChat.diagnosticsTool"] = true;
  const range = { start: { line: 11, character: 14 }, end: { line: 11, character: 15 } };
  mock.state.diagnostics.push([mock.vscode.Uri.file("/work/rec/diagnostics/src/main.c"), [{ message: "expected ';' before '}' token", severity: 0, range, source: "gcc" }]]);
  mock.state.diagnostics.push([mock.vscode.Uri.file("/work/rec/diagnostics/src/clean.c"), []]);
  try {
    await startUntracked("diagnostics");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Read note.txt, then call the getDiagnostics tool with no arguments, then reply in one line: the secret word, and how many errors and how many warnings it reports." });
    const ask = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the tool's permission prompt");
    chatView.webview.fromPage({ t: "allow", requestId: ask.e.request_id });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's end");
    const sent = fs.readFileSync(input, "utf8").trim().split("\n").map((l) => JSON.parse(l).o);
    const init = sent.find((o) => o.type === "control_request" && o.request.subtype === "initialize").request;
    assert.deepEqual(init.sdkMcpServers, ["embarch-chat"]);
    assert.ok(init.hooks.PreToolUse, "autosave's hook beside it");
    assert.deepEqual(init.supportedDialogKinds, core.DIALOG_KINDS, "and the dialogs, in the one initialize (66)");
    const call = sent.map((o) => o.response?.response?.mcp_response?.result?.content?.[0]?.text).find(Boolean);
    assert.deepEqual(JSON.parse(call), [{ uri: "file:/work/rec/diagnostics/src/main.c", diagnostics: [{ message: "expected ';' before '}' token", severity: "Error", range, source: "gcc" }] }], "VS Code's own diagnostics, the clean file left out");
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
    delete mock.state.config["embarchChat.diagnosticsTool"];
    mock.state.diagnostics.length = 0;
  }
});

test("a tool's whole input or output opens in a read-only editor tab, in a language that suits it (decision 62)", { skip }, async () => {
  await startUntracked("basic");
  const n = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
  await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn");
  const call = chatView.webview.posted.slice(n).find((m) => m.t === "event" && m.e.type === "assistant" && m.e.message.content.some((b) => b.type === "tool_use"));
  const toolId = call.e.message.content.find((b) => b.type === "tool_use").id;
  const shown = mock.state.shown.length;
  chatView.webview.fromPage({ t: "openContent", toolId, part: "output" });
  chatView.webview.fromPage({ t: "openContent", toolId, part: "input" });
  await waitFor(() => mock.state.shown.length === shown + 2, 3000, "two tabs");
  const [out, inp] = mock.state.shown.slice(shown);
  assert.equal(out.doc.uri.scheme, "embarch-chat-content", "a virtual document: closing it asks nothing");
  assert.ok(out.doc.uri.path.endsWith("/Bash output.log"));
  assert.equal(out.doc.languageId, "log");
  assert.equal(out.doc.getText(), "hello-from-bash");
  assert.equal(out.opts.preview, true);
  assert.equal(inp.doc.languageId, "shellscript");
  assert.equal(inp.doc.getText(), "echo hello-from-bash");
  // Only a tool of this chat's, by id.
  chatView.webview.fromPage({ t: "openContent", toolId: "toolu_not_here", part: "output" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(mock.state.shown.length, shown + 2);
});

test("a pending Edit's diff tab rejects a change; Accept sends only the kept one (decision 64)", { skip }, async () => {
  // The recorded Edit, on a file of this test's own.
  const work = fs.mkdtempSync(path.join(dir, "hunks-"));
  fs.writeFileSync(path.join(work, "config.txt"), "alpha=1\nbeta=2\ngamma=3\ndelta=4\n");
  const fixture = path.join(dir, "hunks.jsonl");
  fs.writeFileSync(fixture, fs.readFileSync(path.join(here, "fixtures", "wire", "hunks.jsonl"), "utf8").split("/work/rec/hunks").join(work));
  const input = path.join(dir, "input-hunks.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = input;
  try {
    await startUntracked("basic");
    process.env.FAKE_CLAUDE_FIXTURE = fixture;
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Read config.txt, then make ONE call to the Edit tool on it that changes alpha=1 to alpha=10 and delta=4 to delta=40 together, its old_string spanning from alpha=1 through delta=4. Then reply with just: done" });
    const ask = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the Edit's permission prompt");
    chatView.webview.fromPage({ t: "openDiff", requestId: ask.e.request_id });
    const [, left, right, title] = await waitFor(() => mock.state.executedArgs.find((a) => a[0] === "vscode.diff" && a[2]?.scheme === "embarch-chat-proposal"), 3000, "the diff tab");
    assert.match(title, /config\.txt — Claude's proposed change/);
    const docs = mock.state.contentProviders.get("embarch-chat-proposal");
    assert.equal(docs.provideTextDocumentContent(left), "alpha=1\nbeta=2\ngamma=3\ndelta=4\n");
    assert.equal(docs.provideTextDocumentContent(right), "alpha=10\nbeta=2\ngamma=3\ndelta=40\n");
    const [, lens] = mock.state.codeLenses.find(([sel]) => sel.scheme === "embarch-chat-proposal");
    const doc = { uri: right, lineCount: 5 };
    assert.deepEqual(lens.provideCodeLenses(doc).map((l) => [l.range.start.line, l.command.title]), [
      [0, "$(discard) Reject this change"],
      [3, "$(discard) Reject this change"],
    ]);
    // Reject the second change from its lens.
    const second = lens.provideCodeLenses(doc)[1].command;
    await mock.state.commands.get(second.command)(...second.arguments);
    assert.equal(docs.provideTextDocumentContent(right), "alpha=10\nbeta=2\ngamma=3\ndelta=4\n");
    assert.equal(lens.provideCodeLenses(doc)[1].command.title, "$(check) Rejected — keep it after all");
    const proposed = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "event" && m.e.type === "_proposed"), 3000, "the card told");
    assert.equal(proposed.e.kept, "1 of 2 changes kept");
    // The tab's Accept answers the prompt.
    await mock.state.commands.get("embarchChat.acceptChanges")(right);
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's end");
    const sent = fs.readFileSync(input, "utf8").trim().split("\n").map((l) => JSON.parse(l).o);
    const allow = sent.find((o) => o.type === "control_response" && o.response.response?.behavior === "allow");
    assert.equal(allow.response.response.updatedInput.new_string, "alpha=10\nbeta=2\ngamma=3\ndelta=4");
    assert.equal(docs.provideTextDocumentContent(right), "", "the proposal is gone with its answer");
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
  }
});

test("a plan opens as a Markdown tab whose lines take comments; they reach its card, one comes off with ×, and the rest go back with keep planning (decision 77)", { skip }, async () => {
  const input = path.join(dir, "input-plan.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = input;
  const sent = () => (fs.existsSync(input) ? fs.readFileSync(input, "utf8").trim().split("\n").map((l) => JSON.parse(l).o) : []);
  try {
    await startUntracked("basic");
    process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "planauto.jsonl");
    const n = chatView.webview.posted.length;
    const plans = () => chatView.webview.posted.slice(n).filter((m) => m.t === "event" && m.e.type === "control_request" && m.e.request.tool_name === "ExitPlanMode");
    chatView.webview.fromPage({ t: "send", text: "Plan how to create hello.txt containing hi, then present the plan for approval with ExitPlanMode. Keep the plan to two lines. After approval, create the file." });
    const ask = await waitFor(() => plans()[0], 5000, "the plan");
    const plan = ask.e.request.input.plan;
    chatView.webview.fromPage({ t: "openPlan", requestId: ask.e.request_id });
    const tab = await waitFor(() => mock.state.shown.find((x) => x.doc?.uri?.scheme === "embarch-chat-plan"), 3000, "the plan's tab");
    assert.match(tab.doc.uri.path, /\.md$/, "Markdown");
    assert.equal(mock.state.contentProviders.get("embarch-chat-plan").provideTextDocumentContent(tab.doc.uri), plan);
    const ctl = mock.state.commentControllers.find((c) => c.id === "embarch-chat-plan");
    assert.equal(ctl.commentingRangeProvider.provideCommentingRanges({ uri: tab.doc.uri, lineCount: 3 }).length, 1, "every line takes a comment");
    // Two comments, as VS Code's comment box submits them.
    const thread = (line) => ({ uri: tab.doc.uri, range: new mock.vscode.Range(line, 0, line, 0), comments: [], canReply: true, dispose() {
      this.disposed = true;
    } });
    const [t1, t2] = [thread(0), thread(1)];
    await mock.state.commands.get("embarchChat.addPlanComment")({ thread: t1, text: "Name the file greeting.txt instead." });
    await mock.state.commands.get("embarchChat.addPlanComment")({ thread: t2, text: "skip this" });
    assert.equal(t1.comments[0].body, "Name the file greeting.txt instead.");
    assert.equal(t1.canReply, false);
    const told = () => chatView.webview.posted.slice(n).filter((m) => m.t === "event" && m.e.type === "_planComments").at(-1)?.e.comments ?? [];
    await waitFor(() => told().length === 2, 3000, "the card told");
    // The second comes off from the card's ×: its thread goes too.
    chatView.webview.fromPage({ t: "removePlanComment", requestId: ask.e.request_id, id: told()[1].id });
    await waitFor(() => told().length === 1, 3000, "the card told again");
    assert.ok(t2.disposed);
    assert.deepEqual(told().map((c) => [c.selectedText, c.comment]), [[plan.split("\n")[0], "Name the file greeting.txt instead."]]);
    // Keep planning, from the card: the comment goes with it, and the tab's threads go.
    chatView.webview.fromPage({ t: "deny", requestId: ask.e.request_id, message: "" });
    const deny = await waitFor(() => sent().find((o) => o.type === "control_response" && o.response.response?.behavior === "deny"), 3000, "keep planning");
    assert.equal(deny.response.response.message, `User chose to stay in plan mode and continue planning\n\nComments on the plan:\n[Re: "${plan.split("\n")[0]}"] Name the file greeting.txt instead.`);
    assert.ok(t1.disposed);
    // The next plan, approved into auto: this model refuses it, so accept edits (as recorded).
    const ask2 = await waitFor(() => plans()[1], 5000, "the second plan");
    chatView.webview.fromPage({ t: "allow", requestId: ask2.e.request_id, mode: "auto" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's end");
    assert.deepEqual(sent().filter((o) => o.request?.subtype === "set_permission_mode").map((o) => o.request.mode), ["auto", "acceptEdits"]);
    assert.equal(chatView.webview.posted.slice(n).filter((m) => m.t === "event" && m.e.type === "_mode").at(-1).e.mode, "acceptEdits");
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
  }
});

test("Always allow from the card: the suggestions kept go where the owner picked, and the pick is remembered for every chat; nothing outside Claude Code's four places is taken (decision 78)", { skip }, async () => {
  const input = path.join(dir, "input-permdest.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = input;
  const sent = () => (fs.existsSync(input) ? fs.readFileSync(input, "utf8").trim().split("\n").map((l) => JSON.parse(l).o) : []);
  const KEY = "embarchChat.permissionDestination";
  try {
    await startUntracked("basic");
    process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "permdest.jsonl");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Run the bash command `node -e 1+1` and then reply with just: done" });
    const ask = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the prompt");
    chatView.webview.fromPage({ t: "permDestination", destination: "../../.bashrc" });
    chatView.webview.fromPage({ t: "permDestination", destination: "userSettings" });
    await waitFor(() => context.globalState.get(KEY) === "userSettings", 3000, "remembered");
    chatView.webview.fromPage({ t: "ready" });
    assert.equal(lastSnapshot().view.permDestination, "userSettings", "every page starts there");
    chatView.webview.fromPage({ t: "allow", requestId: ask.e.request_id, always: true, picks: [0], destination: "projectSettings" });
    const allow = await waitFor(() => sent().find((o) => o.type === "control_response"), 3000, "the answer");
    assert.deepEqual(allow.response.response.updatedPermissions.map((x) => [x.type, x.destination]), [
      ["addRules", "projectSettings"],
      ["addRules", "session"],
    ]);
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's end");
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
    await context.globalState.update(KEY, undefined);
  }
});

test("a turn that ends off screen leaves its chat unread — a dot in the list and on its tab — until the owner looks; Mark as Unread sets it again", { skip }, async () => {
  const sid = await startUntracked("basic");
  await mock.state.commands.get("embarchChat.openInEditor")();
  const panel = mock.state.panels.at(-1);
  const thread = () => lastGroups()?.groups.flatMap((g) => g.threads).find((t) => t.sessionId === sid);
  const icon = () => path.basename(panel.iconPath.dark.fsPath);
  assert.equal(icon(), "embarch-tab-dark.svg");
  try {
    // Neither the sidebar nor the tab shows it while its turn runs.
    chatView.visible = false;
    chatView.em.emit("vis");
    panel.visible = false;
    panel.em.emit("view");
    // Earlier tests' chats may wait off screen now: what counts is that this one adds nothing.
    await new Promise((r) => setTimeout(r, 200));
    const count = () => mock.state.statusItems.find((s) => s.command === "embarchChat.openWaiting");
    const before = { text: count().visible ? count().text : null, badge: threadsView.badge?.value, messages: mock.state.messages.length };
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's end");
    await waitFor(() => thread()?.unread, 5000, "the unread mark in the list");
    assert.equal(icon(), "embarch-tab-done-dark.svg");
    assert.equal(path.basename(panel.iconPath.light.fsPath), "embarch-tab-done-light.svg");
    // It waits on no one: it joins no count, and nothing pops up (decision 35).
    assert.deepEqual({ text: count().visible ? count().text : null, badge: threadsView.badge?.value, messages: mock.state.messages.length }, before);
    // The owner looks at its tab: read.
    panel.visible = true;
    panel.active = true;
    panel.em.emit("view");
    await waitFor(() => thread() && !thread().unread, 5000, "the mark gone once seen");
    assert.equal(icon(), "embarch-tab-dark.svg");
    // Mark as Unread on the active tab; it stays so until the owner looks again.
    await mock.state.commands.get("embarchChat.markUnread")();
    await waitFor(() => thread()?.unread, 5000, "marked unread");
    assert.equal(icon(), "embarch-tab-done-dark.svg");
    panel.em.emit("view");
    await waitFor(() => !thread().unread, 5000, "read again");
    // From a row's right-click: the row names its chat.
    panel.visible = false;
    panel.active = false;
    panel.em.emit("view");
    await mock.state.commands.get("embarchChat.markUnread")({ webviewSection: "embarchChat", sid });
    await waitFor(() => thread()?.unread, 5000, "marked from the list");
    // Its manifest entry: the palette, and right-click on a chat or one of this window's rows.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.ok(manifest.contributes.commands.some((c) => c.command === "embarchChat.markUnread" && c.title === "Mark as Unread"));
    assert.ok(manifest.contributes.menus["webview/context"].some((m) => m.command === "embarchChat.markUnread" && /webviewSection == 'embarchChat'/.test(m.when)));
    for (const f of ["pending", "done"]) for (const theme of ["dark", "light"]) assert.ok(fs.existsSync(path.join(root, "media", `embarch-tab-${f}-${theme}.svg`)), `${f}-${theme}`);
  } finally {
    chatView.visible = true;
    chatView.em.emit("vis");
    panel.dispose();
  }
});

test("a tab whose chat waits on the owner wears the pending mark", { skip }, async () => {
  await startUntracked("deny");
  await mock.state.commands.get("embarchChat.openInEditor")();
  const panel = mock.state.panels.at(-1);
  try {
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "touch it" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the permission prompt");
    await waitFor(() => path.basename(panel.iconPath.dark.fsPath) === "embarch-tab-pending-dark.svg", 5000, "the pending mark");
    const ask = [...chatView.webview.posted].reverse().find((m) => m.t === "event" && m.e.type === "control_request").e;
    chatView.webview.fromPage({ t: "deny", requestId: ask.request_id, message: "no" });
    await waitFor(() => path.basename(panel.iconPath.dark.fsPath) !== "embarch-tab-pending-dark.svg", 5000, "the mark gone with the answer");
  } finally {
    panel.dispose();
  }
});

test("the MCP pill's asks reach the chat's CLI: the servers as it has them now, and an action on one", { skip }, async () => {
  // The recording has the window's own server beside a stdio one (decision 65).
  mock.state.config["embarchChat.diagnosticsTool"] = true;
  try {
    const sid = await startUntracked("mcp");
    const n = chatView.webview.posted.length;
    // The fixture's turn, then the pill's own asks, as the page posts them.
    chatView.webview.fromPage({ t: "send", text: "Reply with just: ok" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn");
    chatView.webview.fromPage({ t: "mcpStatus" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "_mcp"), 5000, "the servers");
    chatView.webview.fromPage({ t: "mcp", name: "bench", action: "disable" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "_mcp" && m.e.servers.some((x) => x.name === "bench" && x.status === "disabled")), 5000, "bench disabled");
    assert.equal(lastSnapshot().state.sessionId, sid);
  } finally {
    delete mock.state.config["embarchChat.diagnosticsTool"];
  }
});

test("the model pill's effort reaches the chat: its next process starts at it, never in the owner's settings", { skip }, async () => {
  const sid = await startUntracked("basic");
  const n = chatView.webview.posted.length;
  const spawnsBefore = calls().length;
  chatView.webview.fromPage({ t: "effort", effort: "low", ultracode: false });
  await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "_effort" && m.e.effort === "low"), 3000, "the pick on the page");
  chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
  await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn");
  const argv = calls().slice(spawnsBefore).find((c) => c.argv.includes("--input-format")).argv;
  assert.equal(argv[argv.indexOf("--settings") + 1], '{"effortLevel":"low"}');
  assert.equal(lastSnapshot().state.sessionId, sid);
});

test("Remote Control on and off for the chat, as the page's /remote-control asks: nothing goes to Claude, and a new chat's process starts for it", { skip }, async () => {
  const sid = await startUntracked("basic");
  const spawnsBefore = calls().length;
  const n = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "remoteControl" });
  await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "_remote" && m.e.remote?.status === "connecting"), 3000, "connecting");
  await waitFor(() => calls().slice(spawnsBefore).some((c) => c.argv.includes("--input-format")), 3000, "the process started for it");
  chatView.webview.fromPage({ t: "remoteControl" });
  await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "_remote" && m.e.remote === null), 3000, "off again");
  assert.ok(!chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "_sent"), "never sent to Claude");
  assert.equal(lastSnapshot().state.sessionId, sid);
});

test("Keep sends a reply to the chat's work item as a note of its kind, through the desk; the page hears what became of it (decision 40)", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-127 keep what was found", desk: "none" });
  await mock.state.commands.get("embarchChat.refresh")();
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "basic.jsonl");
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("ABC-127"));
  await mock.state.commands.get("embarchChat.newChat")();
  const snap = await waitFor(() => lastSnapshot()?.header?.itemId === item && lastSnapshot(), 5000, "the chat on the item");
  const sid = snap.state.sessionId;
  const n = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
  await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn");
  // The page's own fold of what it was sent: Claude's last reply, by its entry id.
  const st = core.reduceAll(snap.state, chatView.webview.posted.slice(n).filter((m) => m.t === "event").map((m) => m.e));
  const reply = Object.values(st.entries).filter((e) => e.kind === "text" && e.parent === null).at(-1);
  assert.equal(reply.text, "done");
  chatView.webview.fromPage({ t: "keep", entryId: reply.id, kind: "finding" });
  const kept = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "kept"), 5000, "the answer");
  assert.deepEqual(kept, { t: "kept", entryId: reply.id, kind: "finding", held: false });
  const notes = (await client.call("GET", `/items/${encodeURIComponent(item)}/notes`)).notes;
  assert.deepEqual(notes.filter((x) => x.session_id === sid).map((x) => [x.kind, x.text]), [["finding", "done"]], "the reply's text, from the host's state");
  // The page names a reply; it never supplies the text, and only a reply of Claude's goes.
  const before = (await client.call("GET", `/items/${encodeURIComponent(item)}/notes`)).notes.length;
  chatView.webview.fromPage({ t: "keep", entryId: "no-such-entry", kind: "finding" });
  chatView.webview.fromPage({ t: "keep", entryId: reply.id, kind: "memory" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await client.call("GET", `/items/${encodeURIComponent(item)}/notes`)).notes.length, before);
});

// ------------------------------------------------------------ a window reload (decision 63)

/** The window reloads: this extension host deactivates and a new one activates, with the same workspace state. */
async function reload(before = () => {}) {
  await ext.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  before();
  context = { subscriptions: [], extensionUri: mock.vscode.Uri.file(root), workspaceState: context.workspaceState, globalState: context.globalState };
  ext.activate(context);
  threadsView = new mock.FakeView();
  chatView = new mock.FakeView();
  mock.state.providers.get("embarchChat.threads").provider.resolveWebviewView(threadsView);
  mock.state.providers.get("embarchChat.chat").provider.resolveWebviewView(chatView);
  threadsView.webview.fromPage({ t: "ready" });
  chatView.webview.fromPage({ t: "ready" });
}

test("a reload brings the window's chats back in their own mode; one cut off mid-turn continues its step only on Continue, labelled; after a close nothing comes back (decision 63)", { skip }, async () => {
  process.env.FAKE_CLAUDE_TRANSCRIPT = "prompt";
  try {
    const sid = await startUntracked("deny");
    // Ask mode: what Claude asks to run waits on the owner, after the reload too.
    chatView.webview.fromPage({ t: "mode", mode: "default" });
    await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_mode" && m.e.mode === "default"), 3000, "ask mode");
    // On the model the owner picked, after the reload too (review r4 N1).
    chatView.webview.fromPage({ t: "model", model: "sonnet" });
    await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_model" && m.e.model === "sonnet"), 3000, "the model");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Run the bash command `touch should-not-exist.txt`. If it is refused, reply with just: refused" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the chat mid-turn, waiting on the owner");
    await mock.state.commands.get("embarchChat.openInEditor")();
    const tabsBefore = mock.state.panels.length;
    const spawnsBefore = calls().length;
    // The reload: its own process goes with the old host.
    await reload(() => (process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "reload.jsonl")));
    const back = await waitFor(() => {
      const s = lastSnapshot();
      return s?.state.sessionId === sid && s.view.ours && s;
    }, 15000, "the chat back in the sidebar, the window's own");
    assert.ok(back.state.timeline.length > 0, "with its history, from the transcript");
    assert.equal(back.state.mode, "default", "in the mode it ran in, never a new chat's auto");
    assert.ok(mock.state.panels.length > tabsBefore && mock.state.panels.at(-1).title, "its tab back");
    // A close and a reopen look the same as a reload: the step waits for the owner's word.
    const offer = await waitFor(() => chatView.webview.posted.find((m) => m.t === "event" && m.e.type === "_note" && m.e.offer === "rerun"), 10000, "the offer to continue");
    assert.equal(offer.e.text, core.RERUN_OFFER_NOTE);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!calls().slice(spawnsBefore).some((c) => c.argv.includes("--input-format")), "nothing reruns by itself");
    chatView.webview.fromPage({ t: "continueStep" });
    const note = await waitFor(() => chatView.webview.posted.find((m) => m.t === "event" && m.e.type === "_note" && m.e.text === core.RERUN_NOTE), 10000, "the rerun's label");
    assert.ok(note);
    await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "result"), 10000, "the step's end");
    const rerun = calls().slice(spawnsBefore).find((c) => c.argv.includes("--input-format"));
    assert.equal(rerun.argv.find((a) => a.startsWith("--resume")), `--resume=${sid}`);
    assert.equal(rerun.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, "1");
    assert.ok(rerun.argv.includes("--permission-mode=default"), "rerun in ask mode");
    assert.equal(rerun.argv[rerun.argv.indexOf("--model") + 1], "sonnet", "on the owner's model");
    // The offer went with its process: a second click starts nothing.
    chatView.webview.fromPage({ t: "continueStep" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls().slice(spawnsBefore).filter((c) => c.argv.includes("--input-format")).length, 1);
    // A close, and a window opened later: nothing comes back (decision 5).
    await reload(() => {
      const k = "embarchChat.openChats";
      const saved = context.workspaceState.get(k);
      assert.ok(saved?.chats.some((c) => c.sid === sid), "written down at deactivate");
      context.workspaceState.update(k, { ...saved, at: Date.now() - 5 * 60_000 });
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!chatView.webview.posted.some((m) => m.t === "snapshot" && m.state.sessionId === sid), "not back after a close");
    assert.ok(mock.state.output.some((l) => /not brought back: it closed \d+ s ago/.test(l)));
    assert.equal(context.workspaceState.get("embarchChat.openChats"), undefined, "and forgotten");
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  }
});

test("with continueAfterReload off, a chat cut off mid-turn comes back saying no reply follows, nothing runs, and a message that waited is back in the draft (decision 63)", { skip }, async () => {
  process.env.FAKE_CLAUDE_TRANSCRIPT = "prompt";
  mock.state.config["embarchChat.continueAfterReload"] = false;
  try {
    const sid = await startUntracked("askqueued");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Use the AskUserQuestion tool to ask me whether I prefer tea or coffee." });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "mid-turn");
    chatView.webview.fromPage({ t: "send", text: "Also end your reply with the word: kiwi" });
    await waitFor(() => transcriptHas(sid, "kiwi"), 5000, "the message in the CLI's queue");
    const spawnsBefore = calls().length;
    await reload();
    await waitFor(() => chatView.webview.posted.find((m) => m.t === "event" && m.e.type === "_note" && m.e.text === core.NO_REPLY_NOTE), 15000, "the no-reply note");
    assert.equal(lastSnapshot().state.sessionId, sid);
    const draft = await waitFor(() => posted((m) => m.t === "draft" && m.sid === sid), 3000, "the waiting message in the draft");
    assert.equal(draft.text, "Also end your reply with the word: kiwi");
    assert.ok(posted((m) => m.t === "event" && m.e.type === "_note" && /^A message Claude had not taken when the window reloaded is back in the draft/.test(m.e.text)), "a line says so");
    assert.ok(!calls().slice(spawnsBefore).some((c) => c.argv.includes("--input-format")), "no process started");
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete mock.state.config["embarchChat.continueAfterReload"];
  }
});

/** The CLI's transcript of a chat in the window's folder holds this text (a queue line counts). */
const transcriptHas = (sid, text) => {
  const f = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
  return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(text);
};

test("a message waiting above the input when the window reloads comes back waiting, and goes with Continue, after the step (decisions 63, 72)", { skip }, async () => {
  process.env.FAKE_CLAUDE_TRANSCRIPT = "prompt";
  const inputs = path.join(dir, "inputs-reload-queue.jsonl");
  try {
    const sid = await startUntracked("askqueued");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Use the AskUserQuestion tool to ask me whether I prefer tea or coffee." });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the question waits");
    chatView.webview.fromPage({ t: "send", text: "Also end your reply with the word: kiwi" });
    const sent = await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_sent" && m.e.text.includes("kiwi")), 3000, "it waits above the input");
    // In the CLI's queue only: a reload drops that queue, and the resumed CLI does not take it [measured].
    await waitFor(() => transcriptHas(sid, "kiwi"), 5000, "its queue line");
    const spawnsBefore = calls().length;
    await reload(() => (process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "reload.jsonl")));
    const back = await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_sent" && m.e.restored), 15000, "the message back above the input");
    assert.equal(back.e.text, "Also end your reply with the word: kiwi");
    assert.equal(back.e.uuid, sent.e.uuid, "the same message");
    await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_note" && m.e.offer === "rerun"), 3000, "the offer to continue");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!calls().slice(spawnsBefore).some((c) => c.argv.includes("--input-format")), "nothing goes by itself");
    process.env.FAKE_CLAUDE_INPUT_LOG = inputs;
    chatView.webview.fromPage({ t: "continueStep" });
    await waitFor(() => fs.existsSync(inputs) && fs.readFileSync(inputs, "utf8").includes("kiwi"), 5000, "the message to the rerun's process");
    const lines = fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o);
    assert.deepEqual(lines.slice(0, 2).map((o) => o.type), ["control_request", "user"], "after initialize, as the step's own process takes it");
    assert.equal(lines.filter((o) => o.type === "user").length, 1);
    assert.equal(lines[1].uuid, sent.e.uuid);
    const rerun = calls().slice(spawnsBefore).find((c) => c.argv.includes("--input-format"));
    assert.equal(rerun.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, "1");
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
  }
});

test("Continue clicked once the step is past Claude Code's hour: nothing starts, the chat says no reply follows, the offer goes and the waiting message is back in the draft (decision 63; review r5 N4)", { skip }, async () => {
  process.env.FAKE_CLAUDE_TRANSCRIPT = "prompt";
  try {
    const sid = await startUntracked("askqueued");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Use the AskUserQuestion tool to ask me whether I prefer tea or coffee." });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the question waits");
    chatView.webview.fromPage({ t: "send", text: "Also end your reply with the word: kiwi" });
    await waitFor(() => transcriptHas(sid, "kiwi"), 5000, "its queue line");
    await reload(() => (process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "reload.jsonl")));
    const back = await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_sent" && m.e.restored), 15000, "the message back above the input");
    await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_note" && m.e.offer === "rerun"), 3000, "the offer to continue");
    // The owner leaves it, and clicks two hours later: the step, as the transcript dates it, is past the CLI's hour.
    const f = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(f, old, old);
    const spawnsBefore = calls().length;
    const n1 = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "continueStep" });
    await waitFor(() => chatView.webview.posted.slice(n1).some((m) => m.t === "event" && m.e.type === "_note" && m.e.text === core.NO_REPLY_NOTE), 3000, "no reply follows");
    assert.ok(chatView.webview.posted.slice(n1).some((m) => m.t === "event" && m.e.type === "_offerEnd"), "the offer goes");
    const draft = await waitFor(() => chatView.webview.posted.slice(n1).find((m) => m.t === "draft" && m.sid === sid), 3000, "the message in the draft");
    assert.equal(draft.text, "Also end your reply with the word: kiwi");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!calls().slice(spawnsBefore).some((c) => c.argv.includes("--input-format")), "no CLI started to rerun nothing");
    assert.ok(mock.state.output.some((l) => l.includes("the interrupted step is not continued: the step is over an hour old, by the owner's click")));
    // Given back unsent, it is in no transcript: a rewind or a fork from it says so (review r6 L1).
    chatView.webview.fromPage({ t: "rewindCheck", uuid: back.e.uuid });
    const check = await waitFor(() => chatView.webview.posted.slice(n1).find((m) => m.t === "rewindCheck" && m.uuid === back.e.uuid), 3000, "the answer");
    assert.deepEqual(check.result, { canRewind: false, error: "That message was not sent." });
    chatView.webview.fromPage({ t: "rewind", uuid: back.e.uuid, restore: "conversation" });
    await waitFor(() => chatView.webview.posted.slice(n1).some((m) => m.t === "event" && m.e.type === "_note" && m.e.text === "Not rewound or forked: That message was not sent."), 3000, "the note");
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
  }
});

test("a new chat reloaded before the CLI took its first message comes back with it in the draft, and nothing runs (decision 63)", { skip }, async () => {
  const sid = await startUntracked("deny");
  // A slow start (MCP servers connecting): the CLI has read the message and written nothing yet.
  const slow = path.join(dir, "slow-start.jsonl");
  const first = fs.readFileSync(path.join(here, "fixtures", "wire", "deny.jsonl"), "utf8").split("\n")[0];
  fs.writeFileSync(slow, `${first}\n${JSON.stringify({ d: "in", o: { type: "control_request", request: { subtype: "never" } } })}\n`);
  process.env.FAKE_CLAUDE_FIXTURE = slow;
  chatView.webview.fromPage({ t: "send", text: "Run the bash command `touch should-not-exist.txt`. If it is refused, reply with just: refused" });
  await waitFor(() => calls().some((c) => c.argv.includes("--session-id") && c.argv.includes(sid)), 5000, "its process");
  await new Promise((r) => setTimeout(r, 300));
  const spawnsBefore = calls().length;
  await reload(() => (process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "reload.jsonl")));
  const draft = await waitFor(() => posted((m) => m.t === "draft" && m.sid === sid), 15000, "the message in the draft");
  assert.equal(draft.text, "Run the bash command `touch should-not-exist.txt`. If it is refused, reply with just: refused");
  assert.ok(posted((m) => m.t === "event" && m.e.type === "_note" && /back in the draft/.test(m.e.text)), "a line says so");
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!calls().slice(spawnsBefore).some((c) => c.argv.includes("--input-format")), "no empty session started for it");
  assert.ok(lastSnapshot().view.ours && !posted((m) => m.t === "event" && m.e.type === "_note" && m.e.offer === "rerun"), "new, with nothing to continue");
});

test("a draft typed in an editor tab and not sent comes back after a reload: VS Code keeps no tab's page state, so the host does (decision 63)", { skip }, async () => {
  const sid = await startUntracked("basic");
  await mock.state.commands.get("embarchChat.openInEditor")();
  const tab = mock.state.panels.at(-1);
  tab.webview.fromPage({ t: "ready" });
  await waitFor(() => tab.webview.posted.find((m) => m.t === "snapshot" && m.state.sessionId === sid), 3000, "the tab");
  tab.webview.fromPage({ t: "typed", sid, text: "half a thought about the flash" });
  const panelsBefore = mock.state.panels.length;
  await reload();
  const back = await waitFor(() => mock.state.panels.length > panelsBefore && mock.state.panels.at(-1), 15000, "the tab opened again");
  back.webview.fromPage({ t: "ready" });
  const draft = await waitFor(() => back.webview.posted.find((m) => m.t === "draft" && m.sid === sid), 5000, "the draft");
  assert.deepEqual(draft, { t: "draft", sid, text: "half a thought about the flash", typed: true }, "the owner's words, to fill an empty draft");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(back.webview.posted.filter((m) => m.t === "draft" && m.sid === sid && m.typed).length, 1, "once");
  // The sidebar shows the chat too, and never held these words: it is not given them, or a Send there would send them again (review r6 L3).
  assert.equal(lastSnapshot()?.state.sessionId, sid);
  chatView.webview.fromPage({ t: "ready" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(chatView.webview.posted.filter((m) => m.t === "draft" && m.sid === sid && m.typed).length, 0, "the sidebar keeps its own");
});

test("a draft typed in the sidebar comes back to the sidebar alone after a reload: a tab of the same chat is not given it (review r6 L3)", { skip }, async () => {
  const sid = await startUntracked("basic");
  chatView.webview.fromPage({ t: "typed", sid, text: "the other half of the thought" });
  await mock.state.commands.get("embarchChat.openInEditor")();
  const tab = mock.state.panels.at(-1);
  tab.webview.fromPage({ t: "ready" });
  await waitFor(() => tab.webview.posted.find((m) => m.t === "snapshot" && m.state.sessionId === sid), 3000, "the tab");
  const panelsBefore = mock.state.panels.length;
  await reload();
  const back = await waitFor(() => mock.state.panels.length > panelsBefore && mock.state.panels.at(-1), 15000, "the tab opened again");
  back.webview.fromPage({ t: "ready" });
  await waitFor(() => back.webview.posted.find((m) => m.t === "snapshot" && m.state.sessionId === sid), 3000, "the tab's chat");
  chatView.webview.fromPage({ t: "ready" });
  const draft = await waitFor(() => posted((m) => m.t === "draft" && m.sid === sid && m.typed), 5000, "the sidebar's draft");
  assert.equal(draft.text, "the other half of the thought");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(back.webview.posted.filter((m) => m.t === "draft" && m.sid === sid && m.typed).length, 0, "the tab never held them");
});

test("a second reload while the first still waits for a chat's old process to go keeps that chat (decision 63)", { skip }, async () => {
  process.env.FAKE_CLAUDE_TRANSCRIPT = "prompt";
  try {
    const sid = await startUntracked("deny");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Run the bash command `touch should-not-exist.txt`. If it is refused, reply with just: refused" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "mid-turn");
    // The old process lingers: `claude agents` still lists it, so the chat waits read-only.
    process.env.FAKE_CLAUDE_AGENTS = JSON.stringify([{ sessionId: sid, pid: 4242, kind: "sdk" }]);
    await reload();
    await waitFor(() => lastSnapshot()?.state.sessionId === sid, 5000, "back, read-only while it waits");
    await new Promise((r) => setTimeout(r, 300));
    await reload(() => (process.env.FAKE_CLAUDE_AGENTS = "[]"));
    await waitFor(() => {
      const s = lastSnapshot();
      return s?.state.sessionId === sid && s.view.ours;
    }, 15000, "back again after the second reload, the window's own");
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete process.env.FAKE_CLAUDE_AGENTS;
  }
});

// ------------------------------------------------------------ history (decisions 73–75)

test("Rename from the list: the owner's name, given before the first turn, is the chat's — Haiku's never replaces it — and the list shows it", { skip }, async () => {
  const sid = await startUntracked("suggest");
  mock.state.inputBox = async (opts) => (opts.prompt === "Rename the chat" ? "Blink bring-up" : undefined);
  const n = chatView.webview.posted.length;
  const titled = (t) => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "_title" && m.e.title === t);
  threadsView.webview.fromPage({ t: "rename", sid });
  await waitFor(() => titled("Blink bring-up"), 3000, "the name");
  await waitFor(() => lastGroups()?.groups.some((g) => g.threads.some((t) => t.sessionId === sid && t.title === "Blink bring-up")), 5000, "the name in the list");
  chatView.webview.fromPage({ t: "send", text: "I am setting up a small Node project in this folder. Run `echo setup` with bash, then suggest what I should do first, in two sentences." });
  await waitFor(() => posted((m) => m.t === "chips" && m.sid === sid && m.chips.some((c) => c.source === "haiku")), 8000, "the turn's chips");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!titled(core.parseTurn(haikuAnswer("turn")).name), "Haiku's name never came");
  assert.ok(lastGroups().groups.some((g) => g.threads.some((t) => t.sessionId === sid && t.title === "Blink bring-up")));
});

test("Rename from the chat's header or its tab's menu asks with the name it has; a thread something else runs is not renamed here", { skip }, async () => {
  let asked = null;
  mock.state.inputBox = async (opts) => ((asked = opts.value), "From the header");
  chatView.webview.fromPage({ t: "rename" });
  await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_title" && m.e.title === "From the header"), 3000, "the header's name");
  assert.equal(asked, "Blink bring-up");
  // The webview's context menu hands the command its own argument, not a session.
  mock.state.inputBox = async () => "From the tab";
  await mock.state.commands.get("embarchChat.renameChat")({ webview: "embarchChat.chatTab" });
  await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_title" && m.e.title === "From the tab"), 3000, "the tab's name");
  // The terminal session above runs elsewhere: read-only here (31).
  let prompted = false;
  mock.state.inputBox = async () => ((prompted = true), "nope");
  threadsView.webview.fromPage({ t: "rename", sid: "7e7e7e7e-0000-4000-8000-00000000abcd" });
  await waitFor(() => mock.state.messages.some(([k, m]) => k === "info" && /Something else runs this chat/.test(m)), 3000, "the refusal");
  assert.equal(prompted, false);
});

test("a chat named before its first message comes back after a reload with its name, and its first message starts it by its id (decisions 63, 75)", { skip }, async () => {
  const sid = await startUntracked("basic");
  mock.state.inputBox = async () => "Named, not started";
  chatView.webview.fromPage({ t: "rename" });
  await waitFor(() => posted((m) => m.t === "event" && m.e.type === "_title" && m.e.title === "Named, not started"), 3000, "the name");
  await reload(() => (process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "basic.jsonl")));
  await waitFor(() => {
    const s = lastSnapshot();
    return s?.state.sessionId === sid && s.view.ours && s.state.title === "Named, not started";
  }, 15000, "the chat back, the window's own, with its name");
  const spawnsBefore = calls().length;
  chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
  await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "result"), 5000, "its first turn");
  const run = calls().slice(spawnsBefore).find((c) => c.argv.includes("--input-format"));
  assert.equal(run.argv[run.argv.indexOf("--session-id") + 1], sid, "started by its id, not resumed: it had no transcript");
  assert.ok(!run.argv.some((a) => a.startsWith("--resume")));
});

test("Export: the conversation as plain text for the page; Save writes it where VS Code's save dialog says", { skip }, async () => {
  const n = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "export" });
  const ex = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "export"), 5000, "the export");
  assert.match(ex.text, /❯ Run the bash command `echo hello-from-bash`/);
  assert.match(ex.filename, /\.txt$/);
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  const target = path.join(dir, "exports", "exported.txt");
  let asked = null;
  mock.state.saveDialog = async (opts) => ((asked = opts), mock.vscode.Uri.file(target));
  // What the page says goes in the file does not: the host writes the text it gave the dialog (review r4 N2).
  chatView.webview.fromPage({ t: "exportSave", text: "not what the export said", filename: "../elsewhere.txt" });
  await waitFor(() => fs.existsSync(target), 3000, "the file");
  assert.equal(fs.readFileSync(target, "utf8"), ex.text);
  assert.equal(path.basename(asked.defaultUri.fsPath), ex.filename);
  // Never the chat's folder, a repo's working tree (review r4 L3): the home folder the first time, then where the last export went.
  assert.equal(path.dirname(asked.defaultUri.fsPath), os.homedir(), "the home folder, not the chat's");
  await waitFor(() => context.globalState.get("embarchChat.exportFolder"), 3000, "the folder remembered");
  asked = null;
  mock.state.saveDialog = async (opts) => ((asked = opts), undefined);
  chatView.webview.fromPage({ t: "exportSave" });
  await waitFor(() => asked, 3000, "the second dialog");
  assert.equal(path.dirname(asked.defaultUri.fsPath), path.join(dir, "exports"), "where the last export went");
  mock.state.saveDialog = async () => undefined;
});

const PARENT_FIXTURE = path.join(here, "fixtures", "fork", "6c563cde-6794-42ea-b651-dbbcb0946fdc.jsonl");

test("Fork conversation from here: a new chat on the same item with the conversation up to the message and the message in its draft; its first message runs the CLI's own fork", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-131 fork it", desk: "none" });
  await mock.state.commands.get("embarchChat.refresh")();
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "forkparent.jsonl");
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("ABC-131 fork it"));
  await mock.state.commands.get("embarchChat.newChat")();
  const parent = await waitFor(() => lastSnapshot()?.header?.itemId === item && lastSnapshot().state.sessionId, 5000, "the chat on the item");
  const n0 = chatView.webview.posted.length;
  const results = () => chatView.webview.posted.slice(n0).filter((m) => m.t === "event" && m.e.type === "result").length;
  chatView.webview.fromPage({ t: "send", text: "Remember the word PELICAN. Reply with just: noted" });
  await waitFor(() => results() >= 1, 5000, "the first turn");
  chatView.webview.fromPage({ t: "send", text: "Also remember the word OTTER. Reply with just: noted" });
  await waitFor(() => results() >= 2, 5000, "the second turn");
  // The parent runs at high effort with Ultracode (82): so will its fork.
  chatView.webview.fromPage({ t: "effort", effort: "high", ultracode: true });
  await waitFor(() => chatView.webview.posted.slice(n0).some((m) => m.t === "event" && m.e.type === "_effort" && m.e.effort === "high"), 3000, "the parent's effort");
  // And in Accept edits: so will its fork, never a new chat's auto (22).
  chatView.webview.fromPage({ t: "mode", mode: "acceptEdits" });
  await waitFor(() => chatView.webview.posted.slice(n0).some((m) => m.t === "event" && m.e.type === "_mode" && m.e.mode === "acceptEdits"), 3000, "the parent's mode");
  // On Sonnet, which the owner picked: so will its fork (review r4 N1).
  chatView.webview.fromPage({ t: "model", model: "sonnet" });
  await waitFor(() => chatView.webview.posted.slice(n0).some((m) => m.t === "event" && m.e.type === "_model" && m.e.model === "sonnet"), 3000, "the parent's model");
  // Claude's transcript of it, as the CLI wrote it for the recording.
  const text = fs.readFileSync(PARENT_FIXTURE, "utf8").replaceAll("6c563cde-6794-42ea-b651-dbbcb0946fdc", parent).replaceAll("/work/rec/fork", folder);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), `${parent}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const second = text.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "user")[1];
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "fork.jsonl");
  const n1 = chatView.webview.posted.length;
  const since = (pred) => chatView.webview.posted.slice(n1).find(pred);
  chatView.webview.fromPage({ t: "rewind", uuid: second.uuid, restore: "conversation" });
  const snap = await waitFor(() => since((m) => m.t === "snapshot" && m.state.sessionId !== parent), 5000, "the fork");
  const fork = snap.state.sessionId;
  assert.equal(snap.header.itemId, item, "on the same work item");
  assert.deepEqual(
    snap.state.timeline.map((id) => snap.state.entries[id].text),
    ["Remember the word PELICAN. Reply with just: noted", "noted"],
    "the conversation up to the message",
  );
  const draft = await waitFor(() => since((m) => m.t === "draft" && m.sid === fork), 3000, "the message in the draft");
  assert.equal(draft.text, "Also remember the word OTTER. Reply with just: noted");
  await waitFor(() => since((m) => m.t === "event" && m.e.type === "_title" && / \(fork\)$/.test(m.e.title)), 3000, "the fork's name");
  const row = (await client.view()).sessions.find((x) => x.session_id === fork);
  assert.equal(row?.item_id, item, "the desk has it on the item, as any new chat (10)");
  assert.equal(row?.client, "embarch-chat");
  // Its first message: the CLI copies the parent up to the point.
  chatView.webview.fromPage({ t: "send", text: "Which words did I ask you to remember? Reply with the words only." });
  await waitFor(() => since((m) => m.t === "event" && m.e.type === "result"), 5000, "the fork's first turn");
  const run = calls().filter((c) => c.argv.includes("--fork-session")).at(-1);
  assert.ok(run.argv.includes(`--resume=${parent}`));
  assert.equal(run.argv[run.argv.indexOf("--session-id") + 1], fork);
  assert.equal(run.argv[run.argv.indexOf("--resume-session-at") + 1], second.parentUuid);
  assert.equal(run.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, "true");
  assert.deepEqual(JSON.parse(run.argv[run.argv.indexOf("--settings") + 1]), { effortLevel: "high", ultracode: true }, "the parent's effort and Ultracode");
  assert.ok(run.argv.includes("--permission-mode=acceptEdits"), "the parent's mode");
  assert.equal(run.argv[run.argv.indexOf("--model") + 1], "sonnet", "the parent's model");
  // A fork keeps its name: Haiku names no fork (12).
  await new Promise((r) => setTimeout(r, 300));
  const haikuName = core.parseTurn(haikuAnswer("turn")).name;
  assert.ok(!chatView.webview.posted.slice(n1).some((m) => m.t === "event" && m.e.type === "_title" && m.e.title === haikuName), "no Haiku name");
});

test("Rewind code: a dry run for the confirmation, then the files only on the owner's word, and a note says so; files changed since the confirmation are shown and asked again (decision 73; review r4 L4)", { skip }, async () => {
  // At Rewind the files have changed since the dry run the owner saw: a second file, more lines.
  const later = { canRewind: true, filesChanged: ["/work/rec/rewind/a.txt", "/work/rec/rewind/b.txt"], insertions: 3, deletions: 1 };
  process.env.FAKE_CLAUDE_DRY_RUN = JSON.stringify(later);
  try {
    const sid = await startUntracked("rewind");
    const n = chatView.webview.posted.length;
    const evs = () => chatView.webview.posted.slice(n).filter((m) => m.t === "event").map((m) => m.e);
    const allow = async (k) => {
      const req = await waitFor(() => evs().filter((e) => e.type === "control_request")[k], 5000, "a permission prompt");
      chatView.webview.fromPage({ t: "allow", requestId: req.request_id });
    };
    chatView.webview.fromPage({ t: "send", text: "Use the Write tool to create a.txt containing exactly the word: one. Then reply with just: done" });
    await allow(0);
    await waitFor(() => evs().filter((e) => e.type === "result").length >= 1, 5000, "the first turn");
    chatView.webview.fromPage({ t: "send", text: "Use the Edit tool to change one to two in a.txt. Then reply with just: done" });
    await allow(1);
    await waitFor(() => evs().filter((e) => e.type === "result").length >= 2, 5000, "the second turn");
    const second = evs().filter((e) => e.type === "user" && e.isReplay)[1].uuid;
    chatView.webview.fromPage({ t: "rewindCheck", uuid: second });
    const check = await waitFor(() => posted((m) => m.t === "rewindCheck" && m.uuid === second), 5000, "the dry run");
    assert.deepEqual(check.result, { canRewind: true, filesChanged: ["/work/rec/rewind/a.txt"], insertions: 1, deletions: 1 });
    const n1 = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "rewind", uuid: second, restore: "code" });
    const again = await waitFor(() => chatView.webview.posted.slice(n1).find((m) => m.t === "rewindCheck"), 5000, "the confirmation again");
    assert.deepEqual(again, { t: "rewindCheck", uuid: second, result: later, again: "code" }, "what a rewind restores now, for the same restore");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!evs().some((e) => e.type === "_note" && /^Files rewound/.test(e.text)), "nothing rewound on a confirmation of other files");
    // Confirmed again, on the files as they are now: done.
    chatView.webview.fromPage({ t: "rewind", uuid: second, restore: "code" });
    await waitFor(() => evs().some((e) => e.type === "_note" && e.text === "Files rewound to before “Use the Edit tool to change one to two in a.txt. Then reply…”."), 5000, "the note");
    assert.ok(!chatView.webview.posted.slice(n).some((m) => m.t === "snapshot" && m.state.sessionId !== sid), "the files only: no fork");
  } finally {
    delete process.env.FAKE_CLAUDE_DRY_RUN;
  }
});

test("a file rewind waits for the chat's background tasks: none is checked or done while one runs (review r4 L4)", { skip }, async () => {
  const inputs = path.join(dir, "inputs-rewind-bg.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = inputs;
  try {
    await startUntracked("bgstop");
    const n = chatView.webview.posted.length;
    const evs = () => chatView.webview.posted.slice(n).filter((m) => m.t === "event").map((m) => m.e);
    chatView.webview.fromPage({ t: "send", text: "Run the bash command `for i in $(seq 1 30); do echo tick $i; sleep 1; done` with run_in_background, then reply with just: started" });
    const req = await waitFor(() => evs().find((e) => e.type === "control_request"), 5000, "the Bash prompt");
    chatView.webview.fromPage({ t: "allow", requestId: req.request_id });
    await waitFor(() => evs().some((e) => e.type === "result"), 5000, "the turn, its shell still running");
    const uuid = evs().find((e) => e.type === "user" && e.isReplay).uuid;
    chatView.webview.fromPage({ t: "rewindCheck", uuid });
    const check = await waitFor(() => posted((m) => m.t === "rewindCheck" && m.uuid === uuid), 5000, "the answer");
    assert.deepEqual(check.result, { canRewind: false, error: "A background task runs: stop it, or let it finish, first." });
    chatView.webview.fromPage({ t: "rewind", uuid, restore: "code" });
    await waitFor(() => evs().some((e) => e.type === "_note" && e.text === "Files not rewound: A background task runs: stop it, or let it finish, first."), 3000, "the note");
    const sent = fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o);
    assert.ok(!sent.some((o) => o.request?.subtype === "rewind_files"), "the CLI was not asked");
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
  }
});

test("a rewind or a fork names one of the owner's messages in the chat the page shows: another chat's is refused, and nothing reaches the CLI (review r4 UI M3)", { skip }, async () => {
  const inputs = path.join(dir, "inputs-m3.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = inputs;
  try {
    // Chat A, whose message a stale dialog still quotes (another recording than B's: another message id).
    await startUntracked("attach");
    const n0 = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "What do the lines say?" });
    await waitFor(() => chatView.webview.posted.slice(n0).some((m) => m.t === "event" && m.e.type === "result"), 5000, "A's turn");
    const aUuid = chatView.webview.posted.slice(n0).find((m) => m.t === "event" && m.e.type === "user" && m.e.isReplay).e.uuid;
    // Chat B in the view, with a turn of its own.
    const b = await startUntracked("basic");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "B's turn");
    const forks = calls().filter((c) => c.argv.includes("--fork-session")).length;
    const asked = () => (fs.existsSync(inputs) ? fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o) : []).filter((o) => o.request?.subtype === "rewind_files").length;
    chatView.webview.fromPage({ t: "rewindCheck", uuid: aUuid });
    const check = await waitFor(() => posted((m) => m.t === "rewindCheck" && m.uuid === aUuid), 5000, "the answer");
    assert.deepEqual(check.result, { canRewind: false, error: "That message is not one of this chat's." });
    for (const restore of ["both", "code", "conversation"]) chatView.webview.fromPage({ t: "rewind", uuid: aUuid, restore });
    const notes = () => chatView.webview.posted.slice(n).filter((m) => m.t === "event" && m.e.type === "_note" && m.e.text === "Not rewound or forked: That message is not one of this chat's.");
    await waitFor(() => notes().length === 3, 3000, "a note for each");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(asked(), 0, "no file rewind, not even a dry run, reached B's CLI");
    assert.equal(calls().filter((c) => c.argv.includes("--fork-session")).length, forks, "no fork");
    assert.ok(!chatView.webview.posted.slice(n).some((m) => m.t === "snapshot" && m.state.sessionId !== b), "B stays on screen: no fork opened");
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
  }
});

test("a past chat opened from the list takes the mode its transcript last ran in, else Ask — never a new chat's auto (review r5 N3)", { skip }, async () => {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(projects, { recursive: true });
  /** Yesterday's chat in this folder, as the CLI wrote it, its owner's lines in `mode` (none: no mode written). */
  const past = (mode) => {
    const sid = globalThis.crypto.randomUUID();
    const lines = fs.readFileSync(PARENT_FIXTURE, "utf8").replaceAll("6c563cde-6794-42ea-b651-dbbcb0946fdc", sid).replaceAll("/work/rec/fork", folder).trim().split("\n").map((l) => JSON.parse(l));
    for (const o of lines) if (o.type === "user") mode ? (o.permissionMode = mode) : delete o.permissionMode;
    fs.writeFileSync(path.join(projects, `${sid}.jsonl`), lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
    return sid;
  };
  for (const [sid, want] of [[past("plan"), "plan"], [past(null), "default"], [past("bypassPermissions"), "default"]]) {
    threadsView.webview.fromPage({ t: "open", sid });
    const s = await waitFor(() => lastSnapshot()?.state.sessionId === sid && lastSnapshot(), 3000, "the past chat on screen");
    assert.equal(s.state.mode, want, `${want}: what a resume or a fork of it runs in`);
  }
});

test("a fork no message was sent to comes back after a reload still a fork: what it starts from, its name, and its first message copies the parent (decisions 63, 73)", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-132 fork, then reload", desk: "none" });
  await mock.state.commands.get("embarchChat.refresh")();
  process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "forkparent.jsonl");
  mock.state.quickPick = async (items) => items.find((i) => i.label.includes("ABC-132 fork, then reload"));
  await mock.state.commands.get("embarchChat.newChat")();
  const parent = await waitFor(() => lastSnapshot()?.header?.itemId === item && lastSnapshot().state.sessionId, 5000, "the chat on the item");
  const n0 = chatView.webview.posted.length;
  const results = () => chatView.webview.posted.slice(n0).filter((m) => m.t === "event" && m.e.type === "result").length;
  chatView.webview.fromPage({ t: "send", text: "Remember the word PELICAN. Reply with just: noted" });
  await waitFor(() => results() >= 1, 5000, "the first turn");
  chatView.webview.fromPage({ t: "send", text: "Also remember the word OTTER. Reply with just: noted" });
  await waitFor(() => results() >= 2, 5000, "the second turn");
  const text = fs.readFileSync(PARENT_FIXTURE, "utf8").replaceAll("6c563cde-6794-42ea-b651-dbbcb0946fdc", parent).replaceAll("/work/rec/fork", folder);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"), `${parent}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const second = text.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "user")[1];
  const n1 = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "rewind", uuid: second.uuid, restore: "conversation" });
  const fork = (await waitFor(() => chatView.webview.posted.slice(n1).find((m) => m.t === "snapshot" && m.state.sessionId !== parent), 5000, "the fork")).state.sessionId;
  const name = (await waitFor(() => chatView.webview.posted.slice(n1).find((m) => m.t === "event" && m.e.type === "_title" && / \(fork\)$/.test(m.e.title)), 3000, "its name")).e.title;
  // The window reloads before a message went to the fork.
  await reload(() => (process.env.FAKE_CLAUDE_FIXTURE = path.join(here, "fixtures", "wire", "fork.jsonl")));
  const back = await waitFor(() => {
    const s = lastSnapshot();
    return s?.state.sessionId === fork && s.view.ours && s.state.title === name && s;
  }, 15000, "the fork back, with its name");
  assert.deepEqual(
    back.state.timeline.map((id) => back.state.entries[id].text),
    ["Remember the word PELICAN. Reply with just: noted", "noted"],
    "what it starts from",
  );
  const spawnsBefore = calls().length;
  chatView.webview.fromPage({ t: "send", text: "Which words did I ask you to remember? Reply with the words only." });
  await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "result"), 5000, "its first turn");
  const run = calls().slice(spawnsBefore).find((c) => c.argv.includes("--input-format"));
  assert.ok(run.argv.includes(`--resume=${parent}`) && run.argv.includes("--fork-session"), run.argv.join(" "));
  assert.equal(run.argv[run.argv.indexOf("--session-id") + 1], fork);
  assert.equal(run.argv[run.argv.indexOf("--resume-session-at") + 1], second.parentUuid);
  assert.equal(run.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, "true");
});

// ------------------------------------------------------------ what goes into a message (58–60)

/** A text editor on a file of the window's folder, as VS Code hands one over. */
function fakeEditor(rel, lines) {
  const doc = { uri: { scheme: "file", fsPath: path.join(folder, rel) }, fileName: path.join(folder, rel), isClosed: false };
  const ed = { document: doc, selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  doc.getText = (r) => (r ? lines.slice(r.start.line, r.end.character === 0 ? r.end.line : r.end.line + 1).join("\n") : lines.join("\n"));
  return ed;
}
const select = (ed, a, b) => (ed.selection = { isEmpty: false, start: { line: a, character: 0 }, end: { line: b, character: 0 } });
const lastEditor = () => posted((m) => m.t === "editor");

test("the open file and the selection go with a message by default, as Claude Code's blocks; each setting turns its part off (decision 60)", { skip }, async () => {
  const inputs = path.join(dir, "inputs-60.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = inputs;
  try {
    await startUntracked("basic");
    const ed = fakeEditor("src/main.c", Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
    mock.vscode.window.activeTextEditor = ed;
    mock.vscode.window.visibleTextEditors = [ed];
    mock.bus.emit("activeEditor", ed);
    let e = await waitFor(() => lastEditor()?.editor?.label === "src/main.c" && lastEditor().editor, 3000, "the open file's chip");
    assert.equal(e.kind, "file");
    select(ed, 9, 24);
    mock.bus.emit("selection", { textEditor: ed });
    e = await waitFor(() => lastEditor()?.editor?.label === "src/main.c#L10-24" && lastEditor().editor, 3000, "the selection's chip, after its 300 ms");
    assert.equal(e.text, Array.from({ length: 15 }, (_, i) => `line ${i + 10}`).join("\n"));
    // The page sends it back with the message; the CLI gets Claude Code's block first.
    const { label: _l, ...item } = e;
    chatView.webview.fromPage({ t: "send", text: "what does this do?", editor: item });
    await waitFor(() => fs.existsSync(inputs) && fs.readFileSync(inputs, "utf8").includes("what does this do?"), 5000, "the message");
    const line = fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o).find((o) => o.type === "user");
    assert.equal(line.message.content[0].text, `<ide_selection>The user selected the lines 10 to 24 from ${path.join(folder, "src/main.c")}:\n${e.text}\n\nThis may or may not be related to the current task.</ide_selection>`);
    assert.deepEqual(line.message.content[1], { type: "text", text: "what does this do?" });
    const sent = posted((m) => m.t === "event" && m.e.type === "_sent");
    assert.deepEqual(sent.e.context, [item], "the rows under the message");
    // attachSelection off: the file alone; attachOpenFile off too: nothing.
    mock.state.config["embarchChat.attachSelection"] = false;
    mock.bus.emit("activeEditor", ed);
    await waitFor(() => lastEditor()?.editor?.kind === "file", 3000, "the file without its selection");
    mock.state.config["embarchChat.attachOpenFile"] = false;
    mock.bus.emit("activeEditor", ed);
    await waitFor(() => lastEditor() && lastEditor().editor === null, 3000, "nothing");
    // Focus in a webview leaves no active text editor; with none left on screen the chip goes.
    delete mock.state.config["embarchChat.attachSelection"];
    delete mock.state.config["embarchChat.attachOpenFile"];
    mock.bus.emit("activeEditor", ed);
    await waitFor(() => lastEditor()?.editor?.kind === "selection", 3000, "back");
    mock.bus.emit("activeEditor", undefined);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lastEditor().editor?.kind, "selection", "kept while the editor still shows");
    mock.vscode.window.visibleTextEditors = [];
    mock.bus.emit("activeEditor", undefined);
    await waitFor(() => lastEditor().editor === null, 3000, "gone with the last editor");
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
    mock.vscode.window.activeTextEditor = undefined;
    mock.vscode.window.visibleTextEditors = [];
  }
});

test("a terminal picked from @ goes with the message as its last 100 lines, read at send without taking focus; the clipboard is put back; two of one name are told apart by their process (decision 58; review r4 L2)", { skip }, async () => {
  const inputs = path.join(dir, "inputs-58.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = inputs;
  const buffer = Array.from({ length: 150 }, (_, i) => `[${i + 1}/150] Building C object`).join("\n") + "\nerror: 'x' undeclared\n\n\n";
  let selected = false;
  const shows = [];
  let active = null;
  // A terminal with a process says its id; minicom here (an extension's pseudoterminal, say) has none.
  const term = (name, pid) => {
    const t = { name, processId: Promise.resolve(pid), show: (preserveFocus) => ((active = t), shows.push([name, preserveFocus])) };
    return t;
  };
  mock.vscode.window.terminals = [term("west build", 4101), term("minicom", undefined), term("bash", 4103), term("bash", 4104)];
  const [west, minicom, bash1, bash2] = mock.vscode.window.terminals;
  const copies = new Map([[west, buffer], [minicom, null], [bash1, "the first bash"], [bash2, "the second bash"]]);
  mock.state.commands.set("workbench.action.terminal.selectAll", () => void (selected = true));
  // A terminal that copies nothing (minicom here) leaves the clipboard as it was.
  mock.state.commands.set("workbench.action.terminal.copySelection", () => void (selected && copies.get(active) !== null && (mock.state.clipboard = copies.get(active))));
  mock.state.commands.set("workbench.action.terminal.clearSelection", () => void (selected = false));
  mock.state.clipboard = "the owner's own clipboard";
  try {
    await startUntracked("basic");
    chatView.webview.fromPage({ t: "mention", q: "term" });
    const m = await waitFor(() => posted((x) => x.t === "mentions" && x.q === "term"), 3000, "the @ list");
    assert.deepEqual(
      m.items.filter((i) => i.terminal).map((i) => [i.label, i.detail, i.terminal]),
      [
        ["west build", "terminal output", { name: "west build", index: 0, pid: 4101 }],
        ["minicom", "terminal output", { name: "minicom", index: 1 }],
        ["bash", "terminal output · pid 4103", { name: "bash", index: 2, pid: 4103 }],
        ["bash", "terminal output · pid 4104", { name: "bash", index: 3, pid: 4104 }],
      ],
      "every terminal, two of one name told apart",
    );
    const picked = [m.items[0].terminal, m.items[1].terminal, m.items[3].terminal, { name: "gone", index: 7, pid: 9999 }];
    chatView.webview.fromPage({ t: "send", text: "why does the build fail?", terminals: picked });
    await waitFor(() => fs.existsSync(inputs) && fs.readFileSync(inputs, "utf8").includes("why does the build fail?"), 5000, "the message");
    const line = fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o).find((o) => o.type === "user");
    const want = buffer.trimEnd().split("\n").slice(-100).join("\n");
    assert.deepEqual(line.message.content, [
      { type: "text", text: `<terminal name="west build">\n${want}\n</terminal>` },
      { type: "text", text: `<terminal name="bash">\nthe second bash\n</terminal>` },
      { type: "text", text: "why does the build fail?" },
    ], "only the terminals that copied, the second bash the one picked: never the owner's clipboard as a terminal's output");
    assert.ok(want.startsWith("[52/150]") && want.endsWith("error: 'x' undeclared"));
    assert.equal(mock.state.clipboard, "the owner's own clipboard", "put back");
    assert.deepEqual(shows, [["west build", true], ["minicom", true], ["bash", true]], "each shown without taking focus: keys typed meanwhile stay out of the shell");
    assert.ok(posted((x) => x.t === "focus"), "the input gets focus back from the terminal");
    assert.ok(mock.state.executed.includes("embarchChat.chat.focus"), "and the view its");
    const sent = posted((x) => x.t === "event" && x.e.type === "_sent");
    assert.deepEqual(sent.e.context, [{ kind: "terminal", name: "west build", text: want }, { kind: "terminal", name: "bash", text: "the second bash" }]);
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
    mock.vscode.window.terminals = [];
    for (const c of ["selectAll", "copySelection", "clearSelection"]) mock.state.commands.delete(`workbench.action.terminal.${c}`);
  }
});

test("a message that waits behind another's terminal read goes to the chat it was written in, though the sidebar shows another by then", { skip }, async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  mock.vscode.window.terminals = [{ name: "slow build", show: () => {} }];
  // A read that takes a while, as select-copy on a long scrollback does.
  mock.state.commands.set("workbench.action.terminal.selectAll", () => gate);
  mock.state.commands.set("workbench.action.terminal.copySelection", () => void (mock.state.clipboard = "build output"));
  mock.state.commands.set("workbench.action.terminal.clearSelection", () => {});
  try {
    const b = await startUntracked("basic");
    const a = await startUntracked("basic");
    chatView.webview.fromPage({ t: "send", text: "why does the build fail?", terminals: [{ name: "slow build", index: 0 }] });
    chatView.webview.fromPage({ t: "send", text: "and the second question" });
    await new Promise((r) => setTimeout(r, 100));
    // The owner clicks another chat in the list before the first has gone.
    threadsView.webview.fromPage({ t: "open", sid: b });
    await waitFor(() => lastSnapshot()?.state.sessionId === b, 3000, "the other chat on screen");
    release();
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(!calls().some((c) => c.argv.includes("--input-format") && c.argv.includes(b)), "nothing started the chat on screen");
    const users = async (sid) => {
      threadsView.webview.fromPage({ t: "open", sid });
      const s = await waitFor(() => lastSnapshot()?.state.sessionId === sid && lastSnapshot(), 3000, "the chat on screen");
      return Object.values(s.state.entries).filter((e) => e.kind === "user").map((e) => e.text);
    };
    // The recording's own echo joins them: its text is not what was sent.
    const mine = ["why does the build fail?", "and the second question"];
    assert.deepEqual((await users(a)).filter((t) => mine.includes(t)), mine, "both in the chat they were written in");
    assert.deepEqual(await users(b), []);
  } finally {
    mock.vscode.window.terminals = [];
    for (const c of ["selectAll", "copySelection", "clearSelection"]) mock.state.commands.delete(`workbench.action.terminal.${c}`);
  }
});

test("keys: focus the chat's input, an @-mention of the selection, reopen the last closed chat tab — on chords Claude Code's own leave free (decision 59)", { skip }, async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const keys = Object.fromEntries(pkg.contributes.keybindings.map((k) => [`${k.command} ${k.when}`, k.key]));
  assert.deepEqual(keys, {
    "embarchChat.focus editorTextFocus": "ctrl+alt+escape",
    "embarchChat.blur !editorTextFocus": "ctrl+alt+escape",
    "embarchChat.insertAtMention editorTextFocus": "alt+shift+k",
    "embarchChat.reopenClosedChat embarchChat.lastClosedWasChat": "ctrl+shift+t",
  });
  const sid = await startUntracked("basic");
  const n = chatView.webview.posted.length;
  mock.state.executed.length = 0;
  await mock.state.commands.get("embarchChat.focus")();
  assert.ok(mock.state.executed.includes("embarchChat.chat.focus"), "the sidebar's chat comes forward");
  assert.ok(chatView.webview.posted.slice(n).some((m) => m.t === "focus"), "and its input takes focus");
  await mock.state.commands.get("embarchChat.blur")();
  assert.ok(mock.state.executed.includes("workbench.action.focusFirstEditorGroup"), "the same keys again leave it, as Claude Code's");
  const ed = fakeEditor("src/main.c", Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
  select(ed, 9, 24);
  mock.vscode.window.activeTextEditor = ed;
  try {
    await mock.state.commands.get("embarchChat.insertAtMention")();
    assert.equal(posted((m) => m.t === "insert")?.text, "@src/main.c#L10-24 ");
  } finally {
    mock.vscode.window.activeTextEditor = undefined;
  }
  // Ctrl+Shift+T: only while a chat tab was the last tab closed.
  await mock.state.commands.get("embarchChat.openInEditor")();
  const panels = mock.state.panels.length;
  mock.state.panels.at(-1).dispose();
  assert.equal(mock.state.context["embarchChat.lastClosedWasChat"], true);
  mock.bus.emit("tabs", { closed: [{ input: new mock.vscode.TabInputWebview("mainThreadWebview-embarchChat.chatTab") }], opened: [], changed: [] });
  assert.equal(mock.state.context["embarchChat.lastClosedWasChat"], true, "our own tab's close keeps it");
  mock.bus.emit("tabs", { closed: [{ input: {} }], opened: [], changed: [] });
  assert.equal(mock.state.context["embarchChat.lastClosedWasChat"], false, "any other tab's close hands the keys back to VS Code (and to Claude Code)");
  await mock.state.commands.get("embarchChat.reopenClosedChat")();
  assert.equal(mock.state.panels.length, panels + 1, "reopened");
  const tab = mock.state.panels.at(-1);
  tab.webview.fromPage({ t: "ready" });
  assert.equal([...tab.webview.posted].reverse().find((m) => m.t === "snapshot").state.sessionId, sid, "the last one closed first");
  // Earlier tests closed tabs too: each comes back, latest first, until none is left.
  const reopened = [tab];
  for (let i = 0; i < 20 && mock.state.context["embarchChat.lastClosedWasChat"]; i++) {
    await mock.state.commands.get("embarchChat.reopenClosedChat")();
    reopened.push(mock.state.panels.at(-1));
  }
  assert.equal(mock.state.context["embarchChat.lastClosedWasChat"], false, "none left");
  mock.state.executed.length = 0;
  await mock.state.commands.get("embarchChat.reopenClosedChat")();
  assert.ok(mock.state.executed.includes("workbench.action.reopenClosedEditor"), "nothing of ours: VS Code's own");
  for (const p of reopened) p.dispose();
});

test("Ctrl+Alt+Esc with lines selected: the editor chip is brought up to date first and the page told to skip a mention of the same lines — they go once (decisions 59, 60)", { skip }, async () => {
  await startUntracked("basic");
  const ed = fakeEditor("src/main.c", Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
  mock.vscode.window.activeTextEditor = ed;
  mock.vscode.window.visibleTextEditors = [ed];
  try {
    mock.bus.emit("activeEditor", ed);
    await waitFor(() => lastEditor()?.editor?.kind === "file", 3000, "the file's chip");
    // Selected just now: the key comes before the selection's 300 ms pause.
    select(ed, 9, 24);
    const n = chatView.webview.posted.length;
    await mock.state.commands.get("embarchChat.focus")();
    const after = chatView.webview.posted.slice(n);
    const chip = after.findIndex((m) => m.t === "editor" && m.editor?.label === "src/main.c#L10-24");
    const ins = after.findIndex((m) => m.t === "insert");
    assert.ok(chip >= 0 && ins > chip, "the chip's lines reach the page before the mention");
    assert.deepEqual(after[ins], { t: "insert", text: "@src/main.c#L10-24 ", unlessChip: { path: path.join(folder, "src/main.c"), startLine: 10, endLine: 24 } });
    assert.ok(after.some((m) => m.t === "focus"));
    // Alt+Shift+K asks for the mention itself: always inserted.
    await mock.state.commands.get("embarchChat.insertAtMention")();
    assert.deepEqual(posted((m) => m.t === "insert"), { t: "insert", text: "@src/main.c#L10-24 " });
  } finally {
    mock.vscode.window.activeTextEditor = undefined;
    mock.vscode.window.visibleTextEditors = [];
    mock.bus.emit("activeEditor", undefined);
  }
});

// Last: it gives the window's folder a desk of its own, which every test before it ran without.
test("the window's desk's reference index reaches each chat page, and the cards call carries what the draft matches — ghost text never (decision 88)", { skip }, async () => {
  const sid = await startUntracked("basic");
  const idOf = (r) => r.id ?? r.desk?.id;
  const d = idOf(await client.call("POST", "/desks", { name: "Refs desk", firmware_repos: [folder], github_repos: ["owner/repo"] }));
  // Seeded as a refresh would leave it, while the desk is stopped; it cannot read owner/repo (no account), so it keeps it.
  await desk.stop();
  const prs = INDEX.prs.filter((p) => p.repo === "owner/repo");
  fs.writeFileSync(path.join(dir, "desk", "data", "refs.json"), JSON.stringify({ [d]: { linear_scope: "", repos: ["owner/repo"], index: { ...INDEX, desk_id: d, prs } } }));
  await desk.start();
  await mock.state.commands.get("embarchChat.refresh")();
  const got = await waitFor(() => posted((m) => m.t === "refs" && m.refs?.issues.some((i) => i.key === "ABC-154")), 8000, "the index on the page");
  assert.deepEqual(got.refs.issues.map((i) => i.key), INDEX.issues.map((i) => i.key));
  assert.deepEqual(got.refs.prs.map((p) => `${p.repo}#${p.number}`), prs.map((p) => `${p.repo}#${p.number}`));
  assert.ok(!JSON.stringify(got).includes(fs.readFileSync(desk.tokenPath, "utf8").trim()), "never the token (20)");
  // A page that loads later gets it with its first snapshot, before it.
  await mock.state.commands.get("embarchChat.openInEditor")();
  const panel = mock.state.panels.at(-1);
  panel.webview.fromPage({ t: "ready" });
  await waitFor(() => panel.webview.posted.some((m) => m.t === "snapshot"), 3000, "the tab's snapshot");
  const order = panel.webview.posted.map((m) => m.t);
  assert.ok(order.indexOf("refs") >= 0 && order.indexOf("refs") < order.indexOf("snapshot"), order.join(","));
  panel.dispose();
  // Ghost text keeps its latency: no references (26).
  chatView.webview.fromPage({ t: "assist", kind: "ghost", text: VAGUE, seq: 881 });
  await waitFor(() => posted((m) => m.t === "ghost" && m.seq === 881 && m.done), 5000, "the ghost text");
  assert.ok(!calls().filter((x) => x.task === "ghost").at(-1).prompt.includes("desk_references"));
  // The cards: the references the draft matches, in the same single call, and the card names the PR.
  process.env.FAKE_HAIKU_CARDS = path.join(here, "fixtures", "haiku", "cards-refs.jsonl");
  try {
    const n = calls().length;
    chatView.webview.fromPage({ t: "assist", kind: "cards", text: VAGUE, seq: 882 });
    const c = await waitFor(() => posted((m) => m.t === "cards" && m.seq === 882), 5000, "the cards");
    const made = calls().slice(n);
    assert.deepEqual(made.map((x) => x.task), ["cards"], "one call");
    assert.ok(made[0].prompt.includes('<desk_references>\nIssues and PRs on this desk that the draft names, or whose titles share its words, best first:\n[r1] ABC-154 "Create the Widget" Done · PR owner/repo#36 "Widget" merged\n</desk_references>'), made[0].prompt);
    // Haiku named line r1; the reference is the extension's, from the index.
    assert.equal(c.cards[0].edit.op, "replace");
    assert.equal(c.cards[0].edit.with, 'PR owner/repo#36 "Widget" (ABC-154)');
    // The chat's folder is a clone of owner/repo (decisions 87, 88): its page hears it, and "PR 36" in a draft is that repo's.
    fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
    fs.writeFileSync(path.join(folder, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:owner/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    try {
      chatView.webview.fromPage({ t: "ready" });
      const snap = await waitFor(() => lastSnapshot()?.view.githubRepo === "owner/repo" && lastSnapshot(), 3000, "the repo on the page");
      assert.equal(snap.state.sessionId, sid);
      const k = calls().length;
      chatView.webview.fromPage({ t: "assist", kind: "cards", text: "add a test like PR 36 did and do step #3", seq: 883 });
      await waitFor(() => posted((m) => m.t === "cards" && m.seq === 883), 5000, "the cards");
      const p = calls().slice(k)[0].prompt;
      assert.ok(p.includes('[r1] ABC-154 "Create the Widget" Done · PR owner/repo#36 "Widget" merged'), p);
      assert.ok(!p.includes("[r2]"), "step #3 named nothing");
    } finally {
      fs.rmSync(path.join(folder, ".git"), { recursive: true, force: true });
    }
  } finally {
    delete process.env.FAKE_HAIKU_CARDS;
  }
  assert.equal(lastSnapshot().state.sessionId, sid);
});

test("chats open in editor tabs by default: a new chat is a tab, what it opens goes into the tab's group, and the list marks the tab in front (decision 92)", { skip }, async () => {
  delete mock.state.config["embarchChat.chatLocation"];
  try {
    const n = mock.state.panels.length;
    const sidebar = chatView.webview.posted.length;
    mock.state.quickPick = async (items) => items.find((i) => i.label.includes("Untracked"));
    await mock.state.commands.get("embarchChat.newChat")();
    const tab = await waitFor(() => mock.state.panels.length > n && mock.state.panels.at(-1), 5000, "the chat's tab");
    tab.webview.fromPage({ t: "ready" });
    const snap = await waitFor(() => tab.webview.posted.find((m) => m.t === "snapshot"), 3000, "the tab's snapshot");
    const sid = snap.state.sessionId;
    assert.equal(snap.view.inEditor, true);
    assert.ok(!chatView.webview.posted.slice(sidebar).some((m) => m.t === "snapshot" && m.state.sessionId === sid), "not in the sidebar");
    await waitFor(() => lastGroups()?.selected === sid, 3000, "the list marks it");
    // Opened from the tab: a tab of its own in the chat's group, beside it.
    tab.viewColumn = 2;
    const before = mock.state.executedArgs.length;
    tab.webview.fromPage({ t: "openFile", path: "src/main.c" });
    const opened = await waitFor(() => mock.state.executedArgs.slice(before).find(([id]) => id === "vscode.open"), 3000, "the file");
    assert.deepEqual([opened[1].fsPath, opened[2].viewColumn, opened[2].preview], [path.join(folder, "src", "main.c"), 2, false]);
    // The list opens it again in its tab, never the sidebar; another tab in front is the list's mark.
    const panels = mock.state.panels.length;
    threadsView.webview.fromPage({ t: "open", sid });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mock.state.panels.length, panels, "the same tab, brought forward");
    // A second chat's tab in front is the list's mark; back to the first, its mark again.
    await mock.state.commands.get("embarchChat.newChat")();
    const other = await waitFor(() => mock.state.panels.length > panels && mock.state.panels.at(-1), 5000, "the second chat's tab");
    await waitFor(() => lastGroups()?.selected && lastGroups().selected !== sid, 3000, "the second chat marked");
    tab.active = true;
    tab.em.emit("view");
    await waitFor(() => lastGroups()?.selected === sid, 3000, "the first marked again");
    tab.active = false;
    other.dispose();
    // Closed, it is no longer current.
    tab.dispose();
    await waitFor(() => lastGroups()?.selected === null, 3000, "nothing marked");
  } finally {
    mock.state.config["embarchChat.chatLocation"] = "sidebar";
    mock.state.quickPick = async () => undefined;
  }
});

// ------------------------------------------------------------ Promptu (decisions 94–98)

const promptuCalls = () => {
  const f = path.join(process.env.FAKE_PROMPTU_DIR, "log.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

test("Start work with Promptu: the pass on the issue, its dialog over the empty chat, the prompt in the draft, nothing sent (96, reversing 11)", { skip }, async () => {
  mock.state.config["embarchChat.promptuPath"] = FAKE_PROMPTU;
  try {
    const { id: item } = await client.call("POST", "/items", { title: "ABC-130 Loader retries", desk: "none" });
    await mock.state.commands.get("embarchChat.refresh")();
    const before = chatView.webview.posted.length;
    const starter = "Read ABC-130 with the desk's linear_get_issue tool, then wait.";
    await desk.withStart({ item_id: item, folder, prompt: starter });
    const snap = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "snapshot" && m.header?.itemId === item), 10000, "the mailbox chat");
    const sid = snap.state.sessionId;
    const ask = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "promptu" && m.sid === sid && m.view?.phase === "ask"), 10000, "the dialog's first page");
    assert.equal(ask.view.origin, "start");
    const prep = promptuCalls().filter((c) => c.cmd === "prep").at(-1);
    assert.ok(prep.args.includes("--start"), prep.args.join(" "));
    // The desk answered; the bench tools are here when this machine has the embarch-api binary on PATH.
    assert.equal(prep.args[prep.args.indexOf("--have") + 1], ["desk", ...(core.findBinary("embarch-api") ? ["embarch-api"] : [])].join(","));
    assert.match(prep.stdin, /^Work on /);
    assert.ok(prep.desk && prep.desk.id === item && prep.desk.text.includes("ABC-130"), "the desk's brief, read by the host");
    assert.equal(fs.realpathSync(prep.cwd), fs.realpathSync(folder));
    const stateMsg = [...chatView.webview.posted].reverse().find((m) => m.t === "promptuState");
    assert.equal(stateMsg.state.available, true);
    assert.ok(!JSON.stringify(chatView.webview.posted.slice(before)).includes(fs.readFileSync(desk.tokenPath, "utf8").trim()), "the token never reaches the page (20)");
    // The owner answers the page: nothing left, the prompt comes back for the draft.
    chatView.webview.fromPage({ t: "promptu", op: "answer", seq: ask.view.seq, input: { answers: { done: "Build and tests pass (Recommended)", goal: { other: "so units recover" } } } });
    const res = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "promptuResult" && m.result.sid === sid), 5000, "the result");
    assert.match(res.result.prompt, /^## Goal\nWork on /);
    assert.match(res.result.prompt, /— promptu implement-issue@1 /);
    assert.equal(res.result.fallback, undefined);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!chatView.webview.posted.slice(before).some((m) => m.t === "event" && (m.e.type === "_sent" || m.e.type === "result")), "nothing sent");
    assert.ok(!fs.readFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, "utf8").includes(starter), "the starter never went");
  } finally {
    mock.state.config["embarchChat.promptuPath"] = path.join(dir, "no-promptu");
  }
});

test("Start work with Promptu failing: one line, and the desk's starter is sent as decision 11 sent it (the owner's P2)", { skip }, async () => {
  mock.state.config["embarchChat.promptuPath"] = FAKE_PROMPTU;
  process.env.FAKE_PROMPTU_FAIL = "prep:1:the pass broke";
  try {
    const { id: item } = await client.call("POST", "/items", { title: "ABC-131 Fan curve", desk: "none" });
    const before = chatView.webview.posted.length;
    const starter = "Read ABC-131, then wait.";
    await desk.withStart({ item_id: item, folder, prompt: starter });
    const res = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "promptuResult"), 10000, "the result");
    assert.equal(res.result.error, "promptu prep failed (exit 1): the pass broke");
    assert.deepEqual([res.result.fallbackSent, res.result.fallback, res.result.prompt], [true, undefined, undefined]);
    await waitFor(() => chatView.webview.posted.slice(before).some((m) => m.t === "event" && m.e.type === "_sent" && m.e.text === starter), 5000, "the starter sent");
    assert.ok(!chatView.webview.posted.slice(before).some((m) => m.t === "draft"), "nothing in the draft");
  } finally {
    delete process.env.FAKE_PROMPTU_FAIL;
    mock.state.config["embarchChat.promptuPath"] = path.join(dir, "no-promptu");
  }
});

test("Enter at a task start: the page asks for the pass, Esc takes the rest as assumptions; Promptu off answers with one line", { skip }, async () => {
  mock.state.config["embarchChat.promptuPath"] = FAKE_PROMPTU;
  try {
    mock.state.quickPick = async (items) => items.find((i) => i.label.includes("Untracked"));
    await mock.state.commands.get("embarchChat.newChat")();
    const sid = await waitFor(() => {
      const s = lastSnapshot();
      return s && s.header?.untracked && !s.state.timeline.length && s.state.sessionId;
    }, 5000, "a new untracked chat");
    const before = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "promptu", op: "prep", text: "add a watchdog to the loader", pattern: "debug-failure" });
    const ask = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "promptu" && m.sid === sid && m.view?.phase === "ask"), 5000, "the page");
    const prep = promptuCalls().at(-1);
    assert.deepEqual([prep.cmd, prep.args.includes("--pattern") && prep.args[prep.args.indexOf("--pattern") + 1], prep.desk], ["prep", "debug-failure", null], "a forced pattern; untracked: no work item");
    chatView.webview.fromPage({ t: "promptu", op: "finish", seq: ask.view.seq, rest: "assume", input: { answers: {} } });
    const res = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "promptuResult" && m.result.sid === sid), 5000, "the result");
    assert.match(res.result.prompt, /assume=done,goal$/);
    // Turned off on the card: the next ask is one line, and nothing runs.
    chatView.webview.fromPage({ t: "promptuSettings", enabled: false });
    await waitFor(() => [...chatView.webview.posted].reverse().find((m) => m.t === "promptuState")?.state.enabled === false, 3000, "the card off");
    const n = promptuCalls().length;
    chatView.webview.fromPage({ t: "promptu", op: "prep", text: "again" });
    const off = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "promptuResult" && m.result.rough === "again"), 3000, "the one line");
    assert.match(off.result.error, /off or not installed/);
    assert.equal(promptuCalls().length, n);
    chatView.webview.fromPage({ t: "promptuSettings", enabled: true });
  } finally {
    mock.state.config["embarchChat.promptuPath"] = path.join(dir, "no-promptu");
    mock.state.quickPick = async () => undefined;
  }
});

test("the Memory menu: promptu memory --json for the chat's folder, and a click opens only a file it listed (98)", { skip }, async () => {
  mock.state.config["embarchChat.promptuPath"] = FAKE_PROMPTU;
  try {
    const before = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "promptuMemory" });
    const m = await waitFor(() => chatView.webview.posted.slice(before).find((x) => x.t === "promptuMemory"), 5000, "the menu's data");
    const soak = m.data.entries.find((e) => e.id === "08841b");
    assert.deepEqual([soak.stale, soak.used[0].pattern], [true, "bench-session"]);
    fs.mkdirSync(path.dirname(soak.file), { recursive: true });
    fs.writeFileSync(soak.file, "---\nname: x\n---\n");
    const n = mock.state.executedArgs.length;
    chatView.webview.fromPage({ t: "promptuOpen", file: soak.file });
    const opened = await waitFor(() => mock.state.executedArgs.slice(n).find(([id]) => id === "vscode.open"), 3000, "the file");
    assert.equal(opened[1].fsPath, soak.file);
    const k = mock.state.executedArgs.length;
    chatView.webview.fromPage({ t: "promptuOpen", file: "/etc/passwd" });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!mock.state.executedArgs.slice(k).some(([id]) => id === "vscode.open"), "a path the menu never listed is not opened");
    // Without the binary: one line.
    mock.state.config["embarchChat.promptuPath"] = path.join(dir, "no-promptu");
    const b2 = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "promptuMemory" });
    const e = await waitFor(() => chatView.webview.posted.slice(b2).find((x) => x.t === "promptuMemory"), 5000, "the error");
    assert.match(e.error, /not installed/);
  } finally {
    mock.state.config["embarchChat.promptuPath"] = path.join(dir, "no-promptu");
  }
});
