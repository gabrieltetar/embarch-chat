#!/usr/bin/env node
// The two webviews in headless Firefox, driven over geckodriver's W3C
// WebDriver HTTP API (no selenium): the built bundles load in a page whose
// `acquireVsCodeApi` records what the webview posts, recorded wire sessions
// are fed in as host messages, and the DOM and the posts are checked.
//
//   npm run test:webview          (needs geckodriver and firefox on PATH)
//   SHOTS=<dir> npm run test:webview   also saves screenshots there

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const core = require("../test-out/core.js");
const SHOTS = process.env.SHOTS;

// ------------------------------------------------------------ the page

const THEME = `:root{--vscode-font-family:sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;
--vscode-foreground:#ccc;--vscode-sideBar-background:#1f1f1f;--vscode-editor-background:#1e1e1e;--vscode-input-background:#2a2a2a;
--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ddd;
--vscode-descriptionForeground:#999;--vscode-textLink-foreground:#4daafc;--vscode-textCodeBlock-background:#2b2b2b;--vscode-panel-border:#333}`;

function page(bundle) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}</style>
<link rel="stylesheet" href="/dist/webview/${bundle}.css"></head><body><div id="app"></div>
<script>
window.__posts = []; window.__state = undefined;
window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posts.push(JSON.parse(JSON.stringify(m))), getState: () => window.__state, setState: (s) => (window.__state = s) });
</script>
<script src="/dist/webview/${bundle}.js"></script></body></html>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/chat.html" || u.pathname === "/list.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page(u.pathname.slice(1, -5)));
  }
  const file = path.join(root, u.pathname);
  if (!file.startsWith(path.join(root, "dist")) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/javascript" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------ webdriver

const WD_PORT = 4460 + Math.floor(Math.random() * 30);
const gecko = spawn("geckodriver", ["--port", String(WD_PORT)], { stdio: "ignore" });
const wdBase = `http://127.0.0.1:${WD_PORT}`;
async function wd(method, p, body) {
  const r = await fetch(wdBase + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${p}: ${j.value.error}: ${j.value.message}`);
  return j.value;
}
for (let i = 0; i < 50; i++) {
  try {
    await fetch(wdBase + "/status");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
const sess = await wd("POST", "/session", { capabilities: { alwaysMatch: { "moz:firefoxOptions": { args: ["-headless", "-width", "460", "-height", "900"] } } } });
const S = `/session/${sess.sessionId}`;
const exec = (script, args = []) => wd("POST", `${S}/execute/sync`, { script, args });
const settle = () =>
  wd("POST", `${S}/execute/async`, { script: "const done = arguments[0]; setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true))), 60);", args: [] });
const go = async (u) => {
  await wd("POST", `${S}/url`, { url: "about:blank" });
  await wd("POST", `${S}/url`, { url: base + u });
  for (let i = 0; i < 50; i++) {
    if (await exec("return window.__posts && window.__posts.some(p => p.t === 'ready')")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the webview never said ready");
};
const send = async (msgs) => {
  await exec("for (const m of arguments[0]) window.postMessage(m, '*');", [msgs]);
  await settle();
};
const posts = () => exec("return window.__posts");
const clearPosts = () => exec("window.__posts = [];");
const click = (sel, text) =>
  exec(
    `const els=[...document.querySelectorAll(arguments[0])].filter(e => !arguments[1] || e.textContent.includes(arguments[1]));
     if(!els.length) throw new Error('no '+arguments[0]+' '+(arguments[1]||'')); els[0].click(); return true;`,
    [sel, text ?? null],
  );
const text = (sel) => exec("return [...document.querySelectorAll(arguments[0])].map(e => e.textContent)", [sel]);
const shot = async (name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(await wd("GET", `${S}/screenshot`), "base64"));
};

// ------------------------------------------------------------ fixtures

const SID = "11111111-2222-4333-8444-555555555555";
const outLines = (name) =>
  fs
    .readFileSync(path.join(here, "fixtures", "wire", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.d === "out")
    .map((e) => e.o);
const HEADER = {
  itemId: "w1",
  issueKey: "ABC-123",
  issueUrl: "https://linear.example/ABC-123",
  title: "Make the widget blink",
  stateName: "In Progress",
  prs: [{ repo: "o/r", number: 42, title: "Blink", url: "https://github.example/o/r/pull/42", state: "open" }],
  todaySeconds: 4500,
  deskUrl: "http://127.0.0.1:4890/#desk?item=w1",
  untracked: false,
};
const OURS = { ours: true, readOnly: false, resumable: false, inEditor: false, uiUrl: "http://127.0.0.1:4890/", atlas: null };
const snapshot = (over = {}, view = OURS) => ({
  t: "snapshot",
  state: { ...core.initialState(SID), cwd: "/work/rec/x", process: "running", ...over },
  view,
  header: HEADER,
  warning: null,
});
const events = (lines) => lines.map((e) => ({ t: "event", e }));
const upTo = (lines, pred) => lines.slice(0, lines.findIndex(pred) + 1);
const sent = (text) => ({ t: "event", e: { type: "_sent", n: 1, text } });

let failed = 0;
async function check(name, f) {
  try {
    await f();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// ------------------------------------------------------------ the chat

await go("/chat.html");

await check("empty: no chat open offers a new one", async () => {
  await send([{ t: "empty", warning: null }]);
  await click("a", "start a chat");
  assert.ok((await posts()).some((p) => p.t === "newChat"));
});

await check("header: key, title, status, PR, today's time, Desk link", async () => {
  await send([snapshot()]);
  const h = (await text(".header"))[0];
  for (const s of ["ABC-123", "Make the widget blink", "In Progress", "#42 open", "today 1h 15m", "Desk"]) assert.ok(h.includes(s), `header lacks ${s}: ${h}`);
  await clearPosts();
  const sel = Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: ".header select" }))[0];
  await wd("POST", `${S}/element/${sel}/click`, {});
  await settle();
  assert.ok((await posts()).some((p) => p.t === "states"));
  await send([{ t: "states", states: [{ id: "s1", name: "Todo" }, { id: "s2", name: "In Progress" }, { id: "s3", name: "Done" }] }]);
  await exec("const s=document.querySelector('.header select'); s.value='s3'; s.dispatchEvent(new Event('change'))");
  assert.ok((await posts()).some((p) => p.t === "setStatus" && p.stateId === "s3"));
});

await check("a turn streams, then folds into a message, a Bash call and a reply", async () => {
  const lines = outLines("basic");
  await send([snapshot(), sent("Run the bash command `echo hello-from-bash` and then reply with just: done")]);
  assert.equal((await text(".user.pending")).length, 1, "pending until echoed");
  await send(events(lines));
  assert.equal((await text(".user.pending")).length, 0);
  assert.deepEqual(await text(".tool .name"), ["Bash"]);
  assert.ok((await text(".tool .summary"))[0].includes("echo hello-from-bash"));
  const md = await text(".timeline .md");
  assert.ok(md.includes("done") && md.includes("ok"), JSON.stringify(md));
  await click(".tool .line");
  assert.ok((await text(".tool pre.out")).some((t) => t.includes("hello-from-bash")));
  await shot("chat-basic");
});

await check("text shows while it streams, with a cursor", async () => {
  const lines = outLines("interrupt");
  const cut = lines.findIndex((o) => o.type === "stream_event" && o.event?.delta?.type === "text_delta");
  await send([snapshot(), sent("story"), ...events(lines.slice(0, cut + 1))]);
  assert.equal((await text(".live.cursor")).length, 1);
  assert.ok((await text(".status-line"))[0]?.includes("Working"));
  await clearPosts();
  await click(".composer button", "Stop");
  assert.ok((await posts()).some((p) => p.t === "interrupt"));
  await send(events(lines.slice(cut + 1)));
  assert.ok((await text(".note")).includes("Interrupted"));
  assert.equal((await text(".live")).length, 0);
});

await check("a permission prompt: Allow, Always allow, Deny with a message", async () => {
  const lines = outLines("deny");
  await send([snapshot(), sent("touch"), ...events(upTo(lines, (o) => o.type === "control_request"))]);
  const card = (await text(".card"))[0];
  assert.ok(card.includes("Allow Bash?") && card.includes("touch should-not-exist.txt"), card);
  assert.ok(card.includes("Always allow Bash(touch should-not-exist.txt)"), "the CLI's own suggestion");
  await clearPosts();
  await exec("const i=document.querySelector('.card .actions input'); i.value='use echo instead'; i.dispatchEvent(new Event('input', {bubbles:true}))");
  await settle();
  await click(".card button", "Deny");
  const p = (await posts()).find((x) => x.t === "deny");
  assert.equal(p.message, "use echo instead");
  assert.match(p.requestId, /-/);
});

await check("Claude's question: options with descriptions, answered", async () => {
  const lines = outLines("question");
  await send([snapshot(), sent("q"), ...events(upTo(lines, (o) => o.type === "control_request"))]);
  const card = (await text(".card"))[0];
  assert.ok(card.includes("Do you prefer tea or coffee?") && card.includes("Coffee") && card.includes("energizing"), card);
  await clearPosts();
  await exec("const o=[...document.querySelectorAll('.opt')].find(e=>e.textContent.includes('Coffee')); o.querySelector('input').click();");
  await settle();
  await click(".card button", "Answer");
  const p = (await posts()).find((x) => x.t === "answer");
  assert.deepEqual(p.answers, { "Do you prefer tea or coffee?": "Coffee" });
  await shot("chat-question");
});

await check("a plan: shown, approved", async () => {
  const lines = outLines("plan");
  await send([snapshot({ mode: "plan" }), sent("p"), ...events(upTo(lines, (o) => o.type === "control_request"))]);
  assert.ok((await text(".card .plan"))[0].includes("hello.txt"));
  await clearPosts();
  await click(".card button", "Approve");
  assert.ok((await posts()).some((p) => p.t === "allow"));
});

await check("Edit and Write show diffs that open VS Code's diff editor", async () => {
  await send([snapshot(), sent("e"), ...events(outLines("edit"))]);
  const names = await text(".tool .name");
  assert.deepEqual(names, ["Write", "Edit"]);
  const diffs = await text(".diff");
  assert.ok(diffs[1].includes("- two") && diffs[1].includes("+ three"), diffs[1]);
  assert.ok((await text(".diffstat"))[1].includes("+1"));
  await clearPosts();
  await exec("document.querySelectorAll('.tool')[1].querySelector('button').click()");
  const p = (await posts()).find((x) => x.t === "openDiff");
  assert.match(p.toolId, /^toolu_/);
  await shot("chat-edit");
});

await check("a subagent's steps nest under its call", async () => {
  await send([snapshot(), sent("s"), ...events(outLines("subagent"))]);
  const nested = await exec("return [...document.querySelectorAll('.tool .children .tool .name')].map(e=>e.textContent)");
  assert.deepEqual(nested, ["Bash"]);
  assert.deepEqual(await text(".timeline > div > .tool > .line .name"), ["Agent"]);
});

await check("@ asks the host for paths and inserts the pick; Enter sends", async () => {
  await send([snapshot()]);
  await clearPosts();
  const el = await wd("POST", `${S}/element`, { using: "css selector", value: ".composer textarea" });
  const id = Object.values(el)[0];
  await wd("POST", `${S}/element/${id}/value`, { text: "look at @no" });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await posts()).some((p) => p.t === "mention" && p.q === "no"));
  await send([{ t: "mentions", q: "no", items: [{ insert: "src/note.txt#L1-3", label: "note.txt", detail: "selected lines" }, { insert: "note.txt", label: "note.txt" }] }]);
  assert.equal((await text(".popup div")).length, 2);
  await wd("POST", `${S}/element/${id}/value`, { text: "\uE007" });
  await settle();
  assert.equal(await exec("return document.querySelector('.composer textarea').value"), "look at @src/note.txt#L1-3 ");
  await wd("POST", `${S}/element/${id}/value`, { text: "please\uE007" });
  await settle();
  const p = (await posts()).find((x) => x.t === "send");
  assert.equal(p.text, "look at @src/note.txt#L1-3 please");
});

await check("/ completes the session's commands", async () => {
  await send([snapshot({ slashCommands: ["compact", "context", "review"] })]);
  const el = await wd("POST", `${S}/element`, { using: "css selector", value: ".composer textarea" });
  const id = Object.values(el)[0];
  await wd("POST", `${S}/element/${id}/value`, { text: "/co" });
  await settle();
  assert.deepEqual(await text(".popup div"), ["/compact", "/context"]);
});

await check("mode and model switch, context meter and Compact", async () => {
  await send([snapshot({ context: { totalTokens: 150000, maxTokens: 200000, percentage: 75, categories: [{ name: "Messages", tokens: 150000 }] } })]);
  assert.ok((await text(".meter"))[0].includes("75%"));
  await clearPosts();
  await exec("const s=document.querySelectorAll('.composer select')[0]; s.value='plan'; s.dispatchEvent(new Event('change'))");
  await exec("const s=document.querySelectorAll('.composer select')[1]; s.value='opus'; s.dispatchEvent(new Event('change'))");
  await click(".meter button", "Compact");
  const ps = await posts();
  assert.ok(ps.some((p) => p.t === "mode" && p.mode === "plan"));
  assert.ok(ps.some((p) => p.t === "model" && p.model === "opus"));
  assert.ok(ps.some((p) => p.t === "compact"));
});

await check("a thread run elsewhere is read-only, with Jump", async () => {
  await send([snapshot({ process: "none" }, { ...OURS, ours: false, readOnly: true, where: "a terminal or Claude Code's panel" }), ...events(outLines("basic"))]);
  assert.equal((await text(".composer")).length, 0);
  assert.ok((await text(".readonly"))[0].includes("a terminal"));
  await clearPosts();
  await click(".readonly button", "Jump");
  assert.ok((await posts()).some((p) => p.t === "jump"));
});

await check("markdown: lists, code, tables, links, file paths, no HTML", async () => {
  const md = [
    "## Heading",
    "Some **bold**, *italic*, `inline` and a [link](https://example.com).",
    "",
    "- one",
    "  - nested",
    "- two with `src/main.c:42`",
    "",
    "1. first",
    "2. second",
    "",
    "```c",
    "int main(void) { return 0; }",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> quoted",
    "",
    "<script>alert(1)</script> stays text",
  ].join("\n");
  await send([snapshot(), { t: "event", e: { type: "assistant", message: { id: "m1", content: [{ type: "text", text: md }] }, parent_tool_use_id: null } }]);
  const counts = await exec(
    "const r=document.querySelector('.timeline .md'); return {h:r.querySelectorAll('h4').length, li:r.querySelectorAll('li').length, nested:r.querySelectorAll('li ul li').length, ol:r.querySelectorAll('ol li').length, pre:r.querySelectorAll('pre').length, td:r.querySelectorAll('td').length, q:r.querySelectorAll('blockquote').length, script:document.querySelectorAll('.timeline script').length, a:r.querySelectorAll('a').length, file:r.querySelectorAll('code.file').length}",
  );
  assert.deepEqual(counts, { h: 1, li: 5, nested: 1, ol: 2, pre: 1, td: 2, q: 1, script: 0, a: 1, file: 1 });
  await clearPosts();
  await click("code.file");
  const p = (await posts()).find((x) => x.t === "openFile");
  assert.deepEqual([p.path, p.line], ["src/main.c", 42]);
  await shot("chat-markdown");
});

const toolCall = (id, name, input) => ({ t: "event", e: { type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null } });
const toolResult = (id, text, isError = false) => ({ t: "event", e: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] }, parent_tool_use_id: null } });

await check("bench results show as cards: pass or fail, board, first error, steps, a link", async () => {
  const failedBuild = {
    success: false,
    reason: "build failed",
    timed_out: false,
    exit_code: 1,
    artifact_path: "/w/build/zephyr/zephyr.hex",
    artifact_fresh: false,
    stdout: "[1/40] Building C object\n",
    stderr: "../src/main.c: In function 'main':\n../src/main.c:12:5: error: 'led' undeclared (first use in this function)\nninja: build stopped: subcommand failed.\n",
    target: { project: "fw", board: "nrf54l15dk", app: "blinky" },
  };
  await send([
    snapshot(),
    toolCall("toolu_b1", "mcp__embarch-api__build_and_flash", { project: "fw" }),
    toolResult("toolu_b1", JSON.stringify(failedBuild, null, 2), true),
    toolCall("toolu_b2", "mcp__embarch-api__run_study", { study: {} }),
    toolResult("toolu_b2", JSON.stringify({ study_id: "st-42", reflashed: false })),
    toolCall("toolu_b3", "mcp__embarch-api__serial_log", { project: "fw" }),
    toolResult("toolu_b3", JSON.stringify({ port: "COM7", lines: ["boot ok", "ASSERTION FAIL @ main.c:40", "idle"] })),
    toolCall("toolu_b4", "mcp__embarch-api__flash", { project: "fw" }),
    toolResult("toolu_b4", "flash failed for 'fw': probe not found", true),
  ]);
  const cards = await exec(
    "return [...document.querySelectorAll('.bench')].map(b => ({cls: b.className, mark: b.querySelector('.bench-mark').textContent, board: b.querySelector('.bench-board')?.textContent, err: b.querySelector('.bench-error')?.textContent, head: b.querySelector('.bench-head').textContent}))",
  );
  assert.equal(cards.length, 4);
  assert.equal(cards[0].mark, "FAIL");
  assert.equal(cards[0].board, "nrf54l15dk · blinky");
  assert.match(cards[0].err, /main\.c:12:5: error: 'led' undeclared/);
  assert.ok(cards[0].head.includes("build ✗ · flash –"));
  assert.equal(cards[1].mark, "PASS");
  assert.match(cards[2].err, /ASSERTION FAIL/);
  assert.equal(cards[3].mark, "FAIL");
  assert.match(cards[3].err, /probe not found/);
  await clearPosts();
  await exec("document.querySelectorAll('.bench')[1].querySelector('.bench-link').click()");
  const p = (await posts()).find((x) => x.t === "openLink");
  assert.equal(p.url, "http://127.0.0.1:4890/#live-study?study=st-42");
  await shot("chat-bench");
});

await check("atlas citations become links when the repo has an atlas", async () => {
  const say = { t: "event", e: { type: "assistant", message: { id: "m-at", content: [{ type: "text", text: "VBUS tops out at 28 V (abc123@A p12) and is wired at A:U3-12; see also `abc123@A p3`." }] }, parent_tool_use_id: null } };
  await send([snapshot({}, { ...OURS, atlas: { docs: ["abc123@A"], boards: ["A", "B"] } }), say]);
  assert.deepEqual(await text("a.cite"), ["abc123@A p12", "A:U3-12"]);
  await clearPosts();
  await click("a.cite", "abc123@A p12");
  await click("a.cite", "A:U3-12");
  const ps = (await posts()).filter((x) => x.t === "atlas");
  assert.deepEqual(ps, [{ t: "atlas", doc: "abc123@A", page: 12 }, { t: "atlas", board: "A", ref: "U3-12" }]);
  await send([snapshot(), say]);
  assert.equal((await text("a.cite")).length, 0, "no atlas, no links");
});

// ------------------------------------------------------------ the list

await go("/list.html");

await check("the list: groups by item, waiting first, + per group, rows open", async () => {
  const DESK = { id: "k1", name: "Example", firmware_repos: ["/work/fw"] };
  const card = (id, key, sessions) => ({
    id,
    title: `${key} title`,
    issue: { key, url: "u", title: `${key} title`, state_name: "In Progress" },
    repo_path: "/work/fw",
    prs: [],
    last_activity_ms: 1000,
    live_sessions: sessions,
    tiles: [{ id: `${id}@d`, date: "2026-10-23", seconds: 1800 }],
  });
  const groups = core.buildThreads({
    view: {
      now_ms: 0,
      today: "2026-10-23",
      desks: [DESK],
      open_desk: DESK,
      cards: [
        card("w1", "ABC-1", [{ session_id: "a", name: "Terminal work", state: "busy", last_ms: Date.now() - 120000, cwd: "/work/fw" }]),
        card("w2", "ABC-2", [{ session_id: "b", name: "Needs an answer", state: "waiting", waiting_for: "permission: Bash", last_ms: Date.now() - 60000, cwd: "/work/fw", client: "embarch-chat" }]),
      ],
    },
    desk: DESK,
    repos: ["/work/fw"],
    own: [{ sessionId: "o", title: "My chat", status: "idle", itemId: "w1", lastMs: Date.now(), cwd: "/work/fw" }],
    past: [{ sessionId: "p", title: "Yesterday's chat", firstPrompt: null, cwd: "/work/fw", lastMs: Date.now() - 86400000 }],
    itemOf: {},
    now: Date.now(),
  });
  await send([{ t: "groups", groups, desk: "Example", error: null, selected: "o", now: Date.now() }]);
  const heads = await text(".group-head .gtitle");
  assert.deepEqual(heads.map((h) => h.trim()), ["ABC-2 ABC-2 title", "ABC-1 ABC-1 title", "Untracked"]);
  assert.deepEqual(await text(".badge"), ["1"]);
  assert.ok((await text(".thread .tmeta"))[0].includes("permission: Bash"));
  assert.equal((await text(".thread.sel .ttitle"))[0], "My chat");
  await clearPosts();
  await click(".thread .ttitle", "Terminal work");
  await click(".group-head .add");
  const ps = await posts();
  assert.ok(ps.some((p) => p.t === "open" && p.sid === "a"));
  assert.ok(ps.some((p) => p.t === "newChat" && p.itemId === "w2"));
  await shot("list");
});

await check("the list says so when the desk is down", async () => {
  await send([{ t: "groups", groups: [], desk: null, error: "The desk is not running — showing this window's chats only.", selected: null, now: Date.now() }]);
  assert.ok((await text(".warn-line"))[0].includes("not running"));
});

await wd("DELETE", S);
gecko.kill();
server.close();
console.log(failed ? `${failed} FAILED` : "all webview checks passed");
process.exit(failed ? 1 : 0);
