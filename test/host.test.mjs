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

const PORT = 4982;
const FAKE = path.join(here, "fake-claude.mjs");
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
  });
  mock.state.folders = [folder];
  ext = require("../dist/extension.js");
  context = { subscriptions: [], extensionUri: mock.vscode.Uri.file(root), workspaceState: new mock.Memento() };
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

test("Start work's mailbox entry starts a chat on the item and sends the prompt", { skip }, async () => {
  const { id: item } = await client.call("POST", "/items", { title: "ABC-124 from the Desk", desk: "none" });
  const before = chatView.webview.posted.length;
  // Start work leaves the entry server-side; the test seeds the desk's store as it would.
  const id = await desk.withStart({ item_id: item, folder, prompt: "Run the bash command `echo hello-from-bash` and then reply with just: done" });
  const snap = await waitFor(() => chatView.webview.posted.slice(before).find((m) => m.t === "snapshot" && m.header?.itemId === item), 10000, "the mailbox chat");
  await waitFor(() => chatView.webview.posted.slice(before).some((m) => m.t === "event" && m.e.type === "result"), 5000, "its first turn");
  assert.ok(snap.view.ours);
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
  assert.ok(c.cards.length >= 1);
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
  mock.state.external.length = 0;
  mock.state.opened.length = 0;
  for (const url of ["vscode://anthropic.claude-code/open?prompt=hi", "mailto:someone@example.com", "command:workbench.action.terminal.new", "file:///etc/hostname", "javascript:alert(1)"]) {
    chatView.webview.fromPage({ t: "openLink", url });
    chatView.webview.fromPage({ t: "openFile", path: url });
  }
  chatView.webview.fromPage({ t: "openLink", url: "https://example.com/docs" });
  chatView.webview.fromPage({ t: "openFile", path: "src/main.c" });
  await waitFor(() => mock.state.external.length && mock.state.opened.length, 3000, "the two that open");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(mock.state.external, ["https://example.com/docs"]);
  assert.equal(mock.state.opened.length, 1);
  assert.ok(mock.state.opened[0].endsWith("/src/main.c"), mock.state.opened[0]);
});

test("an open file with unsaved changes is saved before Claude reads it (decision 61)", { skip }, async () => {
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
  await startUntracked("autosave");
  const n = chatView.webview.posted.length;
  chatView.webview.fromPage({ t: "send", text: "Read note.txt, then use the Edit tool to change MANGO to KIWI in it. Then reply with just: done" });
  const ask = await waitFor(() => chatView.webview.posted.slice(n).find((m) => m.t === "event" && m.e.type === "control_request"), 5000, "the Edit's permission prompt");
  assert.deepEqual(saved, ["/work/rec/autosave/note.txt"], "saved once, before the Read");
  chatView.webview.fromPage({ t: "allow", requestId: ask.e.request_id });
  await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "result"), 5000, "the turn's end");
  assert.ok(mock.state.output.some((l) => l.includes("autosave: /work/rec/autosave/note.txt saved before Read")));
  mock.state.textDocuments.length = 0;
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

// ------------------------------------------------------------ a window reload (decision 63)

/** The window reloads: this extension host deactivates and a new one activates, with the same workspace state. */
async function reload(before = () => {}) {
  await ext.deactivate();
  for (const d of context.subscriptions) d.dispose?.();
  before();
  context = { subscriptions: [], extensionUri: mock.vscode.Uri.file(root), workspaceState: context.workspaceState };
  ext.activate(context);
  threadsView = new mock.FakeView();
  chatView = new mock.FakeView();
  mock.state.providers.get("embarchChat.threads").provider.resolveWebviewView(threadsView);
  mock.state.providers.get("embarchChat.chat").provider.resolveWebviewView(chatView);
  threadsView.webview.fromPage({ t: "ready" });
  chatView.webview.fromPage({ t: "ready" });
}

test("a reload brings the window's chats back, and one cut off mid-turn continues its step, labelled; after a close nothing comes back (decision 63)", { skip }, async () => {
  process.env.FAKE_CLAUDE_TRANSCRIPT = "prompt";
  try {
    const sid = await startUntracked("deny");
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
    assert.ok(mock.state.panels.length > tabsBefore && mock.state.panels.at(-1).title, "its tab back");
    const note = await waitFor(() => chatView.webview.posted.find((m) => m.t === "event" && m.e.type === "_note" && m.e.text === core.RERUN_NOTE), 10000, "the rerun's label");
    assert.ok(note);
    await waitFor(() => chatView.webview.posted.some((m) => m.t === "event" && m.e.type === "result"), 10000, "the step's end");
    const rerun = calls().slice(spawnsBefore).find((c) => c.argv.includes("--input-format"));
    assert.equal(rerun.argv.find((a) => a.startsWith("--resume")), `--resume=${sid}`);
    assert.equal(rerun.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, "1");
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

test("with continueAfterReload off, a chat cut off mid-turn comes back saying no reply follows, and nothing runs (decision 63)", { skip }, async () => {
  process.env.FAKE_CLAUDE_TRANSCRIPT = "prompt";
  mock.state.config["embarchChat.continueAfterReload"] = false;
  try {
    const sid = await startUntracked("deny");
    const n = chatView.webview.posted.length;
    chatView.webview.fromPage({ t: "send", text: "Run the bash command `touch should-not-exist.txt`. If it is refused, reply with just: refused" });
    await waitFor(() => chatView.webview.posted.slice(n).some((m) => m.t === "event" && m.e.type === "control_request"), 5000, "mid-turn");
    const spawnsBefore = calls().length;
    await reload();
    await waitFor(() => chatView.webview.posted.find((m) => m.t === "event" && m.e.type === "_note" && m.e.text === core.NO_REPLY_NOTE), 15000, "the no-reply note");
    assert.equal(lastSnapshot().state.sessionId, sid);
    assert.ok(!calls().slice(spawnsBefore).some((c) => c.argv.includes("--input-format")), "no process started");
  } finally {
    delete process.env.FAKE_CLAUDE_TRANSCRIPT;
    delete mock.state.config["embarchChat.continueAfterReload"];
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
  const target = path.join(dir, "exported.txt");
  let asked = null;
  mock.state.saveDialog = async (opts) => ((asked = opts), mock.vscode.Uri.file(target));
  chatView.webview.fromPage({ t: "exportSave", text: ex.text, filename: ex.filename });
  await waitFor(() => fs.existsSync(target), 3000, "the file");
  assert.equal(fs.readFileSync(target, "utf8"), ex.text);
  assert.equal(path.basename(asked.defaultUri.fsPath), ex.filename);
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
  // A fork keeps its name: Haiku names no fork (12).
  await new Promise((r) => setTimeout(r, 300));
  const haikuName = core.parseTurn(haikuAnswer("turn")).name;
  assert.ok(!chatView.webview.posted.slice(n1).some((m) => m.t === "event" && m.e.type === "_title" && m.e.title === haikuName), "no Haiku name");
});

test("Rewind code: a dry run for the confirmation, then the files only on the owner's word, and a note says so", { skip }, async () => {
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
  chatView.webview.fromPage({ t: "rewind", uuid: second, restore: "code" });
  await waitFor(() => evs().some((e) => e.type === "_note" && e.text === "Files rewound to before “Use the Edit tool to change one to two in a.txt. Then reply…”."), 5000, "the note");
  assert.ok(!chatView.webview.posted.slice(n).some((m) => m.t === "snapshot" && m.state.sessionId !== sid), "the files only: no fork");
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

test("a terminal picked from @ goes with the message as its last 100 lines, read at send; the clipboard is put back (decision 58)", { skip }, async () => {
  const inputs = path.join(dir, "inputs-58.jsonl");
  process.env.FAKE_CLAUDE_INPUT_LOG = inputs;
  const buffer = Array.from({ length: 150 }, (_, i) => `[${i + 1}/150] Building C object`).join("\n") + "\nerror: 'x' undeclared\n\n\n";
  let selected = false;
  let shown = 0;
  const term = (name) => ({ name, show: () => void shown++ });
  mock.vscode.window.terminals = [term("west build"), term("minicom")];
  const copies = { "west build": buffer, minicom: null };
  let active = "west build";
  mock.vscode.window.terminals[1].show = () => ((active = "minicom"), shown++);
  mock.vscode.window.terminals[0].show = () => ((active = "west build"), shown++);
  mock.state.commands.set("workbench.action.terminal.selectAll", () => void (selected = true));
  // A terminal that copies nothing (minicom here) leaves the clipboard as it was.
  mock.state.commands.set("workbench.action.terminal.copySelection", () => void (selected && copies[active] !== null && (mock.state.clipboard = copies[active])));
  mock.state.commands.set("workbench.action.terminal.clearSelection", () => void (selected = false));
  mock.state.clipboard = "the owner's own clipboard";
  try {
    await startUntracked("basic");
    chatView.webview.fromPage({ t: "mention", q: "term" });
    const m = await waitFor(() => posted((x) => x.t === "mentions" && x.q === "term"), 3000, "the @ list");
    assert.deepEqual(m.items.filter((i) => i.terminal).map((i) => [i.label, i.detail]), [["west build", "terminal output"], ["minicom", "terminal output"]]);
    chatView.webview.fromPage({ t: "send", text: "why does the build fail?", terminals: ["west build", "minicom", "gone"] });
    await waitFor(() => fs.existsSync(inputs) && fs.readFileSync(inputs, "utf8").includes("why does the build fail?"), 5000, "the message");
    const line = fs.readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l).o).find((o) => o.type === "user");
    const want = buffer.trimEnd().split("\n").slice(-100).join("\n");
    assert.deepEqual(line.message.content, [
      { type: "text", text: `<terminal name="west build">\n${want}\n</terminal>` },
      { type: "text", text: "why does the build fail?" },
    ], "only the terminal that copied: never the owner's clipboard as a terminal's output");
    assert.ok(want.startsWith("[52/150]") && want.endsWith("error: 'x' undeclared"));
    assert.equal(mock.state.clipboard, "the owner's own clipboard", "put back");
    assert.ok(shown >= 2);
    assert.ok(posted((x) => x.t === "focus"), "the input gets focus back from the terminal");
    assert.ok(mock.state.executed.includes("embarchChat.chat.focus"), "and the view its");
    const sent = posted((x) => x.t === "event" && x.e.type === "_sent");
    assert.deepEqual(sent.e.context, [{ kind: "terminal", name: "west build", text: want }]);
  } finally {
    delete process.env.FAKE_CLAUDE_INPUT_LOG;
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
