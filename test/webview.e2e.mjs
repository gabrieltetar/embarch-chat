#!/usr/bin/env node
// The two webviews in headless Firefox, driven over geckodriver's W3C
// WebDriver HTTP API (no selenium): the built bundles load in a page whose
// `acquireVsCodeApi` records what the webview posts, recorded wire sessions
// are fed in as host messages, and the DOM and the posts are checked.
//
//   npm run test:webview          (needs geckodriver and firefox on PATH)
//   SHOTS=<dir> npm run test:webview   also saves screenshots there
//
// The pages run in VS Code's Dark Modern unless `?kind=light` asks for Light
// Modern: its variables, and the theme kind's class VS Code puts on the body.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MEASURE_OPEN, MEASURE_UPDATES, longSession, streamedReply } from "./longsession.mjs";
import { INDEX } from "./refs-index.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const core = require("../test-out/core.js");
const SHOTS = process.env.SHOTS;

// ------------------------------------------------------------ the page

const THEME = `:root{--vscode-font-family:sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;
--vscode-foreground:#ccc;--vscode-sideBar-background:#1f1f1f;--vscode-editor-background:#1e1e1e;--vscode-input-background:#2a2a2a;
--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ddd;
--vscode-descriptionForeground:#999;--vscode-textLink-foreground:#4daafc;--vscode-textCodeBlock-background:#2b2b2b;--vscode-panel-border:#333;
--vscode-editorWidget-background:#202020;--vscode-editorSuggestWidget-background:#202020}`;
const THEME_LIGHT = `:root{--vscode-font-family:sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;
--vscode-foreground:#3b3b3b;--vscode-sideBar-background:#f8f8f8;--vscode-editor-background:#fff;--vscode-input-background:#fff;--vscode-input-border:#cecece;
--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
--vscode-descriptionForeground:#3b3b3b;--vscode-textLink-foreground:#005fb8;--vscode-textCodeBlock-background:#f8f8f8;--vscode-panel-border:#e5e5e5;
--vscode-editorWidget-background:#f8f8f8;--vscode-editorSuggestWidget-background:#f8f8f8}`;
const KINDS = { dark: { vars: THEME, body: "vscode-dark" }, light: { vars: THEME_LIGHT, body: "vscode-light" } };

// The page VS Code would get (src/views/page.ts): the same strict CSP —
// scripts by nonce only — and the title escaped; the stand-in for the
// webview's API rides in with the page's nonce, and so does VS Code's own
// click handler for webview pages (fixtures/vscode-webview-click.js), which
// records in `__vscode` what it would hand the workbench to open. `?title=`
// sets the title.
// The tests' scratch range (scratch-desk.mjs): EMBARCH_CHAT_TEST_PORT_BASE moves it.
const PORT_BASE = Number(process.env.EMBARCH_CHAT_TEST_PORT_BASE) || 4980;
const PAGE_PORT = PORT_BASE + 9;
const WD_PORT = PORT_BASE + 8;
const origin = `http://127.0.0.1:${PAGE_PORT}`;
const VSCODE_CLICK = fs.readFileSync(path.join(here, "fixtures", "vscode-webview-click.js"), "utf8");
function page(bundle, title, kind = KINDS.dark) {
  const nonce = Math.random().toString(36).slice(2);
  const head = `
<style>${kind.vars}</style>
<script nonce="${nonce}">
window.__posts = []; window.__state = undefined; window.__violations = []; window.__vscode = [];
document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(e.violatedDirective + " " + e.blockedURI));
window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posts.push(JSON.parse(JSON.stringify(m))), getState: () => window.__state, setState: (s) => (window.__state = s) });
const hostMessaging = { postMessage: (channel, data) => window.__vscode.push([channel, data && data.uri]) };
${VSCODE_CLICK}
window.addEventListener("click", handleInnerClick);
</script>`;
  const html = core.pageHtml({ nonce, cspSource: origin, js: `${origin}/dist/webview/${bundle}.js`, css: `${origin}/dist/webview/${bundle}.css`, title, head });
  // The stand-in must run before the bundle: it goes in <head>, ahead of the body's script.
  return html.replace("<body>", `<body class="${kind.body}">`);
}

/** The fonts the pages asked this origin for. */
const fontsServed = new Set();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/chat.html" || u.pathname === "/list.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page(u.pathname.slice(1, -5), u.searchParams.get("title") ?? "Chat", KINDS[u.searchParams.get("kind") ?? "dark"]));
  }
  const file = path.join(root, u.pathname);
  if (!file.startsWith(path.join(root, "dist")) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  if (file.endsWith(".woff2")) fontsServed.add(u.pathname);
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : "text/javascript";
  res.writeHead(200, { "content-type": type });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", r));
const base = origin;

// ------------------------------------------------------------ webdriver

const gecko = spawn("geckodriver", ["--port", String(WD_PORT)], { stdio: "ignore" });
const wdBase = `http://127.0.0.1:${WD_PORT}`;
let S = null;
// Whatever happens, the browser and geckodriver go with this run.
const teardown = async () => {
  if (S) await wd("DELETE", S).catch(() => {});
  S = null;
  gecko.kill();
  server.close();
};
process.on("uncaughtException", async (e) => {
  console.log(`FAIL (crashed): ${e.stack ?? e}`);
  await teardown();
  process.exit(1);
});
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
S = `/session/${sess.sessionId}`;
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

await check("a tool's whole input or output opens in an editor tab (decision 62)", async () => {
  await send([snapshot(), sent("b"), ...events(outLines("basic"))]);
  if (!(await text(".tool .open-tab")).length) await click(".tool .line");
  await clearPosts();
  await click(".tool .open-tab button", "Open output");
  await click(".tool .open-tab button", "Open input");
  const ps = (await posts()).filter((p) => p.t === "openContent");
  assert.deepEqual(ps.map((p) => p.part), ["output", "input"]);
  assert.match(ps[0].toolId, /^toolu_/);
  await shot("chat-open-tab");
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

await check("an Edit's card follows the changes kept in its diff tab, and Allow sends those (decision 64)", async () => {
  const lines = outLines("hunks");
  await send([snapshot({ mode: "default" }), sent("edit"), ...events(upTo(lines, (o) => o.type === "control_request"))]);
  const ask = lines.find((o) => o.type === "control_request");
  let diff = (await text(".card .diff"))[0];
  assert.ok(diff.includes("+ alpha=10") && diff.includes("+ delta=40"), diff);
  await send([{ t: "event", e: { type: "_proposed", requestId: ask.request_id, input: { ...ask.request.input, new_string: "alpha=10\nbeta=2\ngamma=3\ndelta=4" }, kept: "1 of 2 changes kept" } }]);
  diff = (await text(".card .diff"))[0];
  assert.ok(diff.includes("+ alpha=10") && !diff.includes("delta=40"), diff);
  assert.ok((await text(".card"))[0].includes("1 of 2 changes kept in the diff tab — Allow sends only those"));
  await clearPosts();
  await click(".card button", "Open diff");
  assert.deepEqual((await posts()).find((x) => x.t === "openDiff"), { t: "openDiff", requestId: ask.request_id });
  await shot("card-kept-changes");
});

await check("a step rerun after a reload shows under its label (decision 63)", async () => {
  await send([snapshot(), { t: "event", e: { type: "_note", text: core.RERUN_NOTE, tone: "info" } }, ...events(outLines("reload"))]);
  const notes = await text(".note");
  assert.ok(notes.some((t) => t.includes("Continuing the step that was interrupted when the window reloaded.")), JSON.stringify(notes));
  assert.deepEqual(await text(".tool .name"), ["Bash"]);
  await shot("chat-reload-rerun");
});

await check("a permission prompt: Allow, Always allow, Deny with a message", async () => {
  const lines = outLines("deny");
  await send([snapshot(), sent("touch"), ...events(upTo(lines, (o) => o.type === "control_request"))]);
  const card = (await text(".card"))[0];
  assert.ok(card.includes("Allow Bash?") && card.includes("touch should-not-exist.txt"), card);
  assert.deepEqual(await text(".card .always-what .grant"), ["Bash(touch should-not-exist.txt)", "access to deny/", "accept edits for this session"], "every one of the CLI's suggestions");
  await clearPosts();
  await exec("const i=document.querySelector('.card .actions input'); i.value='use echo instead'; i.dispatchEvent(new Event('input', {bubbles:true}))");
  await settle();
  await click(".card button", "Deny");
  const p = (await posts()).find((x) => x.t === "deny");
  assert.equal(p.message, "use echo instead");
  assert.match(p.requestId, /-/);
});

await check("Always allow: every suggestion to keep or drop, saved to one of Claude Code's four places — the owner's last, else the CLI's own; a change is remembered (decision 78)", async () => {
  const lines = outLines("deny");
  const prompt = upTo(lines, (o) => o.type === "control_request");
  const place = () => exec("return document.querySelector('.card .dest select').value");
  await send([snapshot({}, { ...OURS, permDestination: "projectSettings" }), sent("touch"), ...events(prompt)]);
  assert.equal(await place(), "projectSettings", "where the owner last saved one");
  await send([snapshot(), sent("touch"), ...events(prompt)]);
  assert.equal(await place(), "localSettings", "else the most lasting place the CLI named");
  assert.deepEqual(await text(".card .dest option"), ["this project (just you)", "all projects", "this project (shared)", "this session"]);
  await clearPosts();
  await exec("const s=document.querySelector('.card .dest select'); s.value='userSettings'; s.dispatchEvent(new Event('change', {bubbles:true}))");
  await settle();
  // The mode change dropped: only the rule and the directory are saved.
  await exec("[...document.querySelectorAll('.card .always-what .grant')].find((e) => e.textContent.includes('accept edits')).querySelector('input').click()");
  await settle();
  await shot("permission-always");
  await click(".card .actions button", "Always allow");
  const ps = await posts();
  assert.deepEqual(ps.find((p) => p.t === "permDestination"), { t: "permDestination", destination: "userSettings" }, "remembered");
  const a = ps.find((p) => p.t === "allow");
  assert.deepEqual([a.always, a.picks, a.destination], [true, [0, 1], "userSettings"]);
  await send([snapshot(), sent("touch"), ...events(prompt)]);
  assert.equal(await place(), "userSettings", "the next card starts at the owner's pick");
  // A mode change alone: one button that says what it does, and no place.
  const write = outLines("planmanual");
  const plan = write.find((o) => o.type === "control_request").request_id;
  await send([snapshot(), sent("p"), ...events(upTo(write, (o) => o.type === "control_request" && o.request?.tool_name === "Write")), { t: "event", e: { type: "_answered", requestId: plan, behavior: "allow" } }]);
  assert.deepEqual(await text(".card .actions button"), ["Allow", "Allow, and accept edits for this session", "Deny"]);
  assert.deepEqual(await text(".card .dest"), []);
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

await check("Other takes several lines — Shift+Enter breaks the line, Enter answers; the answered questions stay as a Questions row with the picks (decision 79)", async () => {
  const lines = outLines("questionmulti");
  const ask = lines.findIndex((o) => o.type === "control_request");
  await send([snapshot(), sent("q"), ...events(lines.slice(0, ask + 1))]);
  await exec("for (const o of document.querySelectorAll('.card .opt')) if (/Apple|Pear/.test(o.textContent)) o.querySelector('input').click();");
  await settle();
  await clearPosts();
  await exec("document.querySelectorAll('.card textarea.other')[1].setAttribute('data-o', '1')");
  const el = Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: "textarea[data-o='1']" }))[0];
  // Shift+Enter; a call's modifiers are let go at its end.
  await wd("POST", `${S}/element/${el}/value`, { text: "P0.13 LED1\uE008\uE007" });
  await wd("POST", `${S}/element/${el}/value`, { text: "P0.14 LED2" });
  await settle();
  assert.equal(await exec("return document.querySelector(\"textarea[data-o='1']\").value"), "P0.13 LED1\nP0.14 LED2");
  assert.deepEqual(await posts(), [], "Shift+Enter answers nothing");
  await shot("question-other-lines");
  await wd("POST", `${S}/element/${el}/value`, { text: "\uE007" });
  await settle();
  const a = (await posts()).find((p) => p.t === "answer");
  assert.deepEqual(a.answers, { "Which fruits do you like?": "Apple, Pear", "Which board should you use?": "P0.13 LED1\nP0.14 LED2" });
  // The CLI's answer and the rest of the turn: the card goes, the row stays.
  await send([{ t: "event", e: { type: "_answered", requestId: a.requestId, behavior: "allow" } }, ...events(lines.slice(ask + 1))]);
  assert.deepEqual(await text(".card"), []);
  const row = (await text(".tool .line"))[0];
  assert.ok(row.includes("Questions") && row.includes("Answered · 2 questions"), row);
  assert.deepEqual(await text(".qa .qa-opt.picked > span:last-child > div:first-child"), ["Apple", "Pear", "Other"]);
  assert.deepEqual(await text(".qa .qa-opt .typed"), ["P0.13 LED1\nP0.14 LED2"]);
  assert.deepEqual(await text(".qa .qa-opt.dim > span:last-child > div:first-child"), ["Plum", "DK", "EVK"]);
  await shot("chat-questions-row");
});

await check("Other with picks: several picks go with Other's text; one pick gives way to it — the card shows what goes (review r4 P1)", async () => {
  const lines = outLines("questionmulti");
  const ask = lines.findIndex((o) => o.type === "control_request");
  await send([snapshot(), sent("q"), ...events(lines.slice(0, ask + 1))]);
  await exec("for (const o of document.querySelectorAll('.card .opt')) if (/Apple|DK/.test(o.textContent)) o.querySelector('input').click();");
  await settle();
  const other = async (n, text) => {
    await exec(`document.querySelectorAll('.card textarea.other')[${n}].setAttribute('data-p1', '${n}')`);
    const el = Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: `textarea[data-p1='${n}']` }))[0];
    await wd("POST", `${S}/element/${el}/value`, { text });
    await settle();
  };
  await other(0, "Kiwi");
  await other(1, "my own board");
  const ticked = await exec("return [...document.querySelectorAll('.card .opt')].filter((o) => o.querySelector('input').checked).map((o) => o.querySelector('span > div').textContent)");
  assert.deepEqual(ticked, ["Apple"], "the board's DK gave way to Other's text; the fruit's Apple stays");
  await clearPosts();
  await click(".card button", "Answer");
  const a = (await posts()).find((p) => p.t === "answer");
  assert.deepEqual(a.answers, { "Which fruits do you like?": "Apple, Kiwi", "Which board should you use?": "my own board" });
});

await check("a plan: Claude Code's three answers, auto mode first; Open to comment asks for its tab (decision 77)", async () => {
  const lines = outLines("plan");
  await send([snapshot({ mode: "plan" }), sent("p"), ...events(upTo(lines, (o) => o.type === "control_request"))]);
  assert.ok((await text(".card .plan"))[0].includes("hello.txt"));
  assert.deepEqual(await text(".card .actions button"), ["Yes, and use auto mode", "Yes, and manually approve edits", "No, keep planning"]);
  assert.deepEqual(await text(".card .actions button.primary"), ["Yes, and use auto mode"]);
  await shot("plan-card");
  await clearPosts();
  await click(".card button", "Open to comment");
  await click(".card button", "Yes, and use auto mode");
  await click(".card button", "Yes, and manually approve edits");
  const ps = await posts();
  const req = lines.find((o) => o.type === "control_request").request_id;
  assert.deepEqual(ps.map((p) => [p.t, p.requestId, p.mode]), [
    ["openPlan", req, undefined],
    ["allow", req, "auto"],
    ["allow", req, "default"],
  ]);
});

await check("a plan's comments from its tab: listed with their lines and ×; then only keep planning, which sends them (decision 77)", async () => {
  const lines = outLines("plan");
  await send([snapshot({ mode: "plan" }), sent("p"), ...events(upTo(lines, (o) => o.type === "control_request"))]);
  const req = lines.find((o) => o.type === "control_request").request_id;
  const comments = [
    { id: "c1", start: 0, end: 0, selectedText: "1. Create hello.txt in the working directory using the Write tool.", comment: "Name it greeting.txt" },
    { id: "c2", start: 1, end: 1, selectedText: "2. Set its contents to \"hi\".", comment: "and end it with a newline" },
  ];
  await send([{ t: "event", e: { type: "_planComments", requestId: req, comments } }]);
  assert.equal((await text(".card .card-title span"))[0], "Continue planning");
  assert.deepEqual(await text(".plan-comment .quote"), ['"1. Create hello.txt in the working directory using the Write tool."', '"2. Set its contents to "hi"."']);
  assert.ok((await text(".plan-comments .muted"))[0].includes("2 comments"));
  assert.deepEqual(await text(".card .actions button"), ["Send feedback and keep planning"], "no approving past comments, as in Claude Code");
  await shot("plan-comments");
  await clearPosts();
  await click(".plan-comment button");
  await exec("const t=document.querySelector('.card textarea'); t.value='also check the encoding'; t.dispatchEvent(new Event('input', {bubbles:true}))");
  await settle();
  await click(".card .actions button", "Send feedback and keep planning");
  assert.deepEqual(
    (await posts()).map((p) => [p.t, p.id ?? p.message]),
    [
      ["removePlanComment", "c1"],
      ["deny", "also check the encoding"],
    ],
  );
});

await check("a compaction is one folded card, Claude Code's line; it opens to the summary (decision 76)", async () => {
  const lines = outLines("compact");
  await send([snapshot(), sent("@note.txt what is the secret? One word."), ...events(upTo(lines, (o) => o.type === "result"))]);
  await send([{ t: "event", e: { type: "_sent", n: 2, text: "/compact focus on: the secret word in note.txt" } }, ...events(lines.slice(lines.findIndex((o) => o.type === "result") + 1))]);
  assert.deepEqual(await text("details.compacted > summary"), ["Compacted chat · manual · 1k tokens freed"]);
  assert.equal(await exec("return document.querySelector('details.compacted').open"), false, "folded");
  assert.ok(!(await text(".note")).includes("Compacted"), "no second line");
  await click("details.compacted > summary");
  const inside = (await text("details.compacted .compact-summary"))[0];
  assert.ok(inside.includes("continued from a previous conversation") && inside.includes("MANGO"), inside);
  await shot("chat-compacted");
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

// Decision 50: a step says what the agent is doing in its own words, and a
// run of quiet steps folds into one row.
const stepLabels = (sel) =>
  exec(
    "return [...document.querySelectorAll(arguments[0])].map(l => l.querySelector(':scope > .what')?.textContent ?? [...l.querySelectorAll(':scope > .name, :scope > .summary')].map(e => e.textContent).join(' '))",
    [sel],
  );
const runRows = () =>
  exec(
    "return [...document.querySelectorAll('.timeline > div > .run')].map(r => ({ count: r.querySelector(':scope > .line .count')?.textContent, st: [...r.querySelectorAll(':scope > .line .st')].map(e => e.textContent).join(' '), spin: !!r.querySelector(':scope > .line .spinner'), open: !!r.querySelector(':scope > .steps') }))",
  );

await check("a run of quiet steps folds into one row: its latest step's own description, N steps, a red count; collapsed", async () => {
  await send([snapshot(), ...events(outLines("steps"))]);
  await shot("chat-turns");
  assert.deepEqual(await runRows(), [{ count: "6 steps", st: "1 error", spin: false, open: false }]);
  assert.deepEqual(await stepLabels(".timeline > div > .run > .line"), ["Print current year"]);
  // The second turn's one step is a plain row: its description, the tool a tag.
  assert.deepEqual(await stepLabels(".timeline > div > .tool:not(.run) > .line"), ["Echo second-turn"]);
  assert.deepEqual(await text(".timeline > div > .tool:not(.run) > .line .name"), ["Bash"]);
  assert.ok((await text(".timeline .md")).includes("done"));
  await shot("chat-run-collapsed");
});

await check("a run opens to one line per step, each opening to its input and output; the toggle sticks", async () => {
  await send([snapshot(), ...events(outLines("steps"))]);
  await click(".run > .line");
  assert.deepEqual(await stepLabels(".run .steps .tool > .line"), [
    "List files in current directory",
    "Read note.txt",
    "Count bytes in note.txt",
    "Grep MANGO  in /work/rec/steps",
    "Try to read missing.txt",
    "Print current year",
  ]);
  assert.deepEqual(await text(".run .steps .tool > .line .st.error"), ["error"]);
  await click(".run .steps .tool > .line", "Try to read missing.txt");
  const out = await text(".run .steps .tool pre.out");
  assert.ok(out[0].startsWith("$ cat missing.txt") && out[1].includes("No such file"), JSON.stringify(out));
  await shot("chat-run-expanded");
  // Re-rendered by a new event, and by a new snapshot of the same chat: still open.
  await send([{ t: "event", e: { type: "_title", title: "Steps" } }]);
  assert.equal((await runRows())[0].open, true);
  await send([snapshot(), ...events(outLines("steps"))]);
  assert.equal((await runRows())[0].open, true, "the owner's toggle sticks, by the run's first step");
  await click(".run > .line");
  assert.equal((await runRows())[0].open, false);
});

await check("a streaming step joins the run at once; its description heads the run once it has arrived; the row stays when it lands", async () => {
  const lines = outLines("steps");
  const callIds = lines.filter((o) => o.type === "assistant").flatMap((o) => o.message.content.filter((b) => b.type === "tool_use").map((b) => b.id));
  const startOf = (id) => lines.findIndex((o) => o.type === "stream_event" && o.event?.content_block?.id === id);
  const landOf = (id) => lines.findIndex((o) => o.type === "assistant" && o.message.content.some((b) => b.id === id));
  // The first step alone, streaming then landed: one plain row, the same element.
  await send([snapshot(), ...events(lines.slice(0, landOf(callIds[0])))]);
  assert.deepEqual(await runRows(), []);
  assert.deepEqual(await stepLabels(".timeline > div > .tool:not(.run) > .line"), ["List files in current directory"]);
  assert.equal((await text(".timeline > div > .tool:not(.run) .spinner")).length, 1);
  await exec("document.querySelector('.timeline > div > .tool:not(.run)').__mark = 1");
  await send(events(lines.slice(landOf(callIds[0]), startOf(callIds[1]))));
  assert.equal(await exec("return document.querySelector('.timeline > div > .tool:not(.run)').__mark"), 1, "no new row when the step lands");
  // The third call streams in two pieces: the command, then its description.
  const s3 = startOf(callIds[2]);
  const d3 = lines.findIndex((o, i) => i > s3 && o.event?.delta?.type === "input_json_delta" && o.event.delta.partial_json);
  const pj = lines[d3].event.delta.partial_json;
  const cut = pj.indexOf('"description"') + '"description": "Count'.length;
  const piece = (s) => ({ ...lines[d3], event: { ...lines[d3].event, delta: { type: "input_json_delta", partial_json: s } } });
  await send(events([...lines.slice(startOf(callIds[1]), s3 + 1)]));
  assert.deepEqual(await runRows(), [{ count: "3 steps", st: "", spin: true, open: false }], "the streaming call is the run's third step");
  await send(events([piece(pj.slice(0, cut))]));
  assert.deepEqual(await stepLabels(".run > .line"), ["Bash wc -c note.txt"], "no description yet: its tool and command");
  await click(".run > .line");
  await exec("document.querySelector('.run').__mark = 1; document.querySelectorAll('.run .steps .tool')[2].__mark = 1");
  await send(events([piece(pj.slice(cut))]));
  assert.deepEqual(await stepLabels(".run > .line"), ["Count bytes in note.txt"]);
  await send(events(lines.slice(d3 + 1, landOf(callIds[2]) + 1)));
  assert.deepEqual(await stepLabels(".run > .line"), ["Count bytes in note.txt"]);
  assert.deepEqual(await exec("return [document.querySelector('.run').__mark, document.querySelectorAll('.run .steps .tool')[2].__mark]"), [1, 1], "the same run and the same step row once it lands");
  assert.equal((await runRows())[0].count, "3 steps");
  await shot("chat-run-live");
});

await check("turns: 12 px between blocks, 28 px and a rule between turns, none above the first", async () => {
  await send([snapshot(), ...events(outLines("steps"))]);
  const rows = await exec(
    // The space from one block's box to the next one's content: the gap, and a turn's rule and padding.
    "const ws=[...document.querySelectorAll('.timeline > div')]; return ws.map((w,i)=>{ const cs=getComputedStyle(w); return { user: !!w.querySelector(':scope > .user'), rule: cs.borderTopWidth, gap: i ? Math.round(w.getBoundingClientRect().top - ws[i-1].getBoundingClientRect().bottom + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)) : null }; })",
  );
  assert.deepEqual(
    rows.map((r) => [r.user, r.rule, r.gap]),
    [
      [true, "0px", null],
      [false, "0px", 12],
      [false, "0px", 12],
      [true, "1px", 29],
      [false, "0px", 12],
      [false, "0px", 12],
    ],
  );
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
  // With the page's own /copy (decision 74) and /remote-control, which holds "co" too.
  assert.deepEqual(await text(".popup div"), ["/compact", "/context", "/copy", "/remote-control"]);
});

await check("mode and model switch, context meter and Compact", async () => {
  await send([snapshot({ context: { totalTokens: 150000, maxTokens: 200000, percentage: 75, categories: [{ name: "Messages", tokens: 150000 }] } })]);
  assert.ok((await text(".meter"))[0].includes("75%"));
  await clearPosts();
  await exec("const s=document.querySelectorAll('.composer select')[0]; s.value='plan'; s.dispatchEvent(new Event('change'))");
  // The model is in Claude Code's model pill now: its list opens over the input.
  await click(".composer .pill.model");
  await settle();
  await exec("[...document.querySelectorAll('.model-pop .pop-row')].find((e) => e.textContent.startsWith('Opus')).click()");
  await click(".meter button", "Compact");
  const ps = await posts();
  assert.ok(ps.some((p) => p.t === "mode" && p.mode === "plan"));
  assert.ok(ps.some((p) => p.t === "model" && p.model === "opus"));
  assert.ok(ps.some((p) => p.t === "compact"));
});

await check("the model pill: model, effort and Ultracode for this chat, as Claude Code's — the levels the model takes, Ultracode where the CLI offers it, none of it on Haiku (its changelog L2008, L1858, L416)", async () => {
  const lines = outLines("effort");
  const models = core.modelInfos(lines.find((o) => o.type === "control_response" && o.response.response?.models).response.response.models);
  const applied = (effort, ultracode, model = "claude-sonnet-5-5", ultracodeAvailable = true) => ({ model, effort, ultracode, ultracodeAvailable });
  // Picked before the first message: nothing runs, so the pill shows the pick.
  await send([snapshot({ process: "none", effort: "low" })]);
  assert.deepEqual(await text(".composer .pill.model"), ["Default · low"]);
  await send([snapshot({ model: "claude-sonnet-5-5", models, applied: applied("low", false), effort: "low" })]);
  assert.deepEqual(await text(".composer .pill.model"), ["Sonnet · low"]);
  await click(".composer .pill.model");
  await settle();
  assert.deepEqual(await text(".model-pop .pop-row"), ["Default model", "Opus", "Sonnet", "Haiku"], "the panel's list, as before");
  assert.deepEqual(await text(".model-pop .pop-row.on"), ["Sonnet"]);
  assert.deepEqual(await text(".model-pop .effort-row button"), ["Default", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(await text(".model-pop .effort-row button.on"), ["low"]);
  assert.equal(await exec("return document.querySelector('.model-pop .ultracode input').checked"), false);
  await shot("model-pop");
  await clearPosts();
  await click(".model-pop .effort-row button", "high");
  await click(".model-pop .ultracode input");
  assert.deepEqual((await posts()).filter((p) => p.t === "effort"), [
    { t: "effort", effort: "high", ultracode: false },
    { t: "effort", effort: "low", ultracode: true },
  ]);
  // The CLI says what runs: the pill follows it.
  await send([{ t: "event", e: { type: "_effort", effort: "high", ultracode: true } }, { t: "event", e: { type: "_applied", applied: applied("high", true) } }]);
  assert.deepEqual(await text(".composer .pill.model"), ["Sonnet · high · Ultracode"]);
  await clearPosts();
  await click(".model-pop .effort-row button", "Default");
  assert.deepEqual((await posts()).filter((p) => p.t === "effort"), [{ t: "effort", effort: null, ultracode: true }], "back to the model's own level");
  // Haiku takes no effort, and the CLI offers no Ultracode on it.
  await send([{ t: "event", e: { type: "_model", model: "haiku" } }, { t: "event", e: { type: "_applied", applied: applied(null, false, "claude-haiku-4-5-20251001", false) } }]);
  assert.deepEqual(await text(".composer .pill.model"), ["Haiku"]);
  assert.deepEqual(await text(".model-pop .effort-row button"), []);
  assert.ok((await text(".model-pop .pop-note"))[0].includes("takes no effort level"));
  assert.equal(await exec("return document.querySelectorAll('.model-pop .ultracode').length"), 0);
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await settle();
  assert.equal((await text(".model-pop")).length, 0);
});

await check("the Remote Control pill, in Claude Code's words: connecting, then on — a click opens the session on claude.ai/code — or failed until /remote-control dismisses it; nothing while off (its changelog L5709, L2097)", async () => {
  const lines = outLines("remote");
  const answer = lines.find((o) => o.type === "control_response" && o.response.response?.session_url).response.response;
  const connected = lines.find((o) => o.type === "system" && o.subtype === "bridge_state" && o.state === "connected");
  await send([snapshot(), ...events(upTo(lines, (o) => o.type === "result"))]);
  assert.equal((await text(".composer .pill.remote")).length, 0, "off: no pill");
  await exec("const t = document.querySelector('.composer textarea'); t.value = '/rem'; t.dispatchEvent(new Event('input', { bubbles: true }))");
  await settle();
  assert.ok((await text(".popup div")).some((t) => t.startsWith("/remote-control")), "the panel's own command completes");
  await exec("const t = document.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true }))");
  // Typed, it is the page's to answer (as /rewind is): the host is asked, nothing goes to Claude.
  await clearPosts();
  const ta = Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: ".composer textarea" }))[0];
  await wd("POST", `${S}/element/${ta}/value`, { text: "/remote-control phone \uE007" });
  await settle();
  assert.deepEqual((await posts()).filter((p) => p.t === "remoteControl" || p.t === "send"), [{ t: "remoteControl", name: "phone" }]);
  await send([{ t: "event", e: { type: "_remote", remote: { status: "connecting" } } }]);
  assert.equal(await exec("return document.querySelector('.composer .pill.remote.connecting').title"), "Connecting to claude.ai/code…");
  await send([{ t: "event", e: { type: "_remote", remote: { status: "connecting", url: answer.session_url, epoch: answer.bridge_epoch } } }, { t: "event", e: connected }]);
  const on = await exec("const b = document.querySelector('.composer button.pill.remote.on'); return b && [b.textContent, b.title]");
  assert.deepEqual(on, ["Remote Control", "Remote Control is active · Click to open claude.ai/code · Run /remote-control to turn off"]);
  await shot("remote-pill");
  await clearPosts();
  await click(".composer .pill.remote.on");
  assert.deepEqual((await posts()).filter((p) => p.t === "openLink"), [{ t: "openLink", url: "https://claude.ai/code/session_01FIXTURE0000000000000000" }]);
  await send([{ t: "event", e: { type: "system", subtype: "bridge_state", state: "failed", bridge_epoch: answer.bridge_epoch, detail: "the session expired" } }]);
  assert.deepEqual(await exec("const p = document.querySelector('.composer .pill.remote.bad'); return [p.textContent, p.title]"), ["Remote Control ✗", "Remote Control error: the session expired · Run /remote-control to dismiss"]);
  await send([{ t: "event", e: { type: "_remote", remote: null } }]);
  assert.equal((await text(".composer .pill.remote")).length, 0, "dismissed");
  // A bridge Claude Code started by itself, not /remote-control here: on all the same, with no link to open (review r4 L6).
  await send([{ t: "event", e: { type: "system", subtype: "bridge_state", state: "connected", bridge_epoch: 7 } }]);
  const auto = await exec("const p = document.querySelector('.composer .pill.remote.on'); return p && [p.tagName, p.textContent, p.title]");
  assert.deepEqual(auto, ["SPAN", "Remote Control", "Remote Control is active: Claude Code started it for this session · Run /remote-control to turn off"]);
});

await check("Keep, on a block of Claude's reply, sends it to the work item as a finding or a decision: in one row with the turn's Copy under its last block, under the pointer on an earlier one; a subagent's text has none (decisions 40, 74)", async () => {
  await send([snapshot(), sent("Run the bash command `echo hello-from-bash` and then reply with just: done"), ...events(outLines("basic"))]);
  // One row per finished turn: Copy (the whole reply) and Keep (this block).
  const rows = await exec("return [...document.querySelectorAll('.timeline .reply .reply-acts')].map((r) => [...r.querySelectorAll('button')].map((b) => b.textContent))");
  assert.deepEqual(rows, [["Copy", "Keep"], ["Copy", "Keep"]]);
  assert.equal(await exec("return document.querySelectorAll('.timeline .keep:not(.in-row)').length"), 0, "no second set of actions");
  await clearPosts();
  await click(".reply-acts .keep button", "Keep");
  await settle();
  assert.deepEqual(await exec("return [...document.querySelectorAll('.reply-acts')[0].querySelectorAll('button')].map((b) => b.textContent)"), ["Copy", "finding", "decision", "×"], "the choice in the same row");
  await shot("keep-choose");
  await click(".reply-acts .keep.open button", "finding");
  await settle();
  const ps = (await posts()).filter((p) => p.t === "keep");
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, "finding");
  assert.ok(!("text" in ps[0]), "the page names the block; the host has its text");
  const id = ps[0].entryId;
  assert.deepEqual(await text(".kept-line"), ["Keeping…"]);
  await send([{ t: "kept", entryId: id, kind: "finding", held: false }]);
  assert.equal((await text(".reply-acts"))[0], "Copy✓ Kept on the work item as a finding");
  await shot("keep-done");
  // The second turn's: a desk that is down, then held for a chat with no item.
  await exec("document.querySelectorAll('.reply-acts')[1].querySelector('.keep button').click()");
  await settle();
  await clearPosts();
  await exec("[...document.querySelectorAll('.reply-acts')[1].querySelectorAll('.keep.open button')].find((b) => b.textContent === 'decision').click()");
  await settle();
  const id2 = (await posts()).find((p) => p.t === "keep").entryId;
  await send([{ t: "kept", entryId: id2, kind: "decision", error: "the desk is not running" }]);
  assert.deepEqual(await text(".kept-line.err"), ["Not kept: the desk is not running"]);
  assert.deepEqual(await exec("return [...document.querySelectorAll('.reply-acts')[1].querySelectorAll('button')].map((b) => b.textContent)"), ["Copy", "Keep"], "and Keep again");
  await send([{ t: "kept", entryId: id2, kind: "decision", held: true }]);
  assert.deepEqual(await text(".kept-line"), ["✓ Kept on the work item as a finding", "Kept as a decision — it lands on the work item once this chat has one"]);
  // A block of a turn still running has no Copy yet: Keep shows over it under the pointer.
  await send([snapshot(), sent("flash it"), { t: "event", e: { type: "assistant", message: { id: "m-running", content: [{ type: "text", text: "Flashing the board now." }] } } }]);
  assert.equal(await exec("return document.querySelectorAll('.reply-acts').length"), 0);
  const keepShown = () => exec("return getComputedStyle(document.querySelector('.reply .keep')).opacity");
  assert.equal(await keepShown(), "0", "only under the pointer");
  const pointAt = async (sel) => {
    const el = await wd("POST", `${S}/element`, { using: "css selector", value: sel });
    await wd("POST", `${S}/actions`, { actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", origin: el, x: 0, y: 0 }] }] });
    await settle();
  };
  await pointAt(".timeline .reply");
  assert.equal(await keepShown(), "1");
  await shot("keep-hover");
  await wd("POST", `${S}/actions`, { actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", origin: "viewport", x: 5, y: 5 }] }] });
  await wd("DELETE", `${S}/actions`);
  await settle();
  // And to the keyboard: it takes focus, and shows while it has it.
  assert.equal(await exec("const b = document.querySelector('.reply .keep button'); b.focus(); return document.activeElement === b"), true);
  assert.equal(await keepShown(), "1");
  // A block that opens with a code block: Keep and the code block's Copy each keep their own place.
  await send([snapshot(), sent("flash it"), { t: "event", e: { type: "assistant", message: { id: "m-code", content: [{ type: "text", text: "```\nwest flash --runner nrfutil\n```\nThat is the command." }] } } }]);
  await pointAt(".timeline .reply .codeblock");
  assert.equal(await exec("const c = document.querySelector('.reply .codeblock .copy').getBoundingClientRect(); return document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)?.className"), "copy");
  await wd("DELETE", `${S}/actions`);
  // A subagent's own text is a step of its call, not a reply.
  await send([snapshot(), sent("s"), ...events(outLines("subagent"))]);
  await exec("document.querySelectorAll('.tool .line').forEach((l) => l.click())");
  await settle();
  assert.equal(await exec("return document.querySelectorAll('.tool .reply').length"), 0);
});

await check("a message refused with its chat keeps its text on screen, with Copy", async () => {
  const st = core.reduceAll(core.initialState(SID), [{ type: "_note", text: "Something else runs this chat now — it stays read-only here; Jump goes to it. Your message was not sent:", tone: "error", kept: "take it over\nand finish the blink test" }]);
  await send([{ ...snapshot({ ...st, process: "none" }, { ...OURS, ours: false, readOnly: true }) }]);
  assert.equal((await text(".note.error .kept pre"))[0], "take it over\nand finish the blink test");
  assert.deepEqual(await text(".note.error .kept button"), ["Copy"]);
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
  // The span whole: the host reads its line (decision 93).
  assert.deepEqual([p.path, p.line], ["src/main.c:42", undefined]);
  await shot("chat-markdown");
});

const toolCall = (id, name, input) => ({ t: "event", e: { type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null } });
const toolResult = (id, text, isError = false) => ({ t: "event", e: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] }, parent_tool_use_id: null } });

await check("the column: a wide pane centres timeline, cards and composer in 80 % of it, prose wraps narrower than steps and code, steps and thinking indent; the header and the composer's rule stay full width (decision 91)", async () => {
  const say = (id, content) => ({ t: "event", e: { type: "assistant", message: { id, content }, parent_tool_use_id: null } });
  const echo = (text) => ({ t: "event", e: { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null } });
  const ask = "Why does the build fail on the new board?";
  const prose =
    "The overlay names `led0`, but the new board's devicetree has no such alias, so the build stops at the first use of it. " +
    "Moving the alias into the board's own overlay keeps the application free of board names, and the old board keeps building as it did.";
  const code = "```\nwest build -b nrf54l15dk/nrf54l15/cpuapp app -- -DEXTRA_DTC_OVERLAY_FILE=boards/nrf54l15dk_nrf54l15_cpuapp.overlay\n```";
  await send([
    snapshot(),
    sent(ask),
    echo(ask),
    say("m-l1", [{ type: "thinking", thinking: "The overlay names a node the board file does not have." }]),
    say("m-l2", [{ type: "text", text: `${prose}\n\n${code}` }]),
    toolCall("toolu_l1", "Bash", { command: "west build -b nrf54l15dk/nrf54l15/cpuapp app", description: "Build for the new board" }),
    toolResult("toolu_l1", "error: 'led0' undeclared"),
    say("m-l3", [{ type: "text", text: "It builds once the alias is in the board's overlay." }]),
    { t: "event", e: { type: "result", subtype: "success", is_error: false } },
    { t: "event", e: { type: "_sent", n: 2, text: "Thanks" } },
    echo("Thanks"),
  ]);
  const measure = () =>
    exec(`const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { vw: document.documentElement.clientWidth, rem, rail: r('.rail')?.right ?? 0,
        head: r('.header .row').left, composer: r('.composer').width, field: r('.composer .field').left, fieldRight: r('.composer .field').right,
        p: r('.timeline .reply .md > p'), code: r('.timeline .reply .md > .codeblock'), tool: r('.timeline > div > .tool').left,
        think: r('.timeline > div > details.thinking').left, user: r('.timeline .user').right, turn: r('.timeline > .turn').width };`);
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1, `${what}: ${a} vs ${b}`);
  // Firefox goes no narrower than 500 px; both are measured before either is judged.
  const seen = [];
  try {
    for (const [w, name] of [
      [500, "layout-narrow"],
      [1400, "layout-wide"],
    ]) {
      await wd("POST", `${S}/window/rect`, { width: w, height: 900 });
      await settle();
      await shot(name);
      seen.push([name, await measure()]);
    }
  } finally {
    await wd("POST", `${S}/window/rect`, { width: 460, height: 900 });
  }
  for (const [name, m] of seen) {
    // The column is the region right of the rail (decision 94): the pane less the rail.
    const mw = m.vw - m.rail;
    const gutter = Math.min(16, Math.max(8, 0.025 * m.vw));
    const col = Math.max(56 * m.rem, 0.8 * mw);
    const left = m.rail + Math.max(gutter, (mw - col) / 2);
    near(m.p.left, left, `${name}: prose starts at the column's edge`);
    near(m.field, left, `${name}: the composer's field shares it`);
    near(m.think, left + gutter, `${name}: thinking indents by the gutter`);
    near(m.tool, left + gutter, `${name}: a step indents by the gutter`);
    near(m.head, gutter, `${name}: the header keeps the gutter, full width`);
    near(m.composer, mw, `${name}: the composer's rule runs the pane's width, from the rail`);
    assert.ok(m.rail > 20 && m.rail < 40, `${name}: the rail, folded: ${m.rail}`);
    if (mw > col + 2 * gutter) {
      assert.ok(m.p.width <= 64 * m.rem + 1 && m.p.width > 56 * m.rem, `${name}: prose wraps at 64rem: ${m.p.width}`);
      near(m.code.width, col, `${name}: code takes the whole column`);
      near(m.turn, col, `${name}: the turn's rule stops at the column`);
      const right = m.vw - (left - m.rail);
      near(m.fieldRight, right, `${name}: the composer's field ends at the column's edge`);
      assert.ok(m.user <= right + 1 && m.user >= right - 20, `${name}: the bubble ends at the column's edge: ${m.user}`);
    }
  }
});

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
  assert.equal(cards[2].mark, "FAIL", "a log that holds an assert is a failed run");
  assert.match(cards[2].err, /ASSERTION FAIL/, "its line still shown");
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

// A real (trusted) click, as the owner's: VS Code's own handler acts only on those.
const realClick = async (el) => {
  await wd("POST", `${S}/element/${Object.values(el)[0]}/click`, {});
  await settle();
};

await check("a step that touches a connector shows its glyph and the thing by name, a link that opens once through the extension (decision 87)", async () => {
  const DESK = "mcp__plugin_embarch-desk_embarch-desk__";
  const issue = { key: "ABC-154", title: "Make the widget blink", url: "https://linear.app/acme/issue/ABC-154/make-the-widget-blink", state: "In Progress" };
  await send([
    snapshot(),
    toolCall("toolu_s1", `${DESK}linear_get_issue`, { key: "ABC-154" }),
    toolResult("toolu_s1", JSON.stringify(issue, null, 2)),
  ]);
  const row = await exec(
    `const t = document.querySelector('.tool'); const s = t.querySelector('.subject'); const g = s && s.querySelector('svg.glyph');
     return { glyph: g && g.getAttribute('class'), label: g && g.getAttribute('aria-label'), fill: g && g.querySelector('path').getAttribute('fill'),
       glyphColor: g && getComputedStyle(g).color, lineColor: getComputedStyle(t.querySelector('.line')).color,
       link: s.querySelector('.subject-link')?.textContent, tag: t.querySelector('.name.tag')?.textContent, hover: s.getAttribute('title'),
       w: g && g.getBoundingClientRect().width, fontSize: parseFloat(getComputedStyle(s).fontSize) }`,
  );
  assert.equal(row.glyph, "glyph g-linear");
  assert.equal(row.label, "Linear");
  assert.equal(row.fill, "currentColor");
  assert.equal(row.glyphColor, row.lineColor, "the glyph is drawn in the line's own colour, as a codicon is");
  assert.ok(Math.abs(row.w - row.fontSize) < 1, `sized to the text: ${row.w} vs ${row.fontSize}`);
  assert.equal(row.link, "ABC-154Make the widget blink↗");
  assert.equal(row.tag, "linear_get_issue", "the tool name stays the muted tag");
  assert.ok(row.hover.includes('{"key":"ABC-154"}'), `the raw input a hover away: ${row.hover}`);
  const el = (await wd("POST", `${S}/elements`, { using: "css selector", value: ".tool .subject-link" }))[0];
  await exec("window.__posts = []; window.__vscode = [];");
  await realClick(el);
  assert.deepEqual(await exec("return window.__vscode"), [], "VS Code's own handler opened nothing");
  assert.deepEqual((await posts()).filter((p) => p.t === "openLink"), [{ t: "openLink", url: issue.url }], "opened once, in Linear");
  assert.equal((await text(".tool .body")).length, 0, "the click opened the issue, not the row");
  await shot("chat-subject");

  // A URL from a tool's output on another host is shown, not linked.
  await send([snapshot(), toolCall("toolu_s2", `${DESK}linear_get_issue`, { key: "ABC-155" }), toolResult("toolu_s2", JSON.stringify({ ...issue, key: "ABC-155", url: "https://linear.app.evil.example/x" }))]);
  assert.equal((await text(".tool .subject-link")).length, 0);
  assert.deepEqual(await text(".tool .subject-text"), ["ABC-155Make the widget blink"]);

  // A folded run names what its other steps touched, each once, its head its own.
  const view = "title:\tBlink\nstate:\tOPEN\nnumber:\t36\nurl:\thttps://github.com/owner/repo/pull/36\n--\nbody\n";
  await send([
    snapshot(),
    toolCall("toolu_r1", `${DESK}linear_get_issue`, { key: "ABC-154" }),
    toolResult("toolu_r1", JSON.stringify(issue)),
    toolCall("toolu_r2", "Bash", { command: "gh pr view 36", description: "Read the PR" }),
    toolResult("toolu_r2", view),
    toolCall("toolu_r3", `${DESK}linear_get_issue`, { key: "ABC-154" }),
    toolResult("toolu_r3", JSON.stringify(issue)),
    toolCall("toolu_r4", "mcp__claude_ai_Slack__slack_read_channel", { channel_id: "C0123ABCD" }),
    toolResult("toolu_r4", JSON.stringify({ messages: "Channel: general (C0123ABCD)\n\nhi", pagination_info: "" })),
  ]);
  const run = await exec(
    `const r = document.querySelector('.tool.run > .line');
     return { head: r.querySelector(':scope > .subject')?.textContent, glyphs: [...r.querySelectorAll('.run-subjects svg.glyph')].map(g => g.getAttribute('aria-label')),
       names: [...r.querySelectorAll('.run-subjects .subject')].map(s => s.textContent), count: r.querySelector('.count').textContent,
       colors: [...r.querySelectorAll('.subject-link')].map(a => getComputedStyle(a).color) }`,
  );
  assert.equal(run.colors.length, 3, "the head's and both listed things are links");
  assert.equal(new Set(run.colors).size, 1, `all in the link colour: ${run.colors}`);
  assert.equal(run.head, "#general↗");
  assert.deepEqual(run.glyphs, ["Linear", "GitHub"]);
  assert.deepEqual(run.names, ["ABC-154", "#36"]);
  assert.equal(run.count, "4 steps");
  const pr = (await wd("POST", `${S}/elements`, { using: "css selector", value: ".tool.run .run-subjects .subject-link" }))[1];
  await exec("window.__posts = []; window.__vscode = [];");
  await realClick(pr);
  assert.deepEqual(await exec("return window.__vscode"), []);
  assert.deepEqual((await posts()).filter((p) => p.t === "openLink"), [{ t: "openLink", url: "https://github.com/owner/repo/pull/36" }]);
  assert.equal((await text(".tool.run > .steps")).length, 0, "the run stays folded");
  await shot("chat-subject-run");
});

await check("a step on one file names it as a link: a click opens it at the step's lines, once, and the row stays shut (decision 93)", async () => {
  const edited = {
    t: "event",
    e: {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_f2", content: "ok" }] },
      tool_use_result: { structuredPatch: [{ oldStart: 11, newStart: 12, lines: ["-a", "+b"] }] },
      parent_tool_use_id: null,
    },
  };
  await send([
    snapshot(),
    toolCall("toolu_f1", "Read", { file_path: "/work/rec/x/src/main.c", offset: 40, limit: 20 }),
    toolResult("toolu_f1", "int x;"),
    { t: "event", e: { type: "assistant", message: { id: "m-f", content: [{ type: "text", text: "Now the fix." }] }, parent_tool_use_id: null } },
    toolCall("toolu_f2", "Edit", { file_path: "/work/rec/x/src/hal.c", old_string: "a", new_string: "b" }),
    edited,
    toolCall("toolu_f3", "Bash", { command: "make" }),
  ]);
  assert.deepEqual(await text(".tool .file-link"), ["src/main.c", "src/hal.c"], "the two file steps link, Bash does not");
  const want = [
    { t: "openFile", path: "/work/rec/x/src/main.c", line: 40 },
    { t: "openFile", path: "/work/rec/x/src/hal.c", line: 12 },
  ];
  // An edit shows its diff open already (decision 8): what counts is that no click changes which rows are open.
  const bodies = await text(".tool .body");
  const links = await wd("POST", `${S}/elements`, { using: "css selector", value: ".tool .file-link" });
  for (const [i, el] of links.entries()) {
    await exec("window.__posts = []; window.__vscode = [];");
    await realClick(el);
    assert.deepEqual(await exec("return window.__vscode"), [], "VS Code's own handler opened nothing");
    assert.deepEqual((await posts()).filter((p) => p.t === "openFile"), [want[i]], "opened once, at its lines");
  }
  assert.deepEqual(await text(".tool .body"), bodies, "the clicks opened the files, not the rows");
});

await check("a key or PR in Claude's prose is a link once the desk's index knows it, and a step row drawn before the index arrived takes its title and link (decision 88)", async () => {
  const DESK = "mcp__plugin_embarch-desk_embarch-desk__";
  const say = {
    t: "event",
    e: {
      type: "assistant",
      message: { id: "m-refs", content: [{ type: "text", text: "Done in ABC-154, merged as owner/repo#36; #36 alone is two PRs, ABC-999 none, `ABC-154` code and **ABC-154** bold. Then PR #38, after step #3." }] },
      parent_tool_use_id: null,
    },
  };
  const merge = [toolCall("toolu_x2", "Bash", { command: "gh pr merge 38 --squash", description: "Merge it" }), toolResult("toolu_x2", "")];
  await send([{ t: "refs", refs: null }, snapshot(), toolCall("toolu_x1", `${DESK}linear_set_status`, { key: "ABC-154", state: "Done" }), toolResult("toolu_x1", JSON.stringify({ key: "ABC-154", state: "Done" })), ...merge, say]);
  assert.equal((await text(".md a.ref")).length, 0, "no index, no links");
  assert.deepEqual(await text(".tool .subject-text"), ["#38", "ABC-154"], "the run's head and the step before it name the number and the key alone");
  // The index arrives: the rows already drawn are drawn again.
  await send([{ t: "refs", refs: { issues: INDEX.issues, prs: INDEX.prs } }]);
  assert.deepEqual(await text(".md a.ref"), ["ABC-154", "owner/repo#36", "ABC-154"], "known keys and owner/repo#N, bold too; a bare #36, and PR #38 with no repo known, stay text");
  const md = (await text(".reply .md"))[0];
  assert.ok(md.includes("ABC-999 none") && md.includes("#36 alone") && md.includes("step #3"), md);
  assert.deepEqual(await text(".md code"), ["ABC-154"], "a code span stays code");
  assert.deepEqual(await text(".tool .subject-link"), ["ABC-154"], "the status step, listed in the run, took the index's link");
  assert.deepEqual(await text(".tool .subject-text"), ["#38"], "gh pr merge 38 with no repo known: the index's only #38 is not taken for it (87)");
  // The chat's folder is a clone of owner/repo: "PR #38" in prose is that repo's; "step #3" is still text (88). The
  // merge names no repo, and where its shell was is not known: still #38 alone (87).
  await send([snapshot({}, { ...OURS, githubRepo: "owner/repo" }), toolCall("toolu_x1", `${DESK}linear_set_status`, { key: "ABC-154", state: "Done" }), toolResult("toolu_x1", JSON.stringify({ key: "ABC-154", state: "Done" })), ...merge, say]);
  assert.deepEqual(await text(".md a.ref"), ["ABC-154", "owner/repo#36", "ABC-154", "PR #38"]);
  assert.deepEqual(await text(".tool .subject-link"), ["ABC-154"]);
  assert.deepEqual(await text(".tool .subject-text"), ["#38"]);
  await send([snapshot(), toolCall("toolu_x1", `${DESK}linear_set_status`, { key: "ABC-154", state: "Done" }), toolResult("toolu_x1", JSON.stringify({ key: "ABC-154", state: "Done" })), say]);
  assert.deepEqual(await text(".tool .subject-link"), ["ABC-154Create the Widget↗"], "a step of its own shows the index's title too");
  const hover = await exec("return document.querySelector('.md a.ref').getAttribute('title')");
  assert.match(hover, /^ABC-154 Create the Widget · Done\nOpens in Linear: https:\/\/linear\.app\//);
  // A real click opens it once, through the extension: the issue in Linear, the PR in GitHub.
  const refs = await wd("POST", `${S}/elements`, { using: "css selector", value: ".md a.ref" });
  await exec("window.__posts = []; window.__vscode = [];");
  await realClick(refs[0]);
  await realClick(refs[1]);
  assert.deepEqual(await exec("return window.__vscode"), [], "VS Code's own handler opened nothing");
  assert.deepEqual(
    (await posts()).filter((p) => p.t === "openLink"),
    [
      { t: "openLink", url: INDEX.issues.find((i) => i.key === "ABC-154").url },
      { t: "openLink", url: "https://github.com/owner/repo/pull/36" },
    ],
  );
  await shot("chat-refs");
  // Emptied again: the links go.
  await send([{ t: "refs", refs: null }]);
  assert.equal((await text(".md a.ref")).length, 0);
});

await check("a gh naming no repo is #N shown, not linked, whatever the chat's folder's repo and whatever steps came before it (87)", async () => {
  // Claude Code's Bash keeps its cwd between steps and the chat's folder moves with each turn: the merge may have run in
  // another clone, whatever the folder's remote says, and a link to the wrong PR is worse than none.
  const merge = [toolCall("toolu_cd2", "Bash", { command: "gh pr merge 36 --squash", description: "Merge it" }), toolResult("toolu_cd2", "")];
  const before = (command) => [toolCall("toolu_cd1", "Bash", { command, description: "Before" }), toolResult("toolu_cd1", "")];
  await send([{ t: "refs", refs: { issues: INDEX.issues, prs: INDEX.prs } }]);
  for (const steps of [merge, [...before("cd ../other-clone && git pull"), ...merge], [...before("(cd ../other-clone && git pull)"), ...merge], [...before("cd /work/rec/x && npm test"), ...merge]]) {
    await send([snapshot({}, { ...OURS, githubRepo: "owner/repo" }), ...steps]);
    assert.deepEqual(await text(".tool .subject-link"), [], steps[0].e?.message?.content?.[0]?.input?.command);
    assert.deepEqual(await text(".tool .subject-text"), ["#36"]);
  }
  // Live as it arrives, too; and one that names its repo is that repo's #36, its title from the index.
  await send([snapshot({}, { ...OURS, githubRepo: "owner/repo" })]);
  await send(merge);
  assert.deepEqual(await text(".tool .subject-text"), ["#36"]);
  await send([toolCall("toolu_cd3", "Bash", { command: "gh pr merge 36 --squash -R owner/repo", description: "Merge it" }), toolResult("toolu_cd3", "")]);
  assert.deepEqual(await text(".tool .subject-link"), ["#36Widget↗"]);
  await send([{ t: "refs", refs: null }]);
});

await check("no link has an href: VS Code's own handler never opens one, each opens once, and vscode:, mailto: and command: links are refused", async () => {
  const say = {
    t: "event",
    e: {
      type: "assistant",
      message: {
        id: "m-links",
        content: [
          {
            type: "text",
            text: [
              "See [the docs](https://example.com/docs) and https://example.com/bare.",
              "Then [the PR](vscode://anthropic.claude-code/open?prompt=hello), [mail](mailto:someone@example.com), [run](command:workbench.action.terminal.new) and [a plugin](vscode://anthropic.claude-code/install-plugin?plugin=x).",
              "The fix is in [main.c](src/main.c), per abc123@A p12.",
              "Also [the spec](file:///work/rec/x/spec.md#L3) and `~/notes/todo.md:7-9`.",
            ].join("\n"),
          },
        ],
      },
      parent_tool_use_id: null,
    },
  };
  await send([
    snapshot({}, { ...OURS, atlas: { docs: ["abc123@A"], boards: [] } }),
    say,
    toolCall("toolu_l1", "mcp__embarch-api__run_study", { study: {} }),
    toolResult("toolu_l1", JSON.stringify({ study_id: "st-7" })),
  ]);
  assert.equal(await exec("return document.body.querySelectorAll('[href]').length"), 0, "nothing on the page carries an href");
  const want = [
    // [selector, text, what one click posts (null: nothing)]
    [".md a", "the docs", { t: "openLink", url: "https://example.com/docs" }],
    [".md a", "https://example.com/bare", { t: "openLink", url: "https://example.com/bare" }],
    [".md .link-refused", "the PR", null],
    [".md .link-refused", "mail", null],
    [".md .link-refused", "run", null],
    [".md .link-refused", "a plugin", null],
    [".md a", "main.c", { t: "openFile", path: "src/main.c" }],
    // A file:/// link is a path; a span from `~` with a line range is a file (decision 93).
    [".md a", "the spec", { t: "openFile", path: "/work/rec/x/spec.md#L3" }],
    [".md code.file", "~/notes/todo.md:7-9", { t: "openFile", path: "~/notes/todo.md:7-9" }],
    ["a.cite", "abc123@A p12", { t: "atlas", doc: "abc123@A", page: 12 }],
    [".bench-link", "Live Study", { t: "openLink", url: "http://127.0.0.1:4890/#live-study?study=st-7" }],
    [".header a", "ABC-123", { t: "openLink", url: "https://linear.example/ABC-123" }],
    [".header a", "#42", { t: "openLink", url: "https://github.example/o/r/pull/42" }],
    [".header a", "Desk", { t: "openLink", url: "http://127.0.0.1:4890/#desk?item=w1" }],
  ];
  const opens = (ps) => ps.filter((p) => ["openLink", "openFile", "atlas"].includes(p.t));
  for (const [sel, label, post] of want) {
    const els = await wd("POST", `${S}/elements`, { using: "css selector", value: sel });
    let el = null;
    for (const e of els) if ((await wd("GET", `${S}/element/${Object.values(e)[0]}/text`)).includes(label)) el = e;
    assert.ok(el, `no ${sel} "${label}"`);
    await exec("window.__posts = []; window.__vscode = [];");
    await realClick(el);
    assert.deepEqual(await exec("return window.__vscode"), [], `VS Code's own handler opened nothing for "${label}"`);
    assert.deepEqual(opens(await posts()), post ? [post] : [], `"${label}": ${post ? "opened once" : "refused"}`);
  }
  // And no source draws one another way: every <a> is shared/link.tsx's.
  const sources = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  for (const f of sources(path.join(root, "webview"))) {
    if (f.endsWith(path.join("shared", "link.tsx"))) continue;
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/<a[\s>]|\bhref\s*=/.test(src), `${path.relative(root, f)} draws its own <a> or href`);
  }
  // The keyboard opens a link too, once.
  await exec("window.__posts = [];");
  const docs = (await wd("POST", `${S}/elements`, { using: "css selector", value: ".md a" }))[0];
  await wd("POST", `${S}/element/${Object.values(docs)[0]}/value`, { text: "\uE007" });
  await settle();
  assert.deepEqual(opens(await posts()), [{ t: "openLink", url: "https://example.com/docs" }]);
});

await check("a link's text holds no other link: a URL, a file or a citation in it is text, and one click opens one thing", async () => {
  const say = {
    t: "event",
    e: {
      type: "assistant",
      message: {
        id: "m-nested",
        content: [
          {
            type: "text",
            text: [
              "One [https://docs.example/a](https://other.example/b) here.",
              "Two [`src/main.c`](https://example.com/c) there.",
              "Three [see abc123@A p12](https://example.com/d) too.",
              "Four [**https://docs.example/e**](https://example.com/f), and [https://docs.example/g](vscode://x/y) refused.",
            ].join("\n"),
          },
        ],
      },
      parent_tool_use_id: null,
    },
  };
  await send([snapshot({}, { ...OURS, atlas: { docs: ["abc123@A"], boards: [] } }), say]);
  const inner = ".md a a, .md a code.file, .md a .cite, .md .link-refused a, .md .link-refused code.file, .md .link-refused .cite";
  assert.equal(await exec("return document.querySelectorAll(arguments[0]).length", [inner]), 0, "nothing inside a link opens on its own");
  const want = [
    ["https://docs.example/a", { t: "openLink", url: "https://other.example/b" }],
    ["src/main.c", { t: "openLink", url: "https://example.com/c" }],
    ["see abc123@A p12", { t: "openLink", url: "https://example.com/d" }],
    ["https://docs.example/e", { t: "openLink", url: "https://example.com/f" }],
  ];
  const opens = (ps) => ps.filter((p) => ["openLink", "openFile", "atlas"].includes(p.t));
  const find = async (sel, label) => {
    let el = null;
    for (const e of await wd("POST", `${S}/elements`, { using: "css selector", value: sel })) if ((await wd("GET", `${S}/element/${Object.values(e)[0]}/text`)) === label) el = e;
    assert.ok(el, `no ${sel} "${label}"`);
    return el;
  };
  for (const [label, post] of want) {
    const el = await find(".md a", label);
    await exec("window.__posts = []; window.__vscode = [];");
    await realClick(el);
    assert.deepEqual(await exec("return window.__vscode"), [], `VS Code's own handler opened nothing for "${label}"`);
    assert.deepEqual(opens(await posts()), [post], `"${label}" opened once, its own target`);
    await exec("window.__posts = [];");
    await wd("POST", `${S}/element/${Object.values(el)[0]}/value`, { text: "" });
    await settle();
    assert.deepEqual(opens(await posts()), [post], `"${label}": Enter opens it once too`);
  }
  await exec("window.__posts = []; window.__vscode = [];");
  await realClick(await find(".md .link-refused", "https://docs.example/g"));
  assert.deepEqual(opens(await posts()), [], "a refused link's URL text opens nothing either");
  assert.deepEqual(await exec("return window.__vscode"), []);
});

// ------------------------------------------------------------ the assistant and the library

const haikuLines = (name) =>
  fs
    .readFileSync(path.join(here, "fixtures", "haiku", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.d === "out")
    .map((e) => e.o);
const haikuAnswer = (name) => core.parseObject(haikuLines(name).find((o) => o.type === "result").result);
/** The ghost messages the host posts while the recorded call streams (assistant.ts). */
const ghostStream = (name, seq, draft) => {
  let text = "";
  const out = [];
  for (const o of haikuLines(name)) {
    if (o.type !== "stream_event" || o.event?.delta?.type !== "text_delta") continue;
    text += o.event.delta.text;
    const p = core.partialCompletion(text);
    if (p === null) continue;
    const c = core.cleanCompletion(draft, p);
    if (c && c !== out.at(-1)?.text) out.push({ t: "ghost", seq, text: c, done: false });
  }
  out.push({ t: "ghost", seq, text: core.cleanCompletion(draft, haikuAnswer(name).completion), done: true });
  return out;
};
const LIBRARY = [...core.readLibrary(path.join(root, "plugin"), path.join(here, "fixtures", "none")), { name: "notes", category: "Other", source: "user", kind: "command", description: "A command of the owner's own" }];
let sidN = 0;
/** A fresh composer: its own session id, the assistant on or off. */
const fresh = async (over = {}, assistant = true) => {
  const sid = `22222222-0000-4000-8000-${String(++sidN).padStart(12, "0")}`;
  await send([{ t: "library", entries: LIBRARY, assistant }, snapshot({ sessionId: sid, ...over })]);
  await clearPosts();
  return sid;
};
const textarea = async () => Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: ".composer textarea" }))[0];
const type = async (keys) => {
  await wd("POST", `${S}/element/${await textarea()}/value`, { text: keys });
  await settle();
};
const value = () => exec("return document.querySelector('.composer textarea').value");
const ghostText = () => exec("const g=document.querySelector('.overlay .ghost'); return g ? g.textContent : null");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hover = async (sel, txt) => {
  const id = await exec(
    `const e=[...document.querySelectorAll(arguments[0])].find(x => !arguments[1] || x.textContent.includes(arguments[1])); if(!e) throw new Error('no '+arguments[0]); e.setAttribute('data-h','1'); return true;`,
    [sel, txt ?? null],
  );
  const el = Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: "[data-h='1']" }))[0];
  await exec("document.querySelector(\"[data-h='1']\").removeAttribute('data-h')");
  await wd("POST", `${S}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: { "element-6066-11e4-a52e-4f735466cecf": el }, x: 0, y: 0 }] }] });
  await settle();
  return id;
};
const mouseAway = async () => {
  await wd("POST", `${S}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: "viewport", x: 5, y: 5 }] }] });
  await settle();
};
const pick = (sel, txt) =>
  exec(
    `const e=[...document.querySelectorAll(arguments[0])].find(x => x.textContent.includes(arguments[1])); if(!e) throw new Error('no '+arguments[1]); e.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true})); return true;`,
    [sel, txt],
  );
const CTRL_Z = "z";
const TAB = "";
const ENTER = "";
const lastAssist = async (kind) => (await posts()).filter((p) => p.t === "assist" && p.kind === kind).at(-1);
/** The page's latest ask of a kind, once it has made one (timers in a loaded headless browser run late). */
const waitAssist = async (kind, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    const a = await lastAssist(kind);
    if (a) return a;
    if (Date.now() - t0 > ms) throw new Error(`no ${kind} request in ${ms} ms`);
    await sleep(50);
  }
};

await check("the instant wave: the owner's own past prompts complete the draft; typing through, Tab takes it", async () => {
  await fresh({}, false);
  await send([{ t: "prompts", items: [{ text: "continue with the next step", n: 4, lastMs: 1 }, { text: "commit it", n: 9, lastMs: 2 }] }]);
  await type("con");
  assert.equal(await ghostText(), "tinue with the next step");
  await type("t");
  assert.equal(await ghostText(), "inue with the next step", "typed through");
  await shot("assist-ghost-local");
  await type(TAB);
  assert.equal(await value(), "continue with the next step");
  assert.equal(await ghostText(), null);
  await type(CTRL_Z);
  assert.equal(await value(), "cont", "Ctrl+Z gives back what was typed");
  await type("x");
  assert.equal(await ghostText(), null, "no prompt starts so");
  assert.ok(!(await posts()).some((p) => p.t === "assist"), "the assistant is off: no Haiku call");
});

await check("Haiku's ghost text after a 300 ms pause, streamed; Tab takes it; the next keystroke cancels a stale call", async () => {
  await fresh();
  await type("now flash it on the");
  await sleep(150);
  assert.equal(await lastAssist("ghost"), undefined, "not before the pause");
  const ask = await waitAssist("ghost");
  assert.equal(ask.text, "now flash it on the");
  const stream = ghostStream("ghost", ask.seq, ask.text);
  await send([stream[0]]);
  assert.equal(await ghostText(), stream[0].text, "the first words show while it streams");
  await send(stream.slice(1));
  const final = stream.at(-1).text;
  assert.equal(await ghostText(), final);
  await send([{ t: "ghost", seq: ask.seq - 1, text: " something stale", done: true }]);
  assert.equal(await ghostText(), final, "an answer to an older request is ignored");
  await shot("assist-ghost-haiku");
  await type(TAB);
  assert.equal(await value(), "now flash it on the" + final);
  // A call in flight, and a keystroke.
  await clearPosts();
  await type(" and");
  await waitAssist("ghost");
  await type(" x");
  assert.ok((await posts()).some((p) => p.t === "assistCancel"), "cancelled by the next keystroke");
});

await check("the 💡 lights with Haiku's cards; hovering a card previews its edit in the draft; a click applies it; Ctrl+Z restores", async () => {
  await fresh();
  await type("fix the flash thing");
  await sleep(1500);
  assert.equal(await lastAssist("cards"), undefined, "no cards before the 2 s pause");
  const ask = await waitAssist("cards");
  assert.equal(ask.text, "fix the flash thing", "cards after a 2 s pause");
  // A reference card and a context card (decision 88's and 36's): decision 28's kinds are Promptu's now (97).
  const cards = [
    { id: "w-0", category: "refs", title: "Name PR owner/repo#36", why: "The desk knows the flash PR", edit: { op: "replace", find: "the flash thing", with: 'PR owner/repo#36 "Flash driver" (ABC-154)' } },
    { id: "w-1", category: "context", kind: "background", title: "Run it in the background", why: "A long job", edit: { op: "append", text: "\n\n" + core.BACKGROUND_INSTRUCTION } },
  ];
  await send([{ t: "cards", seq: ask.seq, cards }]);
  assert.equal(await exec("return document.querySelector('.bulb').classList.contains('lit')"), true);
  assert.equal((await text(".bulb .count"))[0], String(cards.length));
  await click(".bulb");
  await settle();
  const cats = await text(".menu.bulb .menu-cat .menu-label");
  assert.deepEqual(cats, core.CATEGORIES.filter((c) => cards.some((x) => x.category === c.id)).map((c) => c.label));
  const first = cards.find((c) => c.category === core.CATEGORIES.find((x) => x.label === cats[0]).id);
  await hover(".menu.bulb .menu-item", first.title);
  const after = core.applyEdit("fix the flash thing", first.edit);
  const pv = await exec(
    "const o=document.querySelector('.overlay'); return {previewing: document.querySelector('.composer textarea').classList.contains('previewing'), add: [...o.querySelectorAll('.add')].map(e=>e.textContent).join(''), del: [...o.querySelectorAll('.del')].map(e=>e.textContent).join(''), shown: [...o.children].filter(e=>!e.classList.contains('del')).map(e=>e.textContent).join('').replace(/\\u200b/g,'')}",
  );
  assert.equal(pv.previewing, true, "the draft shows the preview, not itself");
  assert.ok(pv.add.length > 0, "added words in ghost grey");
  assert.equal(pv.shown, after, "the preview reads as the edited draft");
  assert.equal(await value(), "fix the flash thing", "nothing applied by a hover");
  await shot("assist-card-preview");
  await mouseAway();
  assert.equal(await exec("return document.querySelector('.composer textarea').classList.contains('previewing')"), false);
  // Still open: the pointer leaving only ends the preview. (`.bulb` is also the menu's own class: the rail's button is first now.)
  if (!(await text(".menu.bulb")).length) await click(".rail .bulb");
  await settle();
  await pick(".menu.bulb .menu-item", first.title);
  await settle();
  assert.equal(await value(), after, "applied");
  assert.equal((await text(".menu.bulb")).length, 0, "the menu closes");
  await type(CTRL_Z);
  assert.equal(await value(), "fix the flash thing", "Ctrl+Z restores the draft");
});

/** Cards whose edits grow the draft by lines, two categories: the menu's layout and keys (86). */
const TALL = "\n\nBoard: the dev bench, its first link port.\nPort: the one it enumerates as after a reset.\nLog: the last flash output, whole.";
const growCards = () => [
  { id: "g1", category: "refs", title: "Name the board, port and log", why: "Claude will ask which", edit: { op: "append", text: TALL } },
  { id: "g2", category: "context", title: "Say what done looks like", why: "So it knows when to stop", edit: { op: "append", text: "Done when it boots and logs once." } },
];
/** The 💡 menu open on cards that grow the draft. */
const openGrowing = async () => {
  await fresh();
  const draft = "flash the new build and check it boots";
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft]);
  const ask = await waitAssist("cards");
  await send([{ t: "cards", seq: ask.seq, cards: growCards() }]);
  await click(".bulb");
  await settle();
  return draft;
};
const previewing = () => exec("return document.querySelector('.composer textarea').classList.contains('previewing')");
const rect = (sel) => exec("const r=document.querySelector(arguments[0]).getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round)", [sel]);

await check("hovering a card whose edit adds lines moves nothing under the pointer: the menu stays put and the preview stays on (86)", async () => {
  await openGrowing();
  const before = await rect(".menu.bulb");
  const field = await rect(".composer .field");
  await hover(".menu.bulb .menu-item", "Name the board");
  // The pointer stays still for half a second: every frame the menu is where it was, and the preview never toggles.
  const seen = await wd("POST", `${S}/execute/async`, {
    script: `const done = arguments[0]; const ta = document.querySelector('.composer textarea'); let flips = 0;
      const mo = new MutationObserver(() => flips++); mo.observe(ta, { attributes: true, attributeFilter: ['class'] });
      const rects = new Set(), off = []; const t0 = performance.now();
      const tick = () => { const r = document.querySelector('.menu.bulb')?.getBoundingClientRect();
        rects.add(r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : 'gone');
        if (!ta.classList.contains('previewing')) off.push(Math.round(performance.now() - t0));
        if (performance.now() - t0 < 500) requestAnimationFrame(tick); else { mo.disconnect(); done({ flips, rects: [...rects], off }); } };
      requestAnimationFrame(tick);`,
    args: [],
  });
  assert.deepEqual(seen.off, [], "the preview stays on");
  assert.equal(seen.flips, 0, "no toggling");
  assert.deepEqual(seen.rects, [before.join(",")], "the menu never moves");
  assert.match(await exec("return [...document.querySelectorAll('.overlay .add')].map(e=>e.textContent).join('')"), /Log: the last flash output/);
  assert.deepEqual(await rect(".composer .field"), field, "the field was already as tall as the tallest preview");
  await shot("assist-card-preview-tall");
  // Leaving the menu ends the preview; the field keeps its height while the menu is open.
  await mouseAway();
  assert.equal(await previewing(), false);
  assert.deepEqual(await rect(".menu.bulb"), before);
  // Closed, the field is the draft's own height again.
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
  await settle();
  assert.ok((await rect(".composer .field"))[3] < field[3], "the reserved height goes with the menu");
});

await check("the 💡 by keyboard, as IntelliSense: ↓ focuses and previews a card, → the next category, Enter applies, Ctrl+Z restores (37, 86)", async () => {
  const DOWN = "\uE015", UP = "\uE013", LEFT = "\uE012", RIGHT = "\uE014", ESC = "\uE00C";
  const draft = await openGrowing();
  const on = () => text(".menu.bulb .menu-item.on .menu-item-label");
  assert.deepEqual(await on(), [], "no row is focused when it opens: Enter would still send");
  await type(LEFT);
  assert.equal(await exec("return document.querySelector('.composer textarea').selectionStart"), draft.length - 1, "← moves the caret while no row is focused");
  assert.equal(await previewing(), false);
  await type(DOWN);
  assert.deepEqual(await on(), ["Name the board, port and log"]);
  assert.equal(await previewing(), true, "the focused row previews");
  assert.match(await exec("return [...document.querySelectorAll('.overlay .add')].map(e=>e.textContent).join('')"), /Board: the dev bench/);
  assert.equal(await value(), draft, "nothing applied by a focus");
  await type(RIGHT);
  assert.deepEqual(await text(".menu.bulb .menu-cat.on .menu-label"), ["Context handling"]);
  assert.deepEqual(await on(), ["Say what done looks like"], "→ opens the next category on its first row");
  assert.match(await exec("return [...document.querySelectorAll('.overlay .add')].map(e=>e.textContent).join('')"), /Done when it boots/);
  await type(LEFT);
  await type(UP);
  assert.deepEqual(await on(), ["Name the board, port and log"], "← back, ↑ wraps within the category");
  await clearPosts();
  await type(ENTER);
  assert.equal(await value(), core.applyEdit(draft, growCards()[0].edit), "Enter applies the focused card");
  assert.equal((await text(".menu.bulb")).length, 0, "the menu closes");
  assert.ok(!(await posts()).some((p) => p.t === "send"), "and nothing is sent");
  await type(CTRL_Z);
  assert.equal(await value(), draft, "Ctrl+Z restores the draft");
  // The keys start on the open category's first row, wherever the pointer is: here the one it opened; Esc closes.
  await click(".bulb");
  await settle();
  await hover(".menu.bulb .menu-cat", "Context handling");
  await hover(".menu.bulb .menu-item", "Say what done looks like");
  await type(DOWN);
  assert.deepEqual(await on(), ["Say what done looks like"], "one row in the category: ↓ stays on it");
  await type(ESC);
  assert.equal((await text(".menu.bulb")).length, 0);
  assert.equal(await previewing(), false);
  // The 📚 shares the menu: ↓ and Enter put an entry at the head of the draft.
  await fresh({ slashCommands: [] });
  await type("for this repo");
  await click(".library");
  await settle();
  await type(DOWN);
  const lib = await text(".menu.library .menu-item.on .menu-item-label");
  assert.equal(lib.length, 1, "↓ focuses the first entry");
  await type(ENTER);
  assert.match(await value(), new RegExp(`^/embarch-chat:${lib[0].slice(1)} for this repo$`));
});

const inInput = () => exec("return document.activeElement === document.querySelector('.composer textarea')");

await check("a 💡 the held send opens under a still pointer only previews the row there: the next Enter sends the draft as it is (26, 86)", async () => {
  const ESC = "";
  const draft = await openGrowing();
  // The pointer parked where the menu's first row shows, then the menu closed under it.
  await hover(".menu.bulb .menu-item", "Name the board");
  assert.equal(await previewing(), true, "the pointer's row previews");
  assert.deepEqual(await text(".menu.bulb .menu-item.on"), [], "but the keys focused nothing");
  await type(ESC);
  assert.equal((await text(".menu.bulb")).length, 0);
  // A new word: Enter holds the draft for its cards (26), and their answer opens the 💡 where the pointer still is.
  await type(" now");
  await clearPosts();
  await type(ENTER);
  const ask = await waitAssist("cards");
  assert.equal(ask.text, `${draft} now`);
  assert.ok(!(await posts()).some((p) => p.t === "send"), "held for the cards");
  await send([{ t: "cards", seq: ask.seq, cards: growCards() }]);
  assert.equal((await text(".menu.bulb")).length, 1, "the 💡 opened");
  // The browser entered the row under the still pointer, with no move: a preview, as IntelliSense's hover.
  assert.deepEqual(await text(".menu.bulb .menu-item.hover .menu-item-label"), ["Name the board, port and log"], "entered with no move");
  assert.deepEqual(await text(".menu.bulb .menu-item.on"), []);
  await type(ENTER);
  const sentP = (await posts()).filter((p) => p.t === "send");
  assert.equal(sentP.length, 1, "Enter sent");
  assert.equal(sentP[0].text, `${draft} now`, "the draft as it is, no card applied");
  assert.equal(await value(), "");
  // The 📚's disabled row under the pointer takes no Enter either.
  await fresh({ slashCommands: ["compact", "notes"] });
  await type("check the flash log");
  await click(".library");
  await settle();
  await hover(".menu.library .menu-cat", "Bench");
  await hover(".menu.library .menu-item");
  assert.equal(await exec("return document.querySelector('.menu.library .menu-item.hover').classList.contains('disabled')"), true);
  await clearPosts();
  await type(ENTER);
  assert.equal((await posts()).find((p) => p.t === "send")?.text, "check the flash log", "Enter sent the draft");
});

await check("Tab while a menu shows: it applies the row ↓ focused, takes the ghost text when none is, and never takes the focus out of the input (86)", async () => {
  const DOWN = "";
  const draft = await openGrowing();
  // The pointer's row is a preview: Tab neither applies it nor leaves the input.
  await hover(".menu.bulb .menu-item", "Name the board");
  await type(TAB);
  assert.equal(await value(), draft, "nothing applied");
  assert.equal(await inInput(), true, "the focus stays in the input");
  assert.equal(await previewing(), false, "the preview went back to the draft");
  assert.equal((await text(".menu.bulb")).length, 1, "the menu stays");
  await mouseAway();
  // A row ↓ focused: Tab applies it, as Enter does.
  await type(DOWN);
  await type(TAB);
  assert.equal(await value(), core.applyEdit(draft, growCards()[0].edit), "Tab applied the focused card");
  assert.equal(await inInput(), true);
  await type(CTRL_Z);
  assert.equal(await value(), draft);
  // No row focused and ghost text showing: Tab takes the ghost text, as it did with no preview (24).
  await send([{ t: "prompts", items: [{ text: `${draft} twice over`, n: 3, lastMs: 1 }] }]);
  await type(" ");
  assert.equal(await ghostText(), "twice over");
  await click(".bulb");
  await settle();
  assert.equal((await text(".menu.bulb")).length, 1);
  await type(TAB);
  assert.equal(await value(), `${draft} twice over`, "the ghost text taken");
  assert.equal(await inInput(), true);
});

await check("while ↓ has focused a row, the pointer over another marks it but the preview stays the focused row's — what Enter applies (86)", async () => {
  const DOWN = "";
  await fresh();
  const draft = "flash the new build and check it boots";
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft]);
  const ask = await waitAssist("cards");
  const cards = [
    { id: "k1", category: "refs", title: "Name the board", why: "Claude will ask which", edit: { op: "append", text: "Board: the dev bench." } },
    { id: "k2", category: "refs", title: "Name the log level", why: "So the log says enough", edit: { op: "append", text: "Log level: debug." } },
  ];
  await send([{ t: "cards", seq: ask.seq, cards }]);
  await click(".bulb");
  await settle();
  const added = () => exec("return [...document.querySelectorAll('.overlay .add')].map(e=>e.textContent).join('')");
  // No row focused: the pointer's row previews.
  await hover(".menu.bulb .menu-item", "Name the log level");
  assert.match(await added(), /Log level: debug/);
  // ↓ focuses the first row: it previews, as VS Code's suggest details follow the selection.
  await type(DOWN);
  assert.deepEqual(await text(".menu.bulb .menu-item.on .menu-item-label"), ["Name the board"]);
  assert.match(await added(), /Board: the dev bench/);
  // The pointer moves over the rows: it marks the one it is over, and the preview stays the focused row's.
  await hover(".menu.bulb .menu-item", "Name the board");
  await hover(".menu.bulb .menu-item", "Name the log level");
  assert.deepEqual(await text(".menu.bulb .menu-item.hover .menu-item-label"), ["Name the log level"]);
  assert.match(await added(), /Board: the dev bench/);
  assert.doesNotMatch(await added(), /Log level/);
  await mouseAway();
  assert.match(await added(), /Board: the dev bench/, "leaving the menu leaves it on");
  // Enter applies what showed.
  await hover(".menu.bulb .menu-item", "Name the log level");
  await type(ENTER);
  assert.equal(await value(), core.applyEdit(draft, cards[0].edit));
});

await check("a 💡 open while the panel narrows measures its previews again: a card that adds lines still moves nothing under the pointer (86)", async () => {
  await openGrowing();
  const wide = await rect(".composer .field");
  await exec("document.querySelector('.composer').style.width = '250px'");
  await settle();
  const narrow = await rect(".composer .field");
  assert.ok(narrow[2] < wide[2], `narrower: ${narrow} vs ${wide}`);
  assert.ok(narrow[3] > wide[3], `the field taller, for the tallest preview wrapped anew: ${narrow} vs ${wide}`);
  const menu = await rect(".menu.bulb");
  await hover(".menu.bulb .menu-item", "Name the board");
  assert.equal(await previewing(), true);
  assert.deepEqual(await rect(".composer .field"), narrow, "the field already held it");
  assert.deepEqual(await rect(".menu.bulb"), menu, "the menu never moved");
  await mouseAway();
  await exec("document.querySelector('.composer').style.width = ''");
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
  await settle();
});

await check("the compact card adds /compact focus on: …; Enter sends the draft and the rest waits for the compaction", async () => {
  const draft = "the widget is done. next, move on to the UART driver: add a ring buffer for RX and a test for it";
  const sid = await fresh({ context: { totalTokens: 136000, maxTokens: 200000, percentage: 68, categories: [] } });
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft]);
  const ask = await waitAssist("cards");
  const cards = core.parseCards(haikuAnswer("cards-compact"), draft, "k");
  const compact = cards.find((c) => c.kind === "compact");
  await send([{ t: "cards", seq: ask.seq, cards }]);
  await click(".bulb");
  await settle();
  await hover(".menu.bulb .menu-cat", "Context handling");
  await hover(".menu.bulb .menu-item", compact.title);
  assert.match(await exec("return [...document.querySelectorAll('.overlay .add')].map(e=>e.textContent).join('')"), /\/compact focus on:/);
  await pick(".menu.bulb .menu-item", compact.title);
  await settle();
  const v = await value();
  assert.equal(v, core.applyEdit(draft, compact.edit));
  assert.match(v.split("\n")[0], /^\/compact focus on: \S/);
  await clearPosts();
  await type(ENTER);
  const sentP = (await posts()).find((p) => p.t === "send");
  assert.equal(sentP?.text, v, "the whole draft goes to the host, which sends it in two");
  const split = core.splitCompact(v);
  // What the host then shows: the /compact line, and the rest held for the compaction.
  await send([{ t: "event", e: { type: "_sent", n: 1, text: split.compact } }, { t: "event", e: { type: "_sent", n: 2, text: split.rest, held: true } }]);
  assert.ok((await text(".queue .queued-bar"))[0]?.includes("after the compaction"), "it waits above the input (port item 72)");
  await shot("assist-compact-held");
  // The recorded compaction and turn after it, with this draft's words in place of the recording's.
  const lines = outLines("compact");
  const firstResult = lines.findIndex((o) => o.type === "result");
  const rest = JSON.parse(JSON.stringify(lines.slice(firstResult + 1)).split("What was the secret word? One word.").join(split.rest.replace(/"/g, '\\"')));
  await send(events(rest));
  assert.ok((await text("details.compacted")).length === 1, "compacted");
  assert.equal((await text(".user.pending")).length, 0, "both echoed back");
  assert.equal(sid.length, 36);
});

await check("a held message whose compaction was stopped shows as not sent, and its text comes back to the draft", async () => {
  const sid = await fresh();
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", ["the newer draft"]);
  await send([
    { t: "event", e: { type: "_sent", n: 1, text: "/compact focus on: the widget" } },
    { t: "event", e: { type: "_sent", n: 2, text: "now add the blink test", held: true } },
    { t: "event", e: { type: "_unsent", id: "s:2" } },
    { t: "draft", sid, text: "now add the blink test" },
  ]);
  assert.ok((await text(".user.unsent"))[0]?.includes("not sent"));
  assert.equal((await text(".user.pending .held")).length, 0, "no longer waiting");
  assert.equal(await value(), "now add the blink test\n\nthe newer draft", "back first, the newer draft after it");
});

await check("text for a chat's draft that lands before its composer listens is not lost", async () => {
  const sid = `22222222-0000-4000-8000-${String(++sidN).padStart(12, "0")}`;
  // The snapshot and the draft in one go: the composer mounts after the draft arrived.
  await send([snapshot({ sessionId: sid }), { t: "draft", sid, text: "Read the issue and start on it." }]);
  assert.equal(await value(), "Read the issue and start on it.");
});

await check("an unsent draft is told to the host a moment after the last key; given back after a reload, it fills an empty draft only — a sidebar that kept it holds it once (63)", async () => {
  const sid = await fresh({}, false);
  await type("half a thought about the");
  await sleep(450);
  assert.deepEqual((await posts()).filter((p) => p.t === "typed" && p.sid === sid), [{ t: "typed", sid, text: "half a thought about the" }], "once, after the pause");
  // The sidebar kept its page state across the reload: the host's copy does not double it.
  await send([{ t: "draft", sid, text: "half a thought about the", typed: true }]);
  assert.equal(await value(), "half a thought about the");
  // An editor tab's new page starts empty: the host's copy is the draft.
  const tab = `22222222-0000-4000-8000-${String(++sidN).padStart(12, "0")}`;
  await send([snapshot({ sessionId: tab }), { t: "draft", sid: tab, text: "the tab's unsent words", typed: true }]);
  assert.equal(await value(), "the tab's unsent words");
});

await check("a draft given back after a reload and sent at once is told to the host as gone: the next reload does not bring it back (63; review r6 nit)", async () => {
  const sid = await fresh({}, false);
  await send([{ t: "draft", sid, text: "the words from before the reload", typed: true }]);
  await type(ENTER);
  await sleep(450);
  const ps = await posts();
  assert.equal(ps.filter((p) => p.t === "send").length, 1, "sent");
  assert.deepEqual(ps.filter((p) => p.t === "typed" && p.sid === sid), [{ t: "typed", sid, text: "" }]);
});

await check("just before send: a long draft typed fast waits for its cards; the 💡 opens; Enter again sends it as it is", async () => {
  await fresh();
  const draft = "please also update the readme with the new flash steps";
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft]);
  await type(ENTER);
  let ps = await posts();
  assert.ok(!ps.some((p) => p.t === "send"), "held");
  const ask = ps.filter((p) => p.t === "assist" && p.kind === "cards").at(-1);
  assert.equal(ask.text, draft);
  assert.equal(await exec("return document.querySelector('.bulb').classList.contains('checking')"), true);
  await send([{ t: "cards", seq: ask.seq, cards: [{ id: "h1", category: "refs", title: "Name the readme section", edit: { op: "append", text: "(the Flashing section)" } }] }]);
  assert.equal((await text(".menu.bulb")).length, 1, "the 💡 opens on its cards");
  assert.ok(!(await posts()).some((p) => p.t === "send"));
  await type(ENTER);
  ps = await posts();
  assert.equal(ps.find((p) => p.t === "send")?.text, draft, "the next Enter sends it as it is");
  // A short reply never waits.
  await clearPosts();
  await type("done" + ENTER);
  assert.equal((await posts()).find((p) => p.t === "send")?.text, "done");
  // No cards: it goes as soon as the answer comes.
  await clearPosts();
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft + " too"]);
  await type(ENTER);
  const ask2 = await lastAssist("cards");
  await send([{ t: "cards", seq: ask2.seq, cards: [] }]);
  assert.equal((await posts()).find((p) => p.t === "send")?.text, draft + " too");
});

await check("a 💡 menu whose cards stop applying closes with them: the next Esc is Stop's (26, 38)", async () => {
  const ESC = "";
  await fresh();
  await send([sent("flash it"), toolCall("tf1", "mcp__embarch-api__flash", { project: "demo" })]);
  const draft = "please also update the readme with the new flash steps";
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft]);
  await type(ENTER);
  const ask = await lastAssist("cards");
  await send([{ t: "cards", seq: ask.seq, cards: [{ id: "r1", category: "refs", title: "Name the file", edit: { op: "replace", find: "readme", with: "README.md" } }] }]);
  assert.equal((await text(".menu.bulb")).length, 1, "the 💡 opens on its card");
  // The owner rewrites the word the card would change: no card applies, the menu goes.
  await exec("const t=document.querySelector('.composer textarea'); t.value='please also update the docs with the new flash steps'; t.dispatchEvent(new Event('input', {bubbles:true}))");
  await settle();
  assert.equal((await text(".menu.bulb")).length, 0);
  await clearPosts();
  await type(ESC);
  assert.ok((await posts()).some((p) => p.t === "interrupt"), "the first Esc stops the turn");
});

// Decision 55: the question recorded with a message sent while it waited (askqueued).
const askLines = outLines("askqueued");
const askAt = askLines.findIndex((o) => o.type === "control_request");
/** Where the input is, the caret, who has focus, and how the cards show. */
const where = () =>
  exec(`const t=document.querySelector('.composer textarea'), r=document.querySelector('.composer').getBoundingClientRect();
    return {top: r.top, bottom: r.bottom, caret: t.selectionStart, focus: document.activeElement === t, held: document.querySelectorAll('.card.held').length,
      shown: document.querySelectorAll('.card:not(.held)').length, opts: document.querySelectorAll('.card .opt').length}`);
const answered = async () => (await posts()).filter((p) => ["answer", "allow", "deny"].includes(p.t));
/** A fresh chat whose question is about to come, and a draft being typed. */
const typingWhenAsked = async (draft) => {
  await fresh({}, false);
  await send([sent("tea or coffee"), ...events(askLines.slice(0, askAt))]);
  await type(draft);
  const before = await where();
  await send(events([askLines[askAt]]));
  return before;
};

await check("a card that comes while the owner types waits as a quiet line: focus, caret and the input stay; Enter queues the draft, never answers; then the card comes forward", async () => {
  const before = await typingWhenAsked("also end with");
  let at = await where();
  assert.deepEqual([at.held, at.shown, at.opts], [1, 0, 0], "held: one line, no options to pick");
  assert.ok((await text(".card.held"))[0].includes("Claude asks: Do you prefer tea or coffee?"));
  assert.equal(at.focus, true, "focus stays in the input");
  assert.equal(at.caret, before.caret, "the caret does not move");
  assert.equal(at.top, before.top, "the input does not move");
  await shot("ask-held");
  await type(" the word kiwi");
  assert.equal(await value(), "also end with the word kiwi");
  assert.equal((await where()).held, 1, "still typing: still held");
  await type(ENTER);
  assert.deepEqual(
    (await posts()).filter((p) => p.t === "send").map((p) => p.text),
    ["also end with the word kiwi"],
    "the draft goes as a message, queued behind the question",
  );
  assert.deepEqual(await answered(), [], "nothing typed answered the card");
  at = await where();
  assert.deepEqual([at.held, at.shown, at.opts], [0, 1, 2], "sent: the card comes forward");
  assert.equal(at.focus, true, "and does not take focus");
  assert.equal(at.top, before.top);
  assert.match(await exec("return document.querySelector('.composer .bar button.primary').title"), /after your answer/);
  await shot("ask-active");
  await type("more");
  assert.equal((await where()).held, 0, "once shown, typing again does not hide it");
});

await check("a held card comes forward when the input is left, the draft cleared, or the typing pauses, and on Show — never taking focus", async () => {
  await typingWhenAsked("half a");
  assert.equal((await where()).held, 1);
  await exec("document.querySelector('.composer textarea').blur()");
  await settle();
  assert.deepEqual([(await where()).held, (await where()).opts], [0, 2], "left");

  await typingWhenAsked("half a");
  assert.equal((await where()).held, 1);
  await exec("const t=document.querySelector('.composer textarea'); t.value=''; t.dispatchEvent(new Event('input', {bubbles:true}))");
  await settle();
  let at = await where();
  assert.deepEqual([at.held, at.opts, at.focus], [0, 2, true], "cleared");

  const before = await typingWhenAsked("half a");
  assert.equal((await where()).held, 1);
  await sleep(1500 + 300);
  await settle();
  at = await where();
  assert.deepEqual([at.held, at.opts, at.focus, at.caret], [0, 2, true, before.caret], "a pause of 1.5 s, as Claude Code's own panel");

  await typingWhenAsked("half a");
  await click(".card.held button", "Show");
  await settle();
  assert.equal((await where()).opts, 2, "Show");
  assert.deepEqual(await answered(), []);
});

await check("in a short panel a card scrolls, and the input stays where it was", async () => {
  await wd("POST", `${S}/window/rect`, { width: 460, height: 380 });
  try {
    await fresh({}, false);
    await send([sent("tea or coffee"), ...events(askLines.slice(0, askAt))]);
    const before = await where();
    await send(events([askLines[askAt]]));
    const at = await where();
    assert.equal(at.opts, 2);
    assert.deepEqual([at.top, at.bottom], [before.top, before.bottom], "the card did not push the input down");
    assert.ok(at.bottom <= (await exec("return window.innerHeight")), "the input is on screen");
  } finally {
    await wd("POST", `${S}/window/rect`, { width: 460, height: 900 });
    await settle();
  }
});

// Decision 66: what the CLI asks besides permission prompts. The form is
// recorded (elicit); the link and the CLI's own dialogs are built from the
// CLI's schema — elicitbare's recorded link, the dialogs' payloads — since
// those cannot be had on demand.
const elicitLines = outLines("elicit");
const elicitUpTo = upTo(elicitLines, (o) => o.request?.subtype === "elicitation").filter((o) => o.request?.subtype !== "can_use_tool");
const cliAsks = (request_id, request) => ({ t: "event", e: { type: "control_request", request_id, request } });
const responded = async () => (await posts()).filter((p) => p.t === "respond");
const AUTO = {
  subtype: "request_user_dialog",
  dialog_kind: "auto_mode_server_fallback",
  payload: {
    title: "Auto mode is using billed classifier requests",
    paragraphs: ["Claude Code's built-in classifier is answering for auto mode in this session, and its requests are billed.", "Continue to keep going in auto mode, or Stop to end this turn."],
    helpUrl: "https://code.claude.com/docs/en/auto-mode-classifier-billing",
  },
};
const REFUSAL = { subtype: "request_user_dialog", dialog_kind: "refusal_fallback_prompt", payload: { originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8", apiRefusalCategory: null } };

await check("an MCP server's form: its fields, a required one named, Accept sends the values typed; Decline", async () => {
  await fresh({}, false);
  await send([sent("pick a port"), ...events(elicitUpTo)]);
  assert.equal((await text(".card")).length, 1, "the tool's own permission was answered: one card");
  assert.deepEqual(await text(".card .card-title span"), ["bench asks"]);
  assert.ok((await text(".card p"))[0].includes("Which serial port should the test use?"));
  assert.deepEqual(await text(".card .field-label"), ["Serial port (required)", "Baud rate", "Parity", "Verbose log"]);
  assert.equal(await exec("return document.querySelectorAll('.card .field input')[1].value"), "115200", "the schema's default");
  await click(".card button", "Accept");
  assert.deepEqual(await text(".card .actions .err"), ["Serial port is required"]);
  assert.deepEqual(await responded(), [], "nothing sent without the required field");
  await exec("const i=document.querySelector('.card .field input'); i.value='/dev/ttyACM0'; i.dispatchEvent(new Event('input', {bubbles:true}))");
  await settle();
  await shot("dialog-elicitation");
  await click(".card button", "Accept");
  const r = await responded();
  assert.deepEqual(r.map((x) => x.response), [{ action: "accept", content: { port: "/dev/ttyACM0", baud: 115200, verbose: false } }]);
  assert.equal(r[0].requestId, elicitUpTo.at(-1).request_id);
  await clearPosts();
  await click(".card button", "Decline");
  assert.deepEqual((await responded()).map((x) => x.response), [{ action: "decline" }]);
});

await check("an MCP server's link: shown, Open opens it and accepts; × cancels", async () => {
  await fresh({}, false);
  await send([
    sent("sign in"),
    cliAsks("r-url", { subtype: "elicitation", mcp_server_name: "bench", display_name: "Your Bank", message: "Sign in to the test bench to continue.", mode: "url", url: "https://example.com/bench/sign-in", elicitation_id: "bench-sign-in-1" }),
  ]);
  assert.deepEqual(await text(".card .url"), ["https://example.com/bench/sign-in"]);
  assert.deepEqual(await text(".card .url-host"), ["bench asks to open example.com"], "the server by the name the owner configured, and where the link goes");
  await click(".card button", "Open");
  const ps = await posts();
  assert.deepEqual(ps.find((p) => p.t === "openLink"), { t: "openLink", url: "https://example.com/bench/sign-in" });
  assert.deepEqual(ps.find((p) => p.t === "respond").response, { action: "accept" });
  await clearPosts();
  await click(".card button.close");
  assert.deepEqual((await responded()).map((x) => x.response), [{ action: "cancel" }]);
  // A link to this machine, or not over https: shown, never opened from the card.
  for (const url of ["http://127.0.0.1:4890/login", "https://localhost/login", "https://[::1]/login", "http://example.com/bench/sign-in"]) {
    await fresh({}, false);
    await send([sent("sign in"), cliAsks("r-url", { subtype: "elicitation", mcp_server_name: "bench", message: "Sign in to continue.", mode: "url", url, elicitation_id: "bench-sign-in-2" })]);
    assert.deepEqual(await text(".card .actions button"), ["Decline"], `${url}: no Open`);
  }
});

await check("auto mode's billing notice: its title and words, Learn more, Continue or Stop as Claude Code answers", async () => {
  await fresh({}, false);
  await send([sent("go on"), cliAsks("r-auto", AUTO)]);
  assert.deepEqual(await text(".card .card-title"), ["Auto mode is using billed classifier requests"]);
  assert.equal((await text(".card p")).length, 3, "two paragraphs and Learn more");
  await click(".card a", "Learn more");
  assert.deepEqual((await posts()).find((p) => p.t === "openLink"), { t: "openLink", url: AUTO.payload.helpUrl });
  await shot("dialog-auto-mode");
  await click(".card button", "Continue");
  await click(".card button", "Stop");
  assert.deepEqual(
    (await responded()).map((x) => [x.requestId, x.response]),
    [
      ["r-auto", { behavior: "completed", result: "continue" }],
      ["r-auto", { behavior: "completed", result: "interrupt" }],
    ],
  );
});

await check("a flagged message: Session paused; Switch to the fallback, or Edit prompt puts the message back in the draft; × cancels", async () => {
  await fresh({}, false);
  await send([sent("why does the board reset"), cliAsks("r-refusal", REFUSAL)]);
  assert.deepEqual(await text(".card .card-title span"), ["Session paused"]);
  assert.ok((await text(".card p"))[0].startsWith("Opus 5.5's safeguards flagged this message."), (await text(".card p"))[0]);
  assert.deepEqual(await text(".card .actions button"), ["Switch to Opus 4.8", "Edit prompt and retry with Opus 5.5"]);
  await shot("dialog-refusal");
  await click(".card button", "Switch to");
  await click(".card button", "Edit prompt");
  await click(".card button.close");
  assert.deepEqual(
    (await responded()).map((x) => x.response),
    [
      { behavior: "completed", result: "retry_fallback" },
      { behavior: "completed", result: "edit_prompt" },
      { behavior: "cancelled" },
    ],
  );
  assert.equal(await value(), "why does the board reset", "the message is back in the draft");
});

await check("a dialog that comes while the owner types waits as a quiet line, as any card (55)", async () => {
  await fresh({}, false);
  await send([sent("go on")]);
  await type("half a thought");
  await send([cliAsks("r-auto-2", AUTO)]);
  assert.deepEqual(await text(".card.held .held-what"), ["Auto mode: Continue or Stop?"]);
  await click(".card.held button", "Show");
  assert.equal((await text(".card.dialog-card")).length, 1);
});

await check("a request the panel cannot show leaves one line in the timeline, and no card", async () => {
  await fresh({}, false);
  await send([sent("go on"), cliAsks("r-x", { subtype: "ui_prompt_read", surface: "panel" })]);
  assert.deepEqual(await text(".note.info"), ['Claude Code asked this panel for "ui_prompt_read", which it cannot show: declined.']);
  assert.equal((await text(".card")).length, 0);
});

// Decision 67: the account's usage limit — the recorded line (elicit), and
// the same line as the CLI writes it nearer a limit.
const limitLine = elicitLines.find((o) => o.type === "rate_limit_event");
const limit = (info) => ({ t: "event", e: { ...limitLine, rate_limit_info: info } });
const inH = (h) => Math.floor(Date.now() / 1000 + h * 3600 + 60);

await check("the usage-limit banner: nothing while allowed; from 70 % the percent and the reset; the limit hit, wrapping up; × hides it until the limit changes", async () => {
  // One reset time: the banner knows a limit by it, and two reads a second apart would be two limits.
  const week = inH(50);
  await fresh({}, false);
  await send([sent("flash it"), limit(limitLine.rate_limit_info)]);
  assert.deepEqual(await text(".limit-banner"), [], "allowed: nothing");
  await send([limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.69, resetsAt: week })]);
  assert.deepEqual(await text(".limit-banner"), [], "under 70 %: nothing");
  await send([limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86, resetsAt: week })]);
  assert.deepEqual(await text(".limit-banner.warn span"), ["You've used 86% of your weekly limit · resets in 2d"]);
  await shot("limit-warning");
  await click(".limit-banner button");
  assert.deepEqual(await text(".limit-banner"), [], "hidden");
  await send([limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, resetsAt: week })]);
  assert.deepEqual(await text(".limit-banner"), [], "the same limit stays hidden");
  await send([limit({ status: "rejected", rateLimitType: "five_hour", resetsAt: inH(2), rateLimitGraceActive: true })]);
  assert.deepEqual(await text(".limit-banner.err span"), ["Usage limit reached · wrapping up"], "a new limit shows; the turn under way finishes");
  await shot("limit-wrapping-up");
  await send([{ t: "event", e: { type: "result", subtype: "success", is_error: false } }]);
  assert.deepEqual(await text(".limit-banner.err span"), ["Usage limit reached · session limit resets in 2h"]);
});

// Decision 68: time on screen.
const ago = (ms) => new Date(Date.now() - ms).toISOString();

await check("times above messages: none by default; with the setting, the owner's at the right and Claude's at the left, to the second, a date line where the day changes", async () => {
  const first = "Run the bash command `echo hello-from-bash` and then reply with just: done";
  // Sent the day before the recorded replies: a date line at the first time, and one where the day changes.
  const turn = [{ t: "event", e: { type: "_sent", n: 1, text: first, at: Date.parse("2026-10-23T06:20:38.000Z") - 86_400_000 } }, ...events(outLines("basic"))];
  await send([snapshot(), ...turn]);
  assert.deepEqual(await text(".stamp"), [], "off by default");
  await send([snapshot({}, { ...OURS, timestamps: true }), ...turn]);
  const stamps = await exec("return [...document.querySelectorAll('.stamp')].map(e => [e.textContent, e.classList.contains('mine'), e.title, getComputedStyle(e).alignSelf])");
  assert.deepEqual(stamps.map((x) => x[1]), [true, false, true, false], "the owner's two messages and Claude's two replies");
  for (const [t, , title] of stamps) {
    assert.match(t, /^\d\d:\d\d:\d\d$/);
    assert.match(title, /^2026-10-2\d \d\d:\d\d:\d\d\.\d{3}$/);
  }
  assert.equal(stamps[0][3], "flex-end", "over the owner's bubble");
  assert.deepEqual((await text(".day-line")).length, 2, "the first day, then the next");
  assert.equal(await exec("return document.querySelector('.tool .elapsed')"), null, "a quick step shows no time");
  await shot("timestamps");
});

await check("a running step counts its time, and a long one keeps how long it took; Not responding after a minute with no line and no tool running", async () => {
  await send([snapshot({ busy: true, lastLineAt: Date.now() - 61_000 }), sent("flash it")]);
  assert.deepEqual(await text(".status-line .stalled"), [" Not responding"]);
  assert.match(await exec("return document.querySelector('.status-line .stalled').title"), /^No word from Claude Code for 1m 0\ds, and no tool is running$/);
  await shot("not-responding");
  await send([{ t: "event", e: { type: "stream_event", event: { type: "message_start", message: { id: "m9" } }, _at: Date.now() } }]);
  assert.deepEqual(await text(".status-line .stalled"), [], "a line came: Working… again");

  await send([snapshot({ busy: true, lastLineAt: Date.now() - 75_000 }), sent("flash it")]);
  await send([{ t: "event", e: { type: "assistant", message: { id: "m8", content: [{ type: "tool_use", id: "t8", name: "Bash", input: { command: "west flash", description: "Flash the board" } }] }, timestamp: ago(75_000) } }]);
  assert.deepEqual(await text(".status-line .stalled"), [], "a long flash is not a stuck CLI");
  assert.match((await text(".tool .elapsed"))[0], /^1m 1[5-7]s$/);
  await shot("step-running");
  await send([{ t: "event", e: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t8", content: "flashed" }] }, timestamp: ago(1_000) } }]);
  assert.match((await text(".tool .elapsed"))[0], /^1m 1[3-5]s$/, "done: how long it took");
});

// Decision 69: the prompt cache clock, from the recorded replies' usage (basic: the one-hour cache), retimed to now.
await check("the prompt cache clock between turns: warm with the minutes left, kept when the process closes; likely expired; not covering a compaction; nothing while a turn runs", async () => {
  const retimed = outLines("basic").map((o) => (o.type === "assistant" ? { ...o, timestamp: ago(2 * 60_000 + 5_000) } : o));
  await send([snapshot(), sent("Run the bash command `echo hello-from-bash` and then reply with just: done"), ...events(retimed)]);
  assert.deepEqual(await text(".status-line .cache.warm"), ["Prompt cache warm, about 58 min left"]);
  await send([{ t: "event", e: { type: "_process", state: "closed" } }]);
  assert.deepEqual(await text(".status-line span"), ["Closed when idle — the next message resumes it.", "Prompt cache warm, about 58 min left"], "the idle close leaves the cache as it was (41)");
  await shot("cache-warm");
  await send([sent("go on")]);
  assert.deepEqual(await text(".status-line .cache"), [], "a turn runs: no clock");
  await send([snapshot({ cache: { msgId: "m", at: Date.now() - 61 * 60_000, ttl: 3_600_000 } })]);
  assert.deepEqual(await text(".status-line .cache.cold"), ["Prompt cache likely expired (idle 1h 1m)"]);
  assert.match(await exec("return document.querySelector('.status-line .cache').title"), /^Idle 1h 1m\. The prompt cache has likely expired/);
  await shot("cache-cold");
  await send(events([outLines("compact").find((o) => o.subtype === "compact_boundary")]));
  assert.deepEqual(await text(".status-line .cache.compacted"), ["Prompt cache does not cover the compacted conversation"]);
});

// ------------------------------------------------------------ work that runs on its own (port items 70–72)

const isTaskStarted = (o) => o.type === "system" && o.subtype === "task_started";
const isResultLine = (o) => o.type === "result";
/** A recording's lines without its permission prompts: they were allowed, and cards are not what these checks look at. */
const allowed = (name) => outLines(name).filter((o) => o.type !== "control_request");
/** The host's answer to the page's read of a task's output. */
const taskOut = (taskId, output) => ({ t: "taskOutput", taskId, output, totalBytes: output.length, truncated: false });
const postsOf = async (t) => (await posts()).filter((p) => p.t === t);

await check("a running Bash call offers Run in background under its row; a click asks for it and opens the background tasks; the row then says where it runs and how it ended (port items 70, 71)", async () => {
  await fresh({}, false);
  const lines = allowed("runbg");
  const at = lines.findIndex(isTaskStarted);
  const { tool_use_id: call, task_id: task } = lines[at];
  await send([sent("count the ticks"), ...events(lines.slice(0, at + 1))]);
  assert.deepEqual(await text(".timeline .tool:not(.run) > .bg-line button"), ["Run in background"]);
  await shot("bg-run-in-background");
  await click(".bg-line button");
  await settle();
  assert.deepEqual(await postsOf("runInBackground"), [{ t: "runInBackground", toolUseId: call }]);
  assert.deepEqual(await text(".bg-line button"), ["Moving to the background…"]);
  // The CLI moved it, and the turn went on.
  const end = lines.findIndex(isResultLine);
  await send(events(lines.slice(at + 1, end + 1)));
  assert.equal((await text(".bg-line")).length, 0, "nothing more to move");
  assert.deepEqual(await text(".timeline .tool > .line .st.bg"), ["in the background"]);
  assert.deepEqual(await text(".status-line .bg-toggle"), ["▾ 1 background task"], "opened by the owner's own click");
  assert.deepEqual(await text(".bg-task .kind"), ["shell"]);
  assert.ok((await postsOf("taskOutput")).some((p) => p.taskId === task), "its output is asked for");
  await send([taskOut(task, "tick 1\ntick 2\n\x1b[32mtick 3\x1b[0m\n")]);
  assert.deepEqual(await text(".bg-task pre.out"), ["tick 1\ntick 2\ntick 3\n"], "plain text, escapes out");
  await shot("bg-tasks-open");
  await clearPosts();
  await sleep(1300);
  assert.ok((await postsOf("taskOutput")).some((p) => p.taskId === task), "read again a second later while it runs, as Claude Code's panel polls");
  await click(".bg-task button", "Stop");
  assert.deepEqual((await postsOf("stopTask")).map((p) => p.taskId), [task]);
  // Stopped: the CLI's list empties; the row says how it ended.
  await send(events(lines.slice(end + 1)));
  assert.equal((await text(".bg-task")).length, 0);
  assert.equal((await text(".bg-toggle")).length, 0);
  assert.deepEqual(await text(".timeline .tool > .line .st.stopped"), ["stopped"]);
});

await check("a folded run whose latest step runs in the foreground offers Run in background on its header; a thread run elsewhere offers none (port item 70)", async () => {
  const sid = await fresh({}, false);
  const lines = [
    sent("build it"),
    toolCall("tb1", "Bash", { command: "ls", description: "List the build folder" }),
    toolResult("tb1", "build"),
    toolCall("tb2", "Bash", { command: "west build -b nrf54l15dk", description: "Build the firmware" }),
    { t: "event", e: { type: "system", subtype: "task_started", task_id: "bt2", tool_use_id: "tb2", description: "west build", is_backgrounded: false, task_type: "local_bash" } },
  ];
  await send(lines);
  assert.deepEqual(await runRows(), [{ count: "2 steps", st: "", spin: true, open: false }]);
  assert.deepEqual(await text(".timeline > div > .run > .bg-line button"), ["Run in background"], "reachable folded");
  await shot("bg-run-header");
  await click(".run > .bg-line button");
  assert.deepEqual((await postsOf("runInBackground")).map((p) => p.toolUseId), ["tb2"]);
  // The same state, shown read-only: nothing that acts.
  let st = { ...core.initialState(sid), cwd: "/work/rec/x", process: "running" };
  for (const m of lines) st = core.reduce(st, m.e);
  await send([snapshot(st, { ...OURS, ours: false, readOnly: true, where: "a terminal" })]);
  assert.equal((await text(".bg-line")).length, 0);
});

await check("a background agent's card opens to the subagent's report, not the launch reply (decision 90)", async () => {
  await fresh({}, false);
  const lines = allowed("notifyidle");
  const task = lines.find((o) => isTaskStarted(o) && o.task_type === "local_agent").task_id;
  const report = "Found two files.\n\n- a.txt\n- b.txt";
  const hand = { type: "user", isMeta: true, message: { role: "user", content: `Another Claude session sent a message:\n<agent-message from="${task}">\n[Subagent hand-back]\n${report}\n</agent-message>` }, origin: { kind: "peer", handback: true, from: task, senderTaskId: task, body: report } };
  await send([sent("start an agent"), ...events([...lines, hand])]);
  assert.equal(await exec("return document.querySelectorAll('.tool details.report').length"), 1, "one report on the card");
  assert.equal(await exec("return document.querySelector('.tool details.report').open"), false, "collapsed");
  await click(".tool details.report summary");
  assert.deepEqual(await text(".tool details.report li"), ["a.txt", "b.txt"]);
  assert.ok(!(await text(".timeline")).join("").includes("Async agent launched"), "the launch reply is not the result");
  await shot("agent-report");
});

await check("background tasks open from the status line: a subagent shows its progress and a Stop, no output to read; Stop on the turn says background tasks go on (port item 71)", async () => {
  await fresh({}, false);
  const lines = allowed("agentbg");
  const end = lines.findIndex(isResultLine);
  await send([sent("ask a subagent"), ...events(lines.slice(0, end + 1))]);
  assert.deepEqual(await text(".status-line .bg-toggle"), ["▸ 2 background tasks"]);
  assert.equal((await text(".bg-tasks")).length, 0, "closed until asked");
  await click(".bg-toggle");
  assert.deepEqual(await text(".bg-task .kind"), ["agent", "shell"]);
  assert.match((await text(".bg-task .progress"))[0], /\S/, "the subagent's latest progress");
  assert.equal(await exec("return !!document.querySelectorAll('.bg-task')[0].querySelector('pre, .task-out')"), false, "a subagent has no output to read");
  assert.ok(!(await text(".timeline")).join("").includes("Async agent launched"), "the launch placeholder is not shown as its result");
  await shot("bg-tasks-agent");
  const agentTask = lines.find((o) => isTaskStarted(o) && o.task_type === "local_agent").task_id;
  await clearPosts();
  await click(".bg-task button", "Stop");
  assert.deepEqual((await postsOf("stopTask")).map((p) => p.taskId), [agentTask]);
  await click(".bg-toggle");
  assert.equal((await text(".bg-tasks")).length, 0, "closes again");
  await send([sent("and now this")]);
  assert.match(await exec("return document.querySelector('.composer .bar button[title^=\"Stop\"]').title"), /background tasks go on/);
});

await check("the status area with everything at once: the usage banner, the background tasks open, the status line's switch and the prompt cache clock, in that order; Not responding with a task in the background (67, 68, 69, port item 71)", async () => {
  await fresh({}, false);
  const lines = allowed("bgstop");
  const first = lines.findIndex(isResultLine);
  // Between turns: a shell runs in the background, the cache warm, the weekly limit at 86 %.
  await send([
    sent("count the ticks"),
    ...events(lines.slice(0, first + 1).map((o) => (o.type === "assistant" ? { ...o, timestamp: ago(60_000) } : o))),
    limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86, resetsAt: inH(50) }),
  ]);
  await click(".bg-toggle");
  await settle();
  const task = lines.find(isTaskStarted).task_id;
  await send([taskOut(task, "tick 1\ntick 2\ntick 3\n")]);
  assert.deepEqual(await text(".bg-task pre.out"), ["tick 1\ntick 2\ntick 3\n"]);
  const order = await exec(
    "const at = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; }; return [at('.limit-banner'), at('.bg-tasks'), at('.status-line'), at('.composer')]",
  );
  assert.ok(order.every((x) => x !== null), `all present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "banner, tasks, status line, input, top to bottom");
  assert.deepEqual(await text(".status-line > span"), ["▾ 1 background task", "Prompt cache warm, about 59 min left"]);
  assert.equal(await exec("const l = document.querySelector('.status-line'); return l.scrollWidth <= l.clientWidth"), true, "one line, nothing cut");
  await shot("status-all");
  // A turn gone quiet for a minute: a step moved to the background is not a
  // step of the turn — Not responding, the switch beside it — and one running
  // in the foreground is (68).
  const quietFor = (name, upto) => ({ ...core.reduceAll(core.initialState(SID), allowed(name).slice(0, upto)), cwd: "/work/rec/x", process: "running", busy: true, lastLineAt: Date.now() - 75_000 });
  await send([snapshot(quietFor("bgstop", first + 1))]);
  assert.deepEqual(await text(".status-line .stalled"), [" Not responding"], "a task in the background is not a step of the turn");
  assert.ok((await text(".status-line .bg-toggle"))[0].includes("1 background task"));
  await shot("status-stalled-bg");
  await send([snapshot(quietFor("runbg", allowed("runbg").findIndex(isTaskStarted) + 1))]);
  assert.deepEqual(await text(".status-line .stalled"), [], "a step running in the foreground is");
});

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await check("a task's end the CLI replays is one line, not a bubble the owner sent; a click opens its card, a peer's message folds to its sender (decision 89)", async () => {
  await fresh({}, false);
  const lines = allowed("notifymid");
  await send([sent(lines.find((o) => o.type === "user" && !o.origin && typeof o.message.content === "string").message.content), ...events(lines)]);
  assert.deepEqual(await text(".note.task"), ['Agent "Reply with PING" completed']);
  assert.equal((await text(".user")).length, 1, "only the owner's own message is a bubble");
  assert.ok(!(await text(".timeline")).join("").includes("<task-notification>"), "no raw XML");
  // Close the card the row names, then the row opens it.
  const agentId = lines.find((o) => o.type === "assistant" && o.message.content.some((b) => b.type === "tool_use" && b.name === "Agent")).message.content.find((b) => b.name === "Agent").id;
  const body = (id) => exec("const t = [...document.querySelectorAll('[data-tool]')].find((x) => x.dataset.tool === arguments[0]); return !!t.querySelector(':scope > .body')", [id]);
  assert.equal(await body(agentId), true, "a subagent's card starts open");
  await exec("[...document.querySelectorAll('[data-tool]')].find((x) => x.dataset.tool === arguments[0]).querySelector(':scope > .line').click()", [agentId]);
  await settle();
  assert.equal(await body(agentId), false, "closed");
  await click("button.note.task");
  await settle();
  assert.equal(await body(agentId), true, "the click opened it");
  // Another session's message: collapsed to its sender.
  await send([{ t: "event", e: { type: "user", message: { role: "user", content: 'Another Claude session sent a message:\n<agent-message from="build-helper">run the tests please</agent-message>' }, origin: { kind: "peer" } } }]);
  assert.deepEqual(await text(".note.peer summary"), ["Message from build-helper"]);
  assert.equal(await exec("return document.querySelector('.note.peer').open"), false, "collapsed");
  await click(".note.peer summary");
  assert.deepEqual(await text(".note.peer pre"), ["run the tests please"]);
  assert.equal((await text(".user")).length, 1, "still no second bubble");
  await shot("task-row");
});

const sentU = (n, text) => ({ t: "event", e: { type: "_sent", n, text, uuid: U(n) } });

await check("messages sent while Claude works wait above the input, with Send now and Cancel; one taken back goes to the draft; Claude's echo moves the other into the timeline where it took it (port item 72)", async () => {
  const sid = await fresh({}, false);
  const lines = outLines("queue");
  const call = lines.findIndex((o) => o.type === "assistant" && o.message.content.some((b) => b.type === "tool_use"));
  const two = "Also end your reply with the word: two";
  const three = "Also end your reply with the word: three";
  await send([sentU(1, "Run the bash command `sleep 8; echo one`, then reply with just: one"), ...events(lines.slice(0, call + 1)), sentU(2, two), sentU(3, three)]);
  assert.deepEqual(await text(".queue .queued-text"), [two, three]);
  assert.equal((await text(".timeline .user")).length, 1, "not among the steps");
  assert.deepEqual(await text(".queue .queued-bar button"), ["Send now", "Cancel", "Send now", "Cancel"]);
  assert.match((await text(".queued-bar .muted"))[0], /next step/);
  const box = await exec("return [document.querySelector('.queue').getBoundingClientRect().bottom, document.querySelector('.composer').getBoundingClientRect().top]");
  assert.ok(box[0] <= box[1], "right above the input");
  await shot("queue");
  await exec("document.querySelectorAll('.queued')[1].querySelector('button:last-child').click()");
  await settle();
  assert.deepEqual(await postsOf("cancelQueued"), [{ t: "cancelQueued", id: "s:3" }]);
  // Taken back by the host: gone, its text in the draft.
  await send([{ t: "event", e: { type: "_dequeued", id: "s:3" } }, { t: "draft", sid, text: three }]);
  assert.deepEqual(await text(".queue .queued-text"), [two]);
  assert.equal(await value(), three);
  await click(".queued button", "Send now");
  assert.deepEqual(await postsOf("sendNow"), [{ t: "sendNow", id: "s:2" }]);
  // Claude takes it in after the step.
  await send(events(lines.slice(call + 1)));
  assert.equal((await text(".queue")).length, 0);
  const order = await exec("return [...document.querySelectorAll('.timeline > div > :first-child')].map(e => e.classList.contains('user') ? 'user' : e.classList.contains('tool') ? 'tool' : 'text')");
  assert.deepEqual(order, ["user", "tool", "user", "text"]);
  assert.ok((await text(".timeline .user")).at(-1).startsWith(two), "the last of the owner's messages is the one taken");
});

await check("a message a reload gave back says it goes with Continue, or before the owner's next message — until a process starts for it (63; review r5 N5)", async () => {
  await fresh({}, false);
  await send([
    { t: "event", e: { type: "_note", text: core.RERUN_OFFER_NOTE, tone: "info", offer: "rerun" } },
    { t: "event", e: { type: "_sent", n: 1, text: "Also end your reply with the word: kiwi", restored: true, uuid: U(1) } },
  ]);
  assert.deepEqual(await text(".queued-bar .muted"), ["Queued — goes with Continue, or before your next message"]);
  await send([{ t: "event", e: { type: "_process", state: "starting" } }]);
  assert.deepEqual(await text(".queued-bar .muted"), ["Queued — Claude reads it at its next step"], "Continue started it: the step, then this");
});

await check("a step that cannot move to the background makes Send now say it stops it", async () => {
  await fresh({ capabilities: ["interrupt_send_now_v1"] }, false);
  await send([
    sentU(1, "flash it"),
    toolCall("tf1", "mcp__embarch-api__flash", { project: "demo" }),
    sentU(2, "use the other board"),
  ]);
  assert.deepEqual(await text(".queued-bar button"), ["Stop and send", "Cancel"]);
});

await check("a message sent while a card waits shows in the queue as going after the answer, with no Send now (decision 55)", async () => {
  await fresh({}, false);
  await send([sent("tea or coffee"), ...events(askLines.slice(0, askAt + 1)), { t: "event", e: { type: "_sent", n: 2, text: "Also end your reply with the word: kiwi" } }]);
  assert.match((await text(".queued-bar .muted"))[0], /after your answer to the card above/);
  assert.deepEqual(await text(".queued-bar button"), ["Cancel"]);
  await shot("queue-after-card");
  await send([{ t: "event", e: { type: "_answered", requestId: askLines[askAt].request_id, behavior: "allow" } }, ...events(askLines.slice(askAt + 1))]);
  assert.equal((await text(".queue")).length, 0, "taken after the answer");
  assert.ok((await text(".timeline .user")).some((t) => t.includes("kiwi")));
});

await check("reply chips after a turn: a click sends it; the handoff's chip asks for a fresh chat", async () => {
  const sid = await fresh();
  const chips = [
    { text: "Fresh chat with this handoff", source: "handoff", action: "freshChat" },
    { text: "npm init -y", source: "cli" },
    ...core.parseTurn(haikuAnswer("turn")).chips.map((t) => ({ text: t, source: "haiku" })),
  ].slice(0, 5);
  await send([{ t: "chips", sid: "someone-else", chips: [{ text: "not mine", source: "haiku" }] }]);
  assert.equal((await text(".chip")).length, 0, "another chat's chips do not show");
  await send([{ t: "chips", sid, chips }]);
  assert.deepEqual(await text(".chip"), chips.map((c) => c.text));
  await shot("assist-chips");
  await click(".chip", "npm init -y");
  await click(".chip", "Fresh chat with this handoff");
  const ps = await posts();
  assert.ok(ps.some((p) => p.t === "send" && p.text === "npm init -y"));
  assert.ok(ps.some((p) => p.t === "freshChat"));
  assert.equal(await value(), "", "the draft is left alone");
  await send([{ t: "chips", sid, chips: [] }]);
  assert.equal((await text(".chip")).length, 0);
});

await check("the handoff card turns the draft into a request for a handoff, and its send says so", async () => {
  await fresh({ context: { totalTokens: 172000, maxTokens: 200000, percentage: 86, categories: [] } });
  const draft = "now write the release notes for the whole quarter";
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft]);
  const ask = await waitAssist("cards");
  const cards = core.parseCards(haikuAnswer("cards-context"), draft, "h");
  const handoff = cards.find((c) => c.kind === "handoff");
  await send([{ t: "cards", seq: ask.seq, cards }]);
  await click(".bulb");
  await settle();
  await hover(".menu.bulb .menu-cat", "Context handling");
  await pick(".menu.bulb .menu-item", handoff.title);
  await settle();
  assert.equal(await value(), core.handoffRequest(draft));
  await clearPosts();
  await type(ENTER);
  const p = (await posts()).find((x) => x.t === "send");
  assert.equal(p.handoff, true);
  assert.equal(p.text, core.handoffRequest(draft));
});

await check("the 📚: one submenu per category; a click puts /<name> in the draft as the session knows it", async () => {
  await fresh({ slashCommands: [] });
  await type("for this repo");
  await click(".library");
  await settle();
  assert.deepEqual(await text(".menu.library .menu-cat .menu-label"), ["Bench", "Repo setup", "Other"]);
  await hover(".menu.library .menu-cat", "Repo setup");
  assert.deepEqual(await text(".menu.library .menu-item .menu-item-label"), ["/embarch-claude-md", "/embarch-permissions"]);
  await shot("library-menu");
  await pick(".menu.library .menu-item", "/embarch-permissions");
  await settle();
  assert.equal(await value(), "/embarch-chat:embarch-permissions for this repo", "a plugin's entry, namespaced as the CLI lists it");
  await click(".library");
  await settle();
  await hover(".menu.library .menu-cat", "Other");
  await pick(".menu.library .menu-item", "/notes");
  await settle();
  assert.equal(await value(), "/notes for this repo", "a second pick replaces the first");
  // A started session that does not know the plugin's entries: shown, not offered.
  await fresh({ slashCommands: ["compact", "notes"] });
  await click(".library");
  await settle();
  await hover(".menu.library .menu-cat", "Bench");
  assert.equal(await exec("return document.querySelector('.menu.library .menu-item').classList.contains('disabled')"), true);
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
  await settle();
  // `/` lists the library's entries with the session's own commands.
  await fresh({ slashCommands: ["compact", "embarch-chat:build-flash-verify"] });
  await type("/b");
  assert.deepEqual(await text(".popup div"), ["/embarch-chat:build-flash-verifyBench", "/btwa side question, not part of the conversation"]);
});

// ------------------------------------------------------------ history (decisions 73–75)

const ESC = "";
/** What the page wrote to the clipboard: the browser's own is not the test's to read. */
const stubClipboard = () =>
  exec("window.__clip = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => (window.__clip.push(t), Promise.resolve()) } });");
const clip = () => exec("return window.__clip");
/** The ids the CLI gave the owner's two messages in the basic recording. */
const BASIC_UUIDS = outLines("basic").filter((o) => o.type === "user" && o.isReplay).map((o) => o.uuid);
const basicChat = async (view) => {
  const sid = await fresh();
  await send([...(view ? [snapshot({ sessionId: sid }, view)] : []), sent("Run the bash command `echo hello-from-bash` and then reply with just: done"), ...events(outLines("basic"))]);
  await stubClipboard();
  await clearPosts();
};
/** Opens the menu on the owner's message that holds `t`. */
const messageMenu = async (t) => {
  await exec("const u=[...document.querySelectorAll('.user')].find(x => x.textContent.includes(arguments[0])); u.querySelector('.msg-act').click(); return true;", [t]);
  await settle();
};
const keyOn = (sel, key) => exec("document.querySelector(arguments[0]).dispatchEvent(new KeyboardEvent('keydown', { key: arguments[1], bubbles: true, cancelable: true })); return true;", [sel, key]).then(settle);
/** Keys as the keyboard sends them, to whatever has focus (`type` sends them to the input). */
const keys = async (str) => {
  const actions = [];
  for (const ch of str) actions.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch });
  await wd("POST", `${S}/actions`, { actions: [{ type: "key", id: "kb", actions }] });
  await wd("DELETE", `${S}/actions`);
  await settle();
};
/** What has focus, as its tag and classes. */
const focused = () => exec("const a = document.activeElement; return a ? a.tagName + [...a.classList].map((c) => '.' + c).join('') : null");

await check("a reply's Copy takes the whole reply as Markdown; /copy the latest, /copy 2 the one before — nothing goes to Claude", async () => {
  await basicChat();
  assert.deepEqual(await text(".reply-copy"), ["Copy", "Copy"], "one per finished turn");
  await click(".reply-copy");
  await settle();
  assert.deepEqual(await clip(), ["done"]);
  assert.deepEqual(await text(".reply-copy"), ["Copied", "Copy"]);
  await type("/copy " + ENTER);
  await type("/copy 2" + ENTER);
  await settle();
  assert.deepEqual(await clip(), ["done", "ok", "done"]);
  assert.deepEqual(await text(".toast"), ["Copied to the clipboard (4 characters, 1 line)"]);
  await type("/copy 3" + ENTER);
  assert.deepEqual(await text(".toast"), ["Only 2 replies to copy"]);
  assert.ok(!(await posts()).some((p) => p.t === "send"), "nothing went to Claude");
  await shot("history-copy");
});

await check("a turn still running has no Copy yet", async () => {
  await fresh();
  const lines = outLines("basic");
  await send([sent("Run the bash command `echo hello-from-bash` and then reply with just: done"), ...events(upTo(lines, (o) => o.type === "assistant" && o.message.content.some((b) => b.type === "text")))]);
  assert.deepEqual(await text(".reply-copy"), []);
});

await check("/export: the whole conversation as plain text, copied or saved through VS Code's save dialog", async () => {
  await basicChat();
  await type("/export " + ENTER);
  assert.ok((await posts()).some((p) => p.t === "export"));
  assert.match((await text(".dialog.export p"))[0], /Preparing/);
  const t = "❯ Run the bash command `echo hello-from-bash` and then reply with just: done\n\n● Bash(echo hello-from-bash)\n  ⎿  hello-from-bash\n\n● done\n";
  await send([{ t: "export", text: t, filename: "2026-10-23-140509-run-the-bash-command-echo-hello-from-bash-and-th.txt" }]);
  assert.equal((await text(".dialog.export p"))[0], `The whole conversation as plain text, ${t.length} characters.`);
  await shot("history-export");
  await click(".dialog.export button", "Copy to clipboard");
  await settle();
  assert.deepEqual(await clip(), [t]);
  await click(".dialog.export button", "Save to file");
  const save = (await posts()).find((p) => p.t === "exportSave");
  assert.deepEqual(save, { t: "exportSave" }, "the host saves the text it gave the dialog (review r4 N2)");
  assert.equal((await text(".dialog")).length, 0, "closed");
  assert.ok(!(await posts()).some((p) => p.t === "send"));
  // The dialog takes the keys: Escape closes it.
  await type("/export " + ENTER);
  await exec("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await settle();
  assert.equal((await text(".dialog")).length, 0, "Escape closed it");
});

await check("each of the owner's messages has a menu: fork from it, and with its files in a chat this window runs", async () => {
  await basicChat();
  assert.equal((await text(".user .msg-act")).length, 2);
  await hover(".user", "Reply with just: ok");
  await messageMenu("Reply with just: ok");
  assert.deepEqual(await text(".msg-menu .menu-item"), ["Fork conversation from here", "Rewind code to here", "Fork conversation and rewind code"]);
  await shot("history-message-menu");
  await click(".msg-menu .menu-item", "Fork conversation from here");
  assert.deepEqual((await posts()).filter((p) => p.t === "rewind"), [{ t: "rewind", uuid: BASIC_UUIDS[1], restore: "conversation" }], "a fork changes no file: no confirmation");
  assert.equal((await text(".msg-menu")).length, 0);
  await mouseAway();
});

await check("the ↶ menu by keyboard: Enter opens it, Tab walks its items, Esc closes it and gives the keys back to ↶ (73)", async () => {
  await basicChat();
  await exec("[...document.querySelectorAll('.user')].at(-1).querySelector('.msg-act').focus(); return true");
  await keys(ENTER);
  assert.equal((await text(".msg-menu")).length, 1);
  await keys(TAB);
  assert.equal(await exec("return document.activeElement.textContent"), "Fork conversation from here");
  await keys(TAB);
  assert.equal(await exec("return document.activeElement.textContent"), "Rewind code to here");
  await keys(ESC);
  assert.equal((await text(".msg-menu")).length, 0);
  assert.equal(await focused(), "BUTTON.icon.msg-act");
});

await check("a past chat nothing runs offers the fork alone; a thread run elsewhere, nothing", async () => {
  await basicChat({ ...OURS, ours: false, resumable: true });
  await messageMenu("Reply with just: ok");
  assert.deepEqual(await text(".msg-menu .menu-item"), ["Fork conversation from here"]);
  await basicChat({ ...OURS, ours: false, readOnly: true });
  assert.equal((await text(".user .msg-act")).length, 0);
});

await check("a message given back unsent offers no ↶ and is no point to rewind to; a /compact's rest the CLI took is both (review r6 L1)", async () => {
  await basicChat();
  await send([
    { t: "event", e: { type: "_sent", n: 20, text: "/compact focus on the flash", uuid: U(20) } },
    { t: "event", e: { type: "_sent", n: 21, text: "What was the secret word? One word.", held: true, uuid: U(21) } },
    { t: "event", e: { type: "user", isReplay: true, uuid: U(20), message: { role: "user", content: "/compact focus on the flash" } } },
    { t: "event", e: { type: "result", subtype: "success", is_error: false, num_turns: 0, local_command: "compact" } },
    { t: "event", e: { type: "user", isReplay: true, uuid: U(21), message: { role: "user", content: "What was the secret word? One word." } } },
    { t: "event", e: { type: "assistant", message: { id: "m-sw", content: [{ type: "text", text: "kiwi" }] } } },
    { t: "event", e: { type: "result", subtype: "success", is_error: false, num_turns: 1 } },
    // Given back unsent: Continue refused at the click, or a compaction stopped.
    { t: "event", e: { type: "_sent", n: 22, text: "Also end your reply with the word: mango", restored: true, uuid: U(22) } },
    { t: "event", e: { type: "_unsent", id: "s:22" } },
  ]);
  // Each message's first 40 characters, the unsent one's label after them left out.
  const acts = await exec("return [...document.querySelectorAll('.timeline .user')].map((u) => [u.textContent.replace('↶', '').trim().slice(0, 40), !!u.querySelector('.msg-act')])");
  assert.deepEqual(acts.slice(-2), [["What was the secret word? One word.", true], ["Also end your reply with the word: mango", false]]);
  await type("/rewind " + ENTER);
  assert.deepEqual((await text(".rewind-list li")).slice(0, 2), ["What was the secret word? One word.", "/compact focus on the flash"]);
  await click(".dialog.rewind button", "Close");
});

await check("Rewind code to here: a dry run's files and lines first; the files change only on the owner's click", async () => {
  await basicChat();
  await messageMenu("Reply with just: ok");
  await click(".msg-menu .menu-item", "Rewind code to here");
  assert.deepEqual((await posts()).filter((p) => p.t.startsWith("rewind")), [{ t: "rewindCheck", uuid: BASIC_UUIDS[1] }], "a dry run, nothing else");
  assert.match((await text(".dialog.rewind"))[0], /Checking what the files would lose/);
  assert.equal(await exec("return document.querySelector('.dialog.rewind button.primary').disabled"), true);
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[1], result: { canRewind: true, filesChanged: ["/work/rec/basic/a.txt", "/work/rec/basic/src/b.c"], insertions: 3, deletions: 5 } }]);
  assert.equal((await text(".dialog-title"))[0], "Rewind code");
  assert.equal((await text(".rewind-sum"))[0], "5 lines will be removed and 3 lines added, across 2 files:");
  assert.deepEqual(await text(".rewind-files li"), ["a.txt", "src/b.c"]);
  assert.deepEqual(await text(".dialog .warn"), ["Files edited by hand or by Bash are not rewound."]);
  assert.equal((await text(".choice")).length, 0, "the menu said what to restore");
  await shot("history-rewind-code");
  assert.ok(!(await posts()).some((p) => p.t === "rewind"), "nothing changes before the click");
  await click(".dialog.rewind button", "Never mind");
  assert.equal((await text(".dialog")).length, 0);
  assert.ok(!(await posts()).some((p) => p.t === "rewind"), "Never mind changes nothing");
  await messageMenu("Reply with just: ok");
  await click(".msg-menu .menu-item", "Fork conversation and rewind code");
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[1], result: { canRewind: true, filesChanged: ["/work/rec/basic/a.txt"], insertions: 0, deletions: 1 } }]);
  assert.equal((await text(".dialog-title"))[0], "Fork and rewind");
  assert.equal(await exec("return document.activeElement.classList.contains('dialog')"), true, "the confirmation takes the keys");
  await click(".dialog.rewind button.primary");
  assert.deepEqual((await posts()).filter((p) => p.t === "rewind"), [{ t: "rewind", uuid: BASIC_UUIDS[1], restore: "both" }]);
});

await check("files changed since the confirmation: nothing was rewound, and the confirmation comes back with what a rewind restores now (review r4 L4)", async () => {
  await basicChat();
  await messageMenu("Reply with just: ok");
  await click(".msg-menu .menu-item", "Rewind code to here");
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[1], result: { canRewind: true, filesChanged: ["/work/rec/basic/a.txt"], insertions: 0, deletions: 1 } }]);
  await click(".dialog.rewind button.primary");
  assert.equal((await text(".dialog")).length, 0);
  await clearPosts();
  // The host's fresh dry run at Rewind says otherwise: it did nothing and asks again.
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[1], result: { canRewind: true, filesChanged: ["/work/rec/basic/a.txt", "/work/rec/basic/src/b.c"], insertions: 3, deletions: 5 }, again: "code" }]);
  assert.equal((await text(".dialog-title"))[0], "Rewind code");
  assert.deepEqual(await text(".dialog .warn"), ["The files changed since you looked, so nothing was rewound. This is what a rewind restores now.", "Files edited by hand or by Bash are not rewound."]);
  assert.equal((await text(".rewind-sum"))[0], "5 lines will be removed and 3 lines added, across 2 files:");
  assert.deepEqual(await text(".rewind-files li"), ["a.txt", "src/b.c"]);
  await shot("history-rewind-again");
  await click(".dialog.rewind button.primary");
  assert.deepEqual((await posts()).filter((p) => p.t.startsWith("rewind")), [{ t: "rewind", uuid: BASIC_UUIDS[1], restore: "code" }], "confirmed on the new list");
});

await check("a file rewind Claude Code refuses says why, and its button stays off", async () => {
  await basicChat();
  await messageMenu("Run the bash command");
  await click(".msg-menu .menu-item", "Rewind code to here");
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[0], result: { canRewind: false, error: "No file checkpoint found for this message." } }]);
  assert.deepEqual(await text(".dialog .err"), ["No file checkpoint found for this message."]);
  assert.equal(await exec("return document.querySelector('.dialog.rewind button.primary').disabled"), true);
  await click(".dialog.rewind button", "Never mind");
});

await check("/rewind opens a picker of the owner's messages, newest first, by keyboard; its confirmation offers what applies", async () => {
  await basicChat();
  await type("/rewind " + ENTER);
  assert.ok(!(await posts()).some((p) => p.t === "send"));
  assert.deepEqual(await text(".rewind-list li"), ["Reply with just: ok", "Run the bash command `echo hello-from-bash` and then reply with just: done"]);
  await shot("history-rewind-picker");
  await keyOn(".rewind-list", "ArrowDown");
  assert.deepEqual(await text(".rewind-list li.on"), ["Run the bash command `echo hello-from-bash` and then reply with just: done"]);
  await keyOn(".rewind-list", "Enter");
  assert.deepEqual((await posts()).filter((p) => p.t === "rewindCheck"), [{ t: "rewindCheck", uuid: BASIC_UUIDS[0] }]);
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[0], result: { canRewind: true, filesChanged: ["/work/rec/basic/a.txt"], insertions: 0, deletions: 1 } }]);
  assert.deepEqual(
    (await text(".choice .choice-label")),
    ["Restore code and conversation", "Restore conversation", "Restore code"],
  );
  assert.deepEqual(await text(".choice.on .choice-label"), ["Restore code and conversation"]);
  assert.equal((await text(".rewind-sum")).length, 1);
  await shot("history-rewind-confirm");
  await click(".choice", "Restore conversation");
  assert.equal((await text(".rewind-sum")).length, 0, "the conversation alone touches no file");
  await click(".dialog.rewind button.primary");
  assert.deepEqual((await posts()).filter((p) => p.t === "rewind"), [{ t: "rewind", uuid: BASIC_UUIDS[0], restore: "conversation" }]);
  // Files unchanged since: the conversation alone is offered.
  await type("/rewind " + ENTER);
  await keyOn(".rewind-list", "Enter");
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[1], result: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } }]);
  assert.deepEqual(await text(".choice .choice-label"), ["Restore conversation"]);
  await click(".dialog.rewind button", "Never mind");
});

await check("Esc twice at an idle, empty input opens the picker; once, or with a draft, it does not", async () => {
  await basicChat();
  await type(ESC);
  await sleep(700);
  await type(ESC);
  assert.equal((await text(".dialog.rewind")).length, 0, "two slow ones are not a double");
  await type(ESC + ESC);
  assert.equal((await text(".dialog.rewind")).length, 1);
  await click(".dialog.rewind button", "Close");
  await type("half a thought");
  await type(ESC + ESC);
  assert.equal((await text(".dialog.rewind")).length, 0);
});

await check("closing the rewind picker or the export dialog gives the keys back to the input (73, 74)", async () => {
  await basicChat();
  await type(ESC + ESC);
  assert.equal(await focused(), "UL.rewind-list", "the picker takes the keys");
  await keys(ESC);
  assert.equal((await text(".dialog.rewind")).length, 0);
  assert.equal(await focused(), "TEXTAREA");
  await keys("also check the uart");
  assert.equal(await value(), "also check the uart", "what the owner types next goes into the draft");
  await exec("const t = document.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true }))");
  await type("/export " + ENTER);
  await send([{ t: "export", text: "x", filename: "c.txt" }]);
  assert.equal(await focused(), "DIV.dialog.export");
  await click(".dialog.export button", "Close");
  await settle();
  assert.equal(await focused(), "TEXTAREA");
});

await check("the rewind and export dialogs are their chat's: another chat put in the view closes them (73, 74)", async () => {
  await basicChat();
  await type("/rewind " + ENTER);
  await keyOn(".rewind-list", "Enter");
  await send([{ t: "rewindCheck", uuid: BASIC_UUIDS[1], result: { canRewind: true, filesChanged: ["/work/rec/basic/a.txt"], insertions: 3, deletions: 1 } }]);
  assert.deepEqual(await text(".dialog.rewind .rewind-to"), ["To before Reply with just: ok"]);
  // The list (or the status bar's EmbArch, 54) puts another chat in this view.
  await send([snapshot({ sessionId: "33333333-0000-4000-8000-000000000001", title: "Another chat" })]);
  assert.equal((await text(".dialog.rewind")).length, 0, "no rewind of the first chat's message offered over the second");
  await type("/export " + ENTER);
  assert.equal((await text(".dialog.export")).length, 1);
  await send([snapshot({ sessionId: "33333333-0000-4000-8000-000000000002" })]);
  assert.equal((await text(".dialog.export")).length, 0);
});

await check("the header's ✎ asks the host to rename the chat; a thread run elsewhere has none", async () => {
  await basicChat();
  await click(".header .rename");
  assert.ok((await posts()).some((p) => p.t === "rename"));
  await basicChat({ ...OURS, ours: false, readOnly: true });
  assert.equal((await text(".header .rename")).length, 0);
});

// ------------------------------------------------------------ a long chat (decision 85)

// test/longsession.mjs's generated chat: 60 turns, 600 steps, build logs of
// 100K characters, long replies; and a 20 KB reply streaming in small deltas.
const LONG = longSession();
const longState = (lines = LONG, sessionId = SID) => core.reduceAll({ ...core.initialState(sessionId), cwd: "/work/fw/app", process: "running" }, lines);
const REPLY = streamedReply();
const asyncExec = (script, args = []) => wd("POST", `${S}/execute/async`, { script, args });
const atBottom = () => exec("const t=document.querySelector('.timeline'); return t.scrollHeight - t.scrollTop - t.clientHeight < 40");
const longChat = async (lines, view = OURS) => {
  await go("/chat.html");
  await send([snapshot(longState(lines), view)]);
  await send([sent("Why does the sensor read zero after a flash?")]);
};

await check("a long chat keeps every row in the page, and a delta costs what it costs in an empty chat, give or take: the old rows are not drawn again", async () => {
  await wd("POST", `${S}/timeouts`, { script: 120_000 });
  const deltas = events(REPLY.deltas.slice(0, 150));
  // Against the same deltas in an empty chat on the same machine, so a
  // loaded one slows both; once more before failing. Before decision 85 the
  // long chat cost 8 to 9 times the empty one; now 2.5 to 3.
  let ratio = Infinity;
  let costs = null;
  for (let attempt = 0; attempt < 2 && ratio >= 6; attempt++) {
    await go("/chat.html");
    await send([snapshot(), sent("q")]);
    const empty = await asyncExec(MEASURE_UPDATES, [deltas]);
    await go("/chat.html");
    const open = await asyncExec(MEASURE_OPEN, [snapshot(longState())]);
    assert.equal((await text(".timeline .user")).length, 60, "every turn is in the page: Ctrl+F finds it");
    assert.ok(open.nodes > 5000, `${open.nodes} nodes`);
    await send([sent("q")]);
    const long = await asyncExec(MEASURE_UPDATES, [deltas]);
    // Means: the page's timers are whole milliseconds, a median of them too coarse.
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    costs = { empty: mean(empty.work), long: mean(long.work), open: open.ms };
    ratio = costs.long / costs.empty;
  }
  assert.ok(ratio < 6, `a delta in the long chat took ${ratio.toFixed(1)} times one in an empty chat: ${JSON.stringify(costs)}`);
});

await check("a long chat sticks to the bottom while a reply streams; scrolled up, it stays where the owner left it; back at the bottom, it sticks again", async () => {
  await longChat();
  await send(events(REPLY.deltas.slice(0, 60)));
  assert.ok(await atBottom(), "at the bottom while it streams");
  await exec("const t=document.querySelector('.timeline'); t.scrollTop = 2000;");
  await settle();
  const before = await exec("const t=document.querySelector('.timeline'); return [t.scrollTop, t.scrollHeight]");
  await send(events(REPLY.deltas.slice(60, 200)));
  const after = await exec("const t=document.querySelector('.timeline'); return [t.scrollTop, t.scrollHeight]");
  assert.equal(after[0], before[0], "the owner's place is kept");
  assert.ok(after[1] > before[1], "the reply grew below it");
  await exec("const t=document.querySelector('.timeline'); t.scrollTop = t.scrollHeight;");
  await settle();
  await send(events(REPLY.deltas.slice(200, 320)));
  assert.ok(await atBottom(), "back at the bottom, it follows the reply again");
  await send(events([...REPLY.deltas.slice(320), ...REPLY.done]));
  assert.ok(await atBottom(), "and when it lands");
});

await check("in a long chat, a late result changes its old row in place, a run opened in an old turn stays open, and ↶ on an old message forks from it", async () => {
  // The first edit, and a step of the second turn's run, get their results late, many turns on.
  const t2 = LONG.findIndex((o, i) => o.type === "user" && typeof o.message.content === "string" && i > 1);
  const calls = LONG.slice(t2).filter((o) => o.type === "assistant" && o.message.content[0].type === "tool_use").map((o) => o.message.content[0]);
  const edit = calls.find((c) => c.name === "Edit").id;
  const step = calls.find((c) => c.name === "Bash").id;
  const late = (id) => LONG.find((o) => o.type === "user" && Array.isArray(o.message.content) && o.message.content[0].tool_use_id === id);
  await longChat(LONG.filter((o) => o !== late(edit) && o !== late(step)));
  await send(events(REPLY.deltas.slice(0, 40)));
  // The two still running: the edit's own row, and the run holding the step.
  assert.equal(await exec("const r=[...document.querySelectorAll('.timeline > div > .tool:not(.run)')].filter(t => t.querySelector(':scope > .line .spinner')); r.forEach(t => t.__mark = 1); return r.length"), 1);
  assert.equal(await exec("const r=[...document.querySelectorAll('.timeline > div > .run')].filter(t => t.querySelector(':scope > .line .spinner')); r.forEach(t => t.__mark = 1); return r.length"), 1);
  // The run opened by the owner, before the results come.
  await exec("[...document.querySelectorAll('.timeline > div > .run')].find(r => r.__mark).querySelector(':scope > .line').click()");
  await settle();
  const err = (id, text) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] } });
  await send(events([err(edit, "String to replace not found"), ...REPLY.deltas.slice(40, 80), err(step, "Exit code 2\nno board found")]));
  const rows = await exec(
    "return [...document.querySelectorAll('.timeline > div > .tool')].filter(t => t.__mark).map(t => ({ cls: t.className, spin: !!t.querySelector(':scope > .line .spinner'), st: [...t.querySelectorAll(':scope > .line .st')].map(s => s.textContent).join(' '), open: !!t.querySelector(':scope > .steps') }))",
  );
  assert.equal(rows.length, 2, "the same two rows, changed in place");
  const [editRow, runRow] = rows[0].cls.includes("run") ? [rows[1], rows[0]] : rows;
  assert.deepEqual(editRow, { cls: "tool error", spin: false, st: "error", open: false });
  assert.equal(runRow.spin, false);
  assert.match(runRow.st, /error/);
  assert.equal(runRow.open, true, "the owner's toggle stayed");
  // ↶ on the first turn's message, while the reply still streams.
  await clearPosts();
  await messageMenu("Turn 1:");
  await click(".msg-menu .menu-item", "Fork conversation from here");
  assert.deepEqual((await posts()).filter((p) => p.t === "rewind"), [{ t: "rewind", uuid: LONG[1].uuid, restore: "conversation" }]);
  await send(events(REPLY.deltas.slice(80, 120)));
  assert.equal((await text(".live.cursor")).length, 1, "still streaming");
});

await check("in a long chat, what comes later to an old turn shows there: a Keep result on its reply, the answer in its Questions row, a running step's clock; a compaction's summary in its card; the times over every message; a reload's offer to continue, gone once a process starts (63, 68, 76, 79, 84)", async () => {
  // A question in the second turn, answered late; the first edit still running, its clock from a few seconds ago.
  const t2 = LONG.findIndex((o, i) => o.type === "user" && typeof o.message.content === "string" && i > 1);
  const q = { question: "Which board should the flash go to?", header: "Board", multiSelect: false, options: [{ label: "DK", description: "the dev kit" }, { label: "EVK", description: "the eval kit" }] };
  const ask = { type: "assistant", message: { id: "msg_ask", content: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: { questions: [q] } }] }, timestamp: LONG[t2 + 1].timestamp };
  const editUse = LONG.find((o) => o.type === "assistant" && o.message.content[0].name === "Edit");
  const edit = editUse.message.content[0].id;
  const lines = LONG.filter((o) => !(o.type === "user" && Array.isArray(o.message.content) && o.message.content[0].tool_use_id === edit)).map((o) => (o === editUse ? { ...o, timestamp: new Date(Date.now() - 5000).toISOString() } : o));
  lines.splice(t2 + 2, 0, ask);
  await longChat(lines, { ...OURS, timestamps: true });
  await stubClipboard();
  await send(events(REPLY.deltas.slice(0, 40)));
  const stamps = (await text(".timeline .stamp")).length;
  assert.equal(stamps, 60 + 120, "the owner's 60 messages and Claude's 120 text blocks have their times");
  assert.ok((await text(".day-line")).length >= 1);
  const qLine = () => exec("return [...document.querySelectorAll('.timeline .tool > .line')].find(l => l.querySelector('.name')?.textContent === 'Question').querySelector('.summary').textContent");
  assert.equal(await qLine(), "Asked · 1 question");
  // Keep on the first turn's reply.
  await clearPosts();
  await exec("document.querySelectorAll('.reply-acts')[0].querySelector('.keep button').click()");
  await settle();
  await exec("[...document.querySelectorAll('.reply-acts')[0].querySelectorAll('.keep.open button')].find((b) => b.textContent === 'finding').click()");
  await settle();
  const keep = (await posts()).find((p) => p.t === "keep");
  assert.ok(keep, "Keep asked the host");
  // The running edit's clock, the Keep result and the answer, between deltas.
  const clock = () => exec("return [...document.querySelectorAll('.timeline > div > .tool:not(.run)')].find(t => t.querySelector(':scope > .line .spinner') && t.querySelector(':scope > .line .name').textContent === 'Edit').querySelector('.elapsed').textContent");
  const before = await clock();
  await sleep(1200);
  await send([{ t: "kept", entryId: keep.entryId, kind: "finding" }, ...events(REPLY.deltas.slice(40, 60))]);
  assert.notEqual(await clock(), before, `the old step's clock ticks: ${before}`);
  assert.deepEqual(await text(".kept-line"), ["✓ Kept on the work item as a finding"]);
  const answer = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask", content: `User has answered your questions: "${q.question}"="DK". You can now continue with the user's answers in mind.` }] }, tool_use_result: { answers: { [q.question]: "DK" } } };
  await send(events([answer, ...REPLY.deltas.slice(60, 100)]));
  assert.equal(await qLine(), "Answered · 1 question");
  assert.deepEqual(await text(".qa .qa-opt.picked > span:last-child > div:first-child"), ["DK"], "the row opened to the pick");
  await send(events(REPLY.deltas.slice(100, 140)));
  assert.deepEqual(await text(".kept-line"), ["✓ Kept on the work item as a finding"], "kept through more deltas");
  assert.equal((await text(".timeline .stamp")).length, stamps, "and the times");
  // The reply lands; a compaction's card, then its summary.
  await send(events([...REPLY.deltas.slice(140), ...REPLY.done]));
  await send([{ t: "event", e: { type: "_sent", n: 2, text: "/compact" } }, ...events([{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 120_000 } }])]);
  assert.deepEqual(await text("details.compacted > summary"), ["Compacted chat · manual · 120k tokens freed"]);
  await click("details.compacted > summary");
  await send(events([{ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation. The board is the DK." } }]));
  assert.ok((await text("details.compacted .compact-summary"))[0].includes("The board is the DK."));
  assert.equal(await exec("return document.querySelector('details.compacted').open"), true, "still open");
  // A reload's offer to continue the step (63) goes once a process starts — the owner continued, or went on another way —
  // though its note stays as it was (review r5 N2).
  for (const how of ["continue", "message"]) {
    await send([{ t: "event", e: { type: "_note", text: core.RERUN_OFFER_NOTE, tone: "info", offer: "rerun" } }]);
    assert.equal((await text(".note .offer button")).length, 1, `${how}: offered`);
    if (how === "continue") await click(".note .offer button");
    else await send([sentU(9, "never mind, check the log instead")]);
    await send([{ t: "event", e: { type: "_process", state: "starting" } }, { t: "event", e: { type: "_process", state: "running" } }]);
    assert.equal((await text(".note .offer button")).length, 0, `${how}: the offer went with the process`);
  }
});

await check("a streaming reply is parsed in finished pieces and its last one: it shows as the whole reply does once it lands", async () => {
  const md = [
    "Intro paragraph with `src/main.c` and **bold**.",
    "",
    "- one",
    "",
    "- two, loose",
    "  continued",
    "",
    "  ```c",
    "  int x;",
    "",
    "  int y;",
    "  ```",
    "- three",
    "  - nested",
    "",
    "    more of nested",
    "",
    "After the list.",
    "",
    "1. first",
    "2. second",
    "",
    "```",
    "a fence",
    "",
    "",
    "Not a paragraph: still the fence",
    "- nor a list",
    "```",
    "",
    "~~~",
    "```",
    "",
    "inside tildes",
    "~~~",
    "",
    "> quoted",
    "> more",
    "",
    "> another quote",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "## Heading",
    "",
    "---",
    "",
    "    indented after a blank",
    "",
    "Last paragraph, no newline",
  ].join("\n");
  const id = "msg_pieces";
  const ds = [];
  for (let i = 0, n = 0; i < md.length; i += n) {
    n = 1 + ((i * 7) % 5);
    ds.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: md.slice(i, i + n) } }, parent_tool_use_id: null });
  }
  await fresh();
  await send([sent("pieces"), ...events([{ type: "stream_event", event: { type: "message_start", message: { id } } }, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }])]);
  // Every 40 deltas, and at the end: what streams is what the whole would be, so far.
  const seen = [];
  for (let i = 0; i < ds.length; i += 40) {
    await send(events(ds.slice(i, i + 40)));
    seen.push(await exec("return document.querySelector('.live .md').innerHTML"));
  }
  const live = seen.at(-1);
  await send(events([{ type: "assistant", message: { id, content: [{ type: "text", text: md }] } }, { type: "result", subtype: "success", is_error: false, result: "" }]));
  assert.equal((await text(".live")).length, 0);
  const whole = await exec("const m=[...document.querySelectorAll('.timeline .md')]; return m[m.length-1].innerHTML");
  assert.equal(live, whole);
  assert.ok(whole.includes("<ul>") && whole.includes("<ol") && whole.includes("<table>") && whole.includes("<blockquote>") && whole.includes("<hr>"));
  // A prefix streamed shows as the whole of that prefix would: parsed again in one go, through a snapshot.
  for (let i = 0; i < seen.length - 1; i++) {
    const cut = ds.slice(0, (i + 1) * 40).map((d) => d.event.delta.text).join("");
    await fresh();
    await send([sent("pieces"), ...events([{ type: "assistant", message: { id: `${id}${i}`, content: [{ type: "text", text: cut }] } }])]);
    const prefix = await exec("const m=[...document.querySelectorAll('.timeline .md')]; return m[m.length-1].innerHTML");
    assert.equal(seen[i], prefix, `after ${(i + 1) * 40} deltas`);
  }
});

// ------------------------------------------------------------ what goes into a message (56–60)

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR42mP438MARwzEcQCSIhixoJoR1AAAAABJRU5ErkJggg==";
/**
 * A paste into the input: image files and/or text; true when the page took
 * it over. Firefox drops the data of a ClipboardEvent made by a script, so
 * the event carries a stand-in for VS Code's (Chromium's) clipboardData.
 */
const pasteIn = (spec) =>
  exec(
    `const ta = document.querySelector('.composer textarea'); ta.focus();
     const items = (arguments[0].files || []).map((f) => {
       const bin = atob(f.data); const u = new Uint8Array(bin.length);
       for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
       const file = new File([u], f.name, { type: f.type });
       return { kind: 'file', type: f.type, getAsFile: () => file };
     });
     const text = arguments[0].text;
     if (text !== undefined) items.push({ kind: 'string', type: 'text/plain', getAsFile: () => null });
     const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
     Object.defineProperty(ev, 'clipboardData', { value: { items, getData: (t) => (t === 'text/plain' && text !== undefined ? text : '') } });
     ta.dispatchEvent(ev);
     return ev.defaultPrevented;`,
    [spec],
  );
const sends = async () => (await posts()).filter((p) => p.t === "send");
const waitFor_ = async (pred, ms = 3000) => {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await sleep(50);
  }
};

await check("a pasted screenshot shows as a thumbnail under the input, × takes it off, and an image alone sends (56)", async () => {
  await fresh({}, false);
  assert.equal(await pasteIn({ files: [{ name: "shot.png", type: "image/png", data: PNG }] }), true);
  await sleep(100);
  await settle();
  assert.equal((await exec("return document.querySelectorAll('.composer .attachments .thumb img').length")), 1);
  assert.equal(await value(), "", "no bytes in the draft");
  await shot("paste-image");
  await click(".composer .attachments .thumb .remove");
  await settle();
  assert.equal((await exec("return document.querySelectorAll('.composer .attachments .thumb').length")), 0);
  await pasteIn({ files: [{ name: "shot.png", type: "image/png", data: PNG }] });
  await sleep(100);
  await settle();
  assert.equal(await exec("return document.querySelector('.composer .bar button.primary').disabled"), false, "Send with no text");
  await type(ENTER);
  const [m] = await sends();
  assert.deepEqual([m.text, m.images], ["", [{ mediaType: "image/png", data: PNG }]]);
  assert.equal((await exec("return document.querySelectorAll('.composer .attachments .thumb').length")), 0, "sent: gone from the input");
});

await check("WSL2's clipboard handing a screenshot over as raw bytes pastes nothing (Claude Code's fix), and says so", async () => {
  await fresh({}, false);
  await type("keep this");
  const bytes = "\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\x07\x80" + "\ufffd".repeat(40);
  assert.equal(await pasteIn({ text: bytes }), true);
  await settle();
  assert.equal(await value(), "keep this");
  assert.match((await text(".paste-notice"))[0], /did not come through/);
});

await check("a long paste is marked for the CLI; what shows nothing is stripped from it, with a notice (56)", async () => {
  await fresh({}, false);
  await type("count the lines: ");
  const log = Array.from({ length: 6 }, (_, i) => `line ${i + 1} \u200bok`).join("\n");
  assert.equal(await pasteIn({ text: log }), true, "the page inserts the cleaned text itself");
  await settle();
  const clean = log.replaceAll("\u200b", "");
  assert.equal(await value(), `count the lines: ${clean}`);
  assert.equal((await text(".paste-notice"))[0], "Removed 6 invisible characters from the pasted text");
  await shot("paste-stripped");
  // A short paste is left to the browser and not marked.
  assert.equal(await pasteIn({ text: " thanks" }), false);
  await type(ENTER);
  const [m] = await sends();
  assert.deepEqual(m.pastes, [clean]);
  assert.equal(m.text, `count the lines: ${clean}`);
});

await check("a draft holding invisible characters is cleaned before it goes: the first Enter shows it, the second sends", async () => {
  await fresh({}, false);
  await type("flash\u202e it");
  await type(ENTER);
  assert.equal((await sends()).length, 0, "held for a look");
  assert.equal(await value(), "flash it");
  assert.equal((await text(".paste-notice"))[0], "Removed 1 invisible character · review and press Enter to send");
  await type(ENTER);
  assert.deepEqual((await sends()).map((p) => p.text), ["flash it"]);
});

await check("/btw asks aside while Claude works: the answer shows above the input, never in the timeline (57)", async () => {
  const lines = outLines("btw");
  const running = upTo(lines, (o) => o.type === "assistant" && o.message.content.some((b) => b.type === "tool_use"));
  await fresh({}, false);
  await send([sent("Run the bash command"), ...events(running)]);
  await type("/bt");
  assert.ok((await text(".popup div")).some((t) => t.startsWith("/btw") && t.includes("not part of the conversation")), "offered in the / list");
  await exec("const t=document.querySelector('.composer textarea'); t.value=''; t.dispatchEvent(new Event('input', {bubbles:true}))");
  await type("/btw which command is running?" + ENTER);
  const ps = await posts();
  assert.deepEqual(ps.filter((p) => p.t === "btw").map((p) => p.question), ["which command is running?"]);
  assert.equal(ps.filter((p) => p.t === "send").length, 0, "nothing sent to the conversation");
  assert.equal(await value(), "");
  const timeline = (await text(".timeline"))[0];
  await send(events([{ type: "_side", id: "q:1", question: "which command is running?" }]));
  assert.equal(await exec("return !!document.querySelector('.side .side-q .spinner')"), true, "waiting");
  await send(events([{ type: "_side", id: "q:1", response: "`sleep 8; echo built`" }]));
  assert.equal((await text(".side .side-ask"))[0], "which command is running?");
  assert.ok((await text(".side .side-q"))[0].includes("sleep 8; echo built"));
  assert.equal((await text(".timeline"))[0], timeline, "the timeline is as it was");
  await shot("btw-side");
  await clearPosts();
  await click(".side button", "Clear");
  assert.ok((await posts()).some((p) => p.t === "sideClear"));
  await type("/btw" + ENTER);
  assert.match((await text(".paste-notice"))[0], /takes a question/);
});

await check("the 💬 beside the 📚 puts the input in side-question mode while Claude works: Enter asks aside, Esc or a second click leaves, the draft kept (57)", async () => {
  const ESC = "\uE00C";
  const lines = outLines("btw");
  await fresh({}, false);
  await send([sent("Run the bash command"), ...events(upTo(lines, (o) => o.type === "assistant" && o.message.content.some((b) => b.type === "tool_use")))]);
  const btn = ".composer .assist-slot button.btw";
  assert.deepEqual(await exec(`const b=document.querySelector('${btn}'); return [b.textContent, b.disabled, b.title]`), ["💬", false, "Side question (/btw) — answered beside the chat, not added to it"]);
  const mode = () => exec("return [!!document.querySelector('.composer .aside-tag'), document.querySelector('.composer textarea').classList.contains('aside'), document.querySelector('.composer .bar button.primary').textContent, document.activeElement === document.querySelector('.composer textarea')]");
  await click(btn);
  await settle();
  assert.deepEqual(await mode(), [true, true, "Ask", true], "tagged, Ask, the input focused");
  await type("which port did it pick?");
  await shot("btw-button");
  await type(ENTER);
  let ps = await posts();
  assert.deepEqual(ps.filter((p) => p.t === "btw").map((p) => p.question), ["which port did it pick?"]);
  assert.equal(ps.filter((p) => p.t === "send").length, 0, "nothing to the conversation");
  assert.equal(await value(), "");
  assert.equal((await mode())[0], true, "still in the mode for a follow-up");
  // Esc leaves the mode, draft kept, Claude not stopped; the next Esc stops it as before.
  await type("half a draft");
  await clearPosts();
  await type(ESC);
  assert.deepEqual((await mode()).slice(0, 3), [false, false, "Queue"]);
  assert.equal(await value(), "half a draft");
  assert.ok(!(await posts()).some((p) => p.t === "interrupt"), "leaving the mode is not Stop");
  await type(ESC);
  assert.ok((await posts()).some((p) => p.t === "interrupt"));
  // A second click leaves it too, the draft kept; Enter then queues for the conversation.
  await click(btn);
  await click(btn);
  await settle();
  assert.equal((await mode())[0], false);
  assert.equal(await value(), "half a draft");
  await clearPosts();
  await type(ENTER);
  assert.deepEqual((await sends()).map((p) => p.text), ["half a draft"]);
  assert.ok(!(await posts()).some((p) => p.t === "btw"));
});

await check("a draft held for its cards, then the 💬: the hold is off, the draft stays as the side question, and it goes once, aside (26, 57)", async () => {
  await fresh();
  await send([sentU(1, "first message")]);
  const draft = "please also update the readme with the new flash steps";
  await exec("const t=document.querySelector('.composer textarea'); t.value=arguments[0]; t.dispatchEvent(new Event('input', {bubbles:true}))", [draft]);
  await type(ENTER);
  const checking = () => exec("return document.querySelector('.bulb').classList.contains('checking')");
  assert.equal(await checking(), true, "held for its cards");
  await click(".composer .assist-slot button.btw");
  await settle();
  assert.equal(await checking(), false, "the 💬 ends the hold");
  // Past the hold's 4.5 s: nothing went into the conversation, and the draft waits in side-question mode.
  await sleep(5000);
  await settle();
  assert.deepEqual(await sends(), []);
  assert.equal(await value(), draft);
  assert.equal(await exec("return !!document.querySelector('.composer .aside-tag')"), true);
  await type(ENTER);
  assert.deepEqual((await posts()).filter((p) => p.t === "btw").map((p) => p.question), [draft]);
  assert.deepEqual(await sends(), [], "aside only");
});

await check("the 💬 is off where /btw cannot run: no conversation yet, a chat this window does not run", async () => {
  await fresh({ process: "none" }, false);
  assert.equal(await exec("return document.querySelector('.composer .assist-slot button.btw').disabled"), true, "a new chat before its first message");
  await send([snapshot({ sessionId: "22222222-0000-4000-8000-0000000000fe", timeline: ["x"], entries: { x: { kind: "user", id: "x", text: "hi", images: 0 } } }, { ...OURS, ours: false, resumable: true })]);
  assert.equal(await exec("return document.querySelector('.composer .assist-slot button.btw').disabled"), true, "a chat another window or terminal ran");
});

await check("/btw on a chat this window does not run says it needs the chat here", async () => {
  await fresh({}, false);
  await send([snapshot({ sessionId: "22222222-0000-4000-8000-0000000000ff" }, { ...OURS, ours: false, resumable: true })]);
  await clearPosts();
  await type("/btw anything?" + ENTER);
  assert.equal((await posts()).filter((p) => p.t === "btw").length, 0);
  assert.match((await text(".paste-notice"))[0], /needs a conversation this window runs/);
});

const SEL = { kind: "selection", path: "/work/rec/x/src/main.c", startLine: 10, endLine: 24, text: Array.from({ length: 15 }, (_, i) => `int v${i + 10};`).join("\n") };
const chipText = async () => (await text(".composer .ctx-chip"))[0] ?? null;

await check("the editor's selection shows as a chip under the input and goes with the message once; × keeps it out (60)", async () => {
  await fresh({}, false);
  await send([{ t: "editor", editor: { ...SEL, label: "src/main.c#L10-24" } }]);
  assert.equal(await chipText(), "Selectionsrc/main.c#L10-24×");
  await shot("context-chip");
  await type("what does this do?" + ENTER);
  let [m] = await sends();
  assert.deepEqual(m.editor, SEL, "sent with it, without the chip's words");
  assert.equal(await exec("return document.querySelector('.composer .ctx-chip').classList.contains('sent')"), true, "shown as already sent");
  await clearPosts();
  await type("and this?" + ENTER);
  [m] = await sends();
  assert.equal(m.editor, undefined, "the same selection is not sent again");
  // Another file: the chip comes back; × keeps it out of the next message.
  await send([{ t: "editor", editor: { kind: "file", path: "/work/rec/x/README.md", label: "README.md" } }]);
  assert.equal(await chipText(), "FileREADME.md×");
  await click(".composer .ctx-chip .remove");
  await settle();
  assert.equal(await chipText(), null);
  await clearPosts();
  await type("summarize the repo" + ENTER);
  [m] = await sends();
  assert.equal(m.editor, undefined);
  // A new selection shows again; a slash command goes without it.
  await send([{ t: "editor", editor: { ...SEL, startLine: 1, endLine: 2, text: "a\nb", label: "src/main.c#L1-2" } }]);
  assert.equal(await chipText(), "Selectionsrc/main.c#L1-2×");
  await clearPosts();
  await type("/compact" + ENTER);
  [m] = await sends();
  assert.deepEqual([m.text, m.editor], ["/compact", undefined]);
  await send([{ t: "editor", editor: null }]);
  assert.equal(await chipText(), null);
});

await check("a terminal picked from @ is a chip under the input, not text; its name goes with the message, × takes it off (58)", async () => {
  await fresh({}, false);
  await type("see @term");
  await waitFor_(async () => (await posts()).some((p) => p.t === "mention" && p.q === "term"));
  await send([{ t: "mentions", q: "term", items: [{ insert: "west build", label: "west build", detail: "terminal output", terminal: { name: "west build", index: 0, pid: 4101 } }, { insert: "terminal.c", label: "terminal.c" }] }]);
  assert.equal((await text(".popup div")).length, 2);
  await type(ENTER);
  assert.equal(await value(), "see ", "the @ text goes; nothing inserted");
  assert.equal(await chipText(), "Terminalwest build×");
  // Before it goes, the chip says how it is read: through the clipboard, whose text comes back and nothing else does (review r4 L2).
  const tip = await exec("return document.querySelector('.composer .ctx-chip').title");
  assert.match(tip, /^west build \(pid 4101\): its last 100 lines go with the message/);
  assert.match(tip, /the clipboard is used for a moment, then its text put back — an image or anything else on the clipboard that is not text is lost/);
  await shot("terminal-chip");
  const clear = () => exec("const t=document.querySelector('.composer textarea'); t.value=''; t.dispatchEvent(new Event('input', {bubbles:true}))");
  await clear();
  await clearPosts();
  await type("/compact" + ENTER);
  assert.deepEqual((await sends()).map((p) => [p.text, p.terminals]), [["/compact", undefined]]);
  assert.equal(await chipText(), "Terminalwest build×", "a slash command leaves it for the next message");
  await clearPosts();
  await type("why does it fail?" + ENTER);
  const [m] = await sends();
  assert.deepEqual([m.text, m.terminals], ["why does it fail?", [{ name: "west build", index: 0, pid: 4101 }]], "the terminal the list offered, by its process");
  assert.equal(await chipText(), null, "sent: gone");
  // × takes one off.
  await type("@term");
  await send([{ t: "mentions", q: "term", items: [{ insert: "minicom", label: "minicom", detail: "terminal output", terminal: { name: "minicom", index: 1 } }] }]);
  await type(ENTER);
  await click(".composer .ctx-chip .remove");
  await settle();
  assert.equal(await chipText(), null);
  // The host gives focus back after reading a terminal.
  await exec("document.activeElement && document.activeElement.blur()");
  await send([{ t: "focus" }]);
  assert.equal(await exec("return document.activeElement === document.querySelector('.composer textarea')"), true);
});

await check("the page's own commands leave what waits to go: a screenshot, the selection and a terminal stay for the next message (56, 58, 60)", async () => {
  await fresh({}, false);
  await pasteIn({ files: [{ name: "shot.png", type: "image/png", data: PNG }] });
  await waitFor_(async () => (await exec("return document.querySelectorAll('.composer .thumb').length")) === 1);
  await send([{ t: "editor", editor: { ...SEL, label: "src/main.c#L10-24" } }]);
  await type("@term");
  await send([{ t: "mentions", q: "term", items: [{ insert: "west build", label: "west build", detail: "terminal output", terminal: { name: "west build", index: 0, pid: 4101 } }] }]);
  await type(ENTER);
  for (const cmd of ["/copy", "/mcp"]) {
    await type(`${cmd} ${ENTER}`);
    assert.equal(await value(), "", `${cmd}: the draft clears`);
    assert.equal(await exec("return document.querySelectorAll('.composer .thumb').length"), 1, `${cmd} keeps the screenshot`);
    assert.equal((await text(".composer .ctx-chip")).length, 2, `${cmd} keeps the selection and the terminal`);
    await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await settle();
  }
  assert.deepEqual(await sends(), [], "nothing went to Claude");
  await type("why does this trace ring" + ENTER);
  const [s] = await sends();
  assert.deepEqual([s.text, s.images?.length, s.terminals, s.editor?.path], ["why does this trace ring", 1, [{ name: "west build", index: 0, pid: 4101 }], SEL.path], "all of it goes with the message");
});

await check("Alt+Shift+K's @-mention lands at the caret, spaced from the word before, and the input takes focus (59)", async () => {
  await fresh({}, false);
  await send([{ t: "insert", text: "@src/main.c#L10-24 " }]);
  assert.equal(await value(), "@src/main.c#L10-24 ", "an input never used: at the end");
  assert.equal(await exec("return document.activeElement === document.querySelector('.composer textarea')"), true);
  await type("why is this");
  await exec("const t=document.querySelector('.composer textarea'); t.setSelectionRange(3, 3)");
  await send([{ t: "insert", text: "@README.md " }]);
  assert.equal(await value(), "@sr @README.md c/main.c#L10-24 why is this", "at the caret");
  await exec("const t=document.querySelector('.composer textarea'); t.value=''; t.dispatchEvent(new Event('input', {bubbles:true}))");
  await type("look at");
  await send([{ t: "insert", text: "@a.c " }]);
  assert.equal(await value(), "look at @a.c ");
});

await check("Ctrl+Alt+Esc's mention of the selected lines is skipped when the editor chip carries the same lines: they go once (59, 60)", async () => {
  await fresh({}, false);
  const unlessChip = { path: SEL.path, startLine: 10, endLine: 24 };
  await send([{ t: "editor", editor: { ...SEL, label: "src/main.c#L10-24" } }]);
  await send([{ t: "insert", text: "@src/main.c#L10-24 ", unlessChip }]);
  assert.equal(await value(), "", "the chip wins");
  assert.equal(await chipText(), "Selectionsrc/main.c#L10-24×");
  assert.equal(await exec("return document.activeElement === document.querySelector('.composer textarea')"), true, "the input still takes focus");
  // Other lines than the chip's: the mention goes in.
  await send([{ t: "insert", text: "@src/main.c#L1-2 ", unlessChip: { ...unlessChip, startLine: 1, endLine: 2 } }]);
  assert.equal(await value(), "@src/main.c#L1-2 ");
  // The chip taken off with its ×: the key brings the lines as a mention.
  await exec("const t=document.querySelector('.composer textarea'); t.value=''; t.dispatchEvent(new Event('input', {bubbles:true}))");
  await click(".composer .ctx-chip .remove");
  await settle();
  await send([{ t: "insert", text: "@src/main.c#L10-24 ", unlessChip }]);
  assert.equal(await value(), "@src/main.c#L10-24 ");
  await send([{ t: "editor", editor: null }]);
});

await check("what went with a message shows as rows under it: a selection and a terminal open to their text, the file opens in the editor (58, 60)", async () => {
  await fresh({}, false);
  const context = [SEL, { kind: "file", path: "/work/rec/x/README.md" }, { kind: "terminal", name: "west build", text: "[1/2] Building C object\nerror: 'x' undeclared" }];
  await send(events([{ type: "_sent", n: 1, text: "why does it fail?", images: 0, context }]));
  assert.deepEqual(await text(".user .ctx-row > summary, .user div.ctx-row"), ["Selectionsrc/main.c#L10-24 · 15 lines", "Open fileREADME.md", "Terminalwest build · 2 lines"]);
  await exec("for (const d of document.querySelectorAll('.user details.ctx-row')) d.open = true;");
  await settle();
  assert.ok((await text(".user .ctx-row pre"))[1].includes("error: 'x' undeclared"));
  await shot("context-rows");
  await clearPosts();
  await click(".user details.ctx-row a", "Open in the editor");
  await click(".user div.ctx-row a", "README.md");
  const opens = (await posts()).filter((p) => p.t === "openFile");
  assert.deepEqual(opens, [{ t: "openFile", path: SEL.path, line: 10 }, { t: "openFile", path: "/work/rec/x/README.md" }]);
});

// ------------------------------------------------------------ with the rest of the input (55, 72, 73)

await check("Esc in side-question mode leaves the mode, and never counts toward Esc twice's rewind (57, 73)", async () => {
  await basicChat();
  await click(".composer .assist-slot button.btw");
  await settle();
  await type(ESC + ESC);
  assert.equal(await exec("return !!document.querySelector('.composer .aside-tag')"), false, "the first Esc left the mode");
  assert.equal((await text(".dialog.rewind")).length, 0, "and the pair opened no rewind");
  await sleep(700);
  await type(ESC + ESC);
  assert.equal((await text(".dialog.rewind")).length, 1, "out of the mode, Esc twice is the rewind again");
  await click(".dialog.rewind button", "Close");
});

await check("/btw, /rewind, /copy and /export are all in the / list", async () => {
  await fresh({ slashCommands: ["compact"] }, false);
  await type("/");
  const items = await text(".popup div");
  for (const c of ["/rewind", "/copy", "/export", "/btw"]) assert.ok(items.some((t) => t.startsWith(c)), `${c} in ${items.join(" | ")}`);
});

await check("above the input at once — a held card, side questions, a queued message with what goes with it, side-question mode, the chips — each in its own place", async () => {
  await fresh({}, false);
  await send([sent("tea or coffee"), ...events(askLines.slice(0, askAt))]);
  // Sent while Claude works: it waits above the input (72), with the editor's selection.
  await send(events([{ type: "_sent", n: 2, text: "Also end your reply with the word: kiwi", images: 0, context: [SEL] }]));
  await send(events([
    { type: "_side", id: "q:1", question: "which port did it pick?" },
    { type: "_side", id: "q:1", response: "`/dev/ttyACM0`, the first one it found." },
  ]));
  await send([{ t: "editor", editor: { ...SEL, label: "src/main.c#L10-24" } }]);
  await pasteIn({ files: [{ name: "shot.png", type: "image/png", data: PNG }] });
  await type("@term");
  await send([{ t: "mentions", q: "term", items: [{ insert: "west build", label: "west build", detail: "terminal output", terminal: { name: "west build", index: 0, pid: 4101 } }] }]);
  await type(ENTER);
  await click(".composer .assist-slot button.btw");
  // Typing when the card comes: it waits as one quiet line (55).
  await type("and the baud");
  await send(events([askLines[askAt]]));
  const box = await exec(`return ['.card.held', '.side', '.queue', '.composer .aside-tag', '.composer textarea', '.composer .attachments', '.composer .bar']
    .map((s) => { const e = document.querySelector(s); if (!e) return [s, null]; const r = e.getBoundingClientRect(); return [s, Math.round(r.top), Math.round(r.bottom)]; });`);
  await shot("above-input-all");
  for (const [sel, top] of box) assert.notEqual(top, null, `${sel} on screen`);
  for (let i = 1; i < box.length; i++) assert.ok(box[i][1] >= box[i - 1][2] - 1, `${box[i][0]} below ${box[i - 1][0]}: ${JSON.stringify(box)}`);
  assert.match((await text(".queue .queued-with"))[0], /^with lines 10–24 of main\.c$/);
  assert.equal((await text(".composer .ctx-chip")).length, 2, "the selection and the terminal");
  assert.equal(await exec("return document.querySelectorAll('.composer .attachments .thumb').length"), 1);
});

await check("a 300 px sidebar with everything above the input: the side answers, the background tasks and the queue give way to a line each before the timeline goes under a quarter of the panel; the card stays answerable, Send at the right (50, 55)", async () => {
  // Headless Firefox keeps its window 500 px wide or more: the page is made 300 px instead.
  await exec("document.getElementById('app').style.width = '300px'");
  try {
    await fresh({ model: "opus", effort: "xhigh", ultracode: true, mcp: [{ name: "embarch-api", status: "failed", error: "MCP error -32000: Connection closed" }], remote: { status: "connected", url: "https://claude.ai/code/session_x" }, capabilities: ["interrupt_send_now_v1"] }, false);
    const lines = allowed("bgstop");
    await send([sentU(1, "count the ticks"), ...events(lines.slice(0, lines.findIndex(isResultLine) + 1)), limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86, resetsAt: inH(50) })]);
    await send([sentU(2, "now flash the dev bench with the new build and run the study"), toolCall("tf9", "mcp__embarch-api__flash", { project: "demo" })]);
    await send([sentU(3, "use the other board instead")]);
    await send(events([{ type: "_side", id: "q:1", question: "which port did it pick?" }, { type: "_side", id: "q:1", response: "`/dev/ttyACM0`, the first one it found." }]));
    await send([{ t: "editor", editor: { ...SEL, label: "src/main.c#L10-24" } }]);
    await click(".bg-toggle");
    await settle();
    await send([taskOut(lines.find(isTaskStarted).task_id, "tick 1\ntick 2\ntick 3\n")]);
    await pasteIn({ files: [{ name: "shot.png", type: "image/png", data: PNG }] });
    await type("@term");
    await send([{ t: "mentions", q: "term", items: [{ insert: "west build", label: "west build", detail: "terminal output", terminal: { name: "west build", index: 0, pid: 4101 } }] }]);
    await type(ENTER);
    await type("and the baud rate");
    // A permission card on top of it all, forward once the typing pauses (55).
    await send(events(upTo(outLines("deny"), (o) => o.type === "control_request").filter((o) => o.type === "control_request")));
    await sleep(1700);
    await settle();
    const m = await exec(`const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, right: b.right, h: b.height }; };
      return { vh: window.innerHeight, timeline: r('.timeline'), cards: r('.cards'), allow: r('.card .actions button.primary'), side: r('.side'), bg: r('.bg-tasks'), queue: r('.queue'), composer: r('.composer'), bar: r('.composer .bar'), primary: r('.composer .bar button.primary') };`);
    await shot("narrow-everything");
    assert.ok(m.timeline.h >= m.vh / 4 - 1, `the timeline keeps a quarter of the panel: ${JSON.stringify(m.timeline)} of ${m.vh}`);
    assert.ok(m.allow.top >= m.cards.top && m.allow.bottom <= m.cards.bottom, `the card's Allow on screen: ${JSON.stringify([m.allow, m.cards])}`);
    for (const k of ["side", "bg", "queue"]) assert.ok(m[k].h >= 24, `${k} keeps a line: ${JSON.stringify(m[k])}`);
    assert.ok(m.composer.bottom <= m.vh + 1, "the input on screen");
    assert.ok(m.bar.right - m.primary.right <= 1, `Queue at the bar's right: ${JSON.stringify([m.primary, m.bar])}`);
  } finally {
    await exec("document.getElementById('app').style.width = ''");
  }
});

// A short panel — a sidebar split with the Explorer, the chat dragged into the bottom panel — with all of that on screen:
// the input and Send stay on screen, then the card's Allow and Deny, then the timeline's floor (55, 50; review r5 N1).
// The command Allow answers shows above them where the panel has room for it, ahead of the timeline (review r6 L2).
// Every other kind of card, each in its place, keeps its buttons on screen too: a dialog card scrolls in no box of its own (review r6 M1).
// A card held while the owner types keeps its line (review r6 L2).
// Window heights 520, 420, 340 and 324 are pages 446, 346, 266 and 250 px tall.
const cardOf = (name) => upTo(outLines(name), (o) => o.type === "control_request").filter((o) => o.type === "control_request");
const OTHER_CARDS = [
  ["a question", events(cardOf("question"))],
  ["a plan", events(cardOf("plan"))],
  ["auto mode's notice", [cliAsks("r-auto-short", AUTO)]],
  ["a flagged message", [cliAsks("r-refusal-short", REFUSAL)]],
  ["an MCP server's form", events(elicitUpTo.filter((o) => o.type === "control_request"))],
];
for (const h of [520, 420, 340, 324]) {
  await check(`a ${h} px tall window with everything above the input and a card: the input and Send on screen, then the card's Allow and Deny, then what they answer, then some of the timeline; each kind of card's buttons on screen; a held card's line (50, 55; review r5 N1, r6 M1, L2)`, async () => {
    await wd("POST", `${S}/window/rect`, { width: 460, height: h });
    try {
      await fresh({ model: "opus", effort: "xhigh", ultracode: true, mcp: [{ name: "embarch-api", status: "failed", error: "MCP error -32000: Connection closed" }], remote: { status: "connected", url: "https://claude.ai/code/session_x" }, capabilities: ["interrupt_send_now_v1"] }, false);
      const lines = allowed("bgstop");
      await send([sentU(1, "count the ticks"), ...events(lines.slice(0, lines.findIndex(isResultLine) + 1)), limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86, resetsAt: inH(50) })]);
      await send([sentU(2, "now flash the dev bench with the new build and run the study"), toolCall("tf9", "mcp__embarch-api__flash", { project: "demo" })]);
      await send([sentU(3, "use the other board instead")]);
      await send(events([{ type: "_side", id: "q:1", question: "which port did it pick?" }, { type: "_side", id: "q:1", response: "`/dev/ttyACM0`, the first one it found." }]));
      await send([{ t: "editor", editor: { ...SEL, label: "src/main.c#L10-24" } }]);
      await click(".bg-toggle");
      await settle();
      await send([taskOut(lines.find(isTaskStarted).task_id, "tick 1\ntick 2\ntick 3\n")]);
      await pasteIn({ files: [{ name: "shot.png", type: "image/png", data: PNG }] });
      await type("and the baud rate");
      await send(events(upTo(outLines("deny"), (o) => o.type === "control_request").filter((o) => o.type === "control_request")));
      await sleep(1700);
      await settle();
      const m = await exec(`const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
        const at = (re) => { const b = [...document.querySelectorAll('.card .actions button')].find((x) => re.test(x.textContent)); if (!b) return null; const q = b.getBoundingClientRect(); return { top: Math.round(q.top), bottom: Math.round(q.bottom) }; };
        const send = [...document.querySelectorAll('.composer .bar button')].find((b) => /Send|Queue/.test(b.textContent)).getBoundingClientRect();
        // What the owner reads of the card: not under its sticky buttons, nor out of the cards' box or the box that clips it.
        const box = document.querySelector('.cards').getBoundingClientRect(), bar = document.querySelector('.card .actions').getBoundingClientRect(), mid = document.querySelector('.middle').getBoundingClientRect();
        const seen = (s) => { const e = document.querySelector(s); if (!e) return false; const q = e.getBoundingClientRect(); return q.top >= box.top - 1 && q.bottom <= Math.min(box.bottom, bar.top, mid.bottom) + 1; };
        return { vh: window.innerHeight, timeline: r('.timeline'), cards: r('.cards'), middle: r('.middle'), allow: at(/^Allow$/), deny: at(/^Deny$/), composer: r('.composer'), textarea: r('.composer textarea'), send: Math.round(send.bottom), title: seen('.card .card-title'), command: seen('.card .md code') };`);
      await shot(`short-${h}-everything`);
      assert.ok(m.composer.bottom <= m.vh + 1 && m.send <= m.vh + 1, `the input and Send on screen: ${JSON.stringify(m)}`);
      for (const k of ["allow", "deny"]) assert.ok(m[k] && m[k].top >= m.cards.top - 1 && m[k].bottom <= Math.min(m.cards.bottom, m.middle.bottom) + 1 && m[k].bottom <= m.vh, `the card's ${k} on screen: ${JSON.stringify(m)}`);
      // At 266 and 250 px the input and the layers above it leave the card 66 and 50 px: its buttons, and not what they answer.
      if (h >= 420) assert.ok(m.title && m.command, `the card's title and command above Allow: ${JSON.stringify(m)}`);
      if (h >= 520) assert.ok(m.timeline.h >= 40, `some of the timeline: ${JSON.stringify(m)}`);
      let was = cardOf("deny")[0].request_id;
      for (const [kind, ask] of OTHER_CARDS) {
        await send([{ t: "event", e: { type: "_answered", requestId: was, behavior: "allow" } }, ...ask]);
        was = ask.at(-1).e.request_id;
        await settle();
        // At 250 px a row of buttons is what the card has room for: the first, with the card's primary answer.
        const b = await exec(`const box = document.querySelector('.cards').getBoundingClientRect(), end = Math.min(box.bottom, document.querySelector('.middle').getBoundingClientRect().bottom, window.innerHeight);
          return [...document.querySelectorAll('.cards .card .actions button' + (arguments[0] ? '.primary' : ''))].map((x) => { const q = x.getBoundingClientRect(); return [x.textContent.trim(), q.top >= box.top - 1 && q.bottom <= end + 1]; });`, [h < 340]);
        await shot(`short-${h}-${kind.replace(/\W+/g, "-")}`);
        assert.ok(b.length && b.every(([, seen]) => seen), `${kind}: its buttons on screen: ${JSON.stringify(b)}`);
      }
      await type(" and parity");
      await send([{ t: "event", e: { type: "_answered", requestId: was, behavior: "allow" } }, ...events(cardOf("deny"))]);
      const held = await exec(`const box = document.querySelector('.cards').getBoundingClientRect(), q = document.querySelector('.card.held').getBoundingClientRect();
        return [Math.round(box.top), Math.round(Math.min(box.bottom, document.querySelector('.middle').getBoundingClientRect().bottom)), Math.round(q.top), Math.round(q.bottom)];`);
      assert.ok(held[2] >= held[0] - 1 && held[3] <= held[1] + 1, `the held card's line on screen: ${JSON.stringify(held)}`);
    } finally {
      await wd("POST", `${S}/window/rect`, { width: 460, height: 900 });
      await settle();
    }
  });
}

await check("a card comes forward tinted, its sticky buttons with it: no band of the resting colour across it (55; review r6 nit)", async () => {
  await fresh({}, false);
  await send([sent("touch it"), ...events(cardOf("deny"))]);
  const [card, bar] = await exec("const c = document.querySelector('.card'); return [getComputedStyle(c).backgroundColor, getComputedStyle(c.querySelector('.actions')).backgroundColor]");
  assert.equal(bar, card);
});

await check("the MCP pill: each server with Claude Code's mark and words, a ✗ when one failed, Reconnect and Disable on this chat's process; /mcp opens it (its changelog L6014)", async () => {
  // The servers as the recording's mcp_status answered, and one whose rebuilt binary did not start.
  const answer = outLines("mcp").find((o) => o.type === "control_response" && o.response.response?.mcpServers).response.response.mcpServers;
  const servers = [...answer, { name: "embarch-api", status: "failed", error: "MCP error -32000: Connection closed", source: "dynamic" }];
  await send([snapshot(), sent("ok"), ...events(outLines("mcp").filter((o) => o.type === "system" && o.subtype === "init"))]);
  assert.deepEqual(await text(".composer .pill.mcp"), ["MCP"], "every server connected: no mark");
  await send([{ t: "event", e: { type: "_mcp", servers } }]);
  assert.deepEqual(await text(".composer .pill.mcp"), ["MCP ✗1"]);
  await clearPosts();
  await click(".composer .pill.mcp");
  await settle();
  assert.ok((await posts()).some((p) => p.t === "mcpStatus"), "opening asks the CLI afresh");
  const rows = await exec("return [...document.querySelectorAll('.mcp-pop .mcp-row')].map((r) => [r.querySelector('.st').textContent, r.querySelector('.name').textContent, r.querySelector('.st-label').textContent, [...r.querySelectorAll('button')].map((b) => b.textContent)])");
  assert.deepEqual(rows, [
    ["✓", "bench", "Connected", ["Reconnect", "Disable"]],
    ["✓", "embarch-chat", "this window's", []],
    ["✗", "embarch-api", "Failed", ["Reconnect", "Disable"]],
  ]);
  assert.deepEqual(await text(".mcp-pop .mcp-err"), ["MCP error -32000: Connection closed"]);
  await shot("mcp-pop");
  await clearPosts();
  await click(".mcp-pop .mcp-row.failed button", "Reconnect");
  await settle();
  assert.deepEqual((await posts()).filter((p) => p.t === "mcp"), [{ t: "mcp", name: "embarch-api", action: "reconnect" }]);
  assert.deepEqual(await text(".mcp-pop .mcp-row.failed button"), ["Reconnecting…", "Disable"], "under way until the list comes back");
  await send([{ t: "event", e: { type: "_mcp", servers: [...answer, { name: "embarch-api", status: "connected", source: "dynamic" }] } }]);
  assert.deepEqual(await text(".composer .pill.mcp"), ["MCP"]);
  await clearPosts();
  await click(".mcp-pop .mcp-row button", "Disable");
  await settle();
  assert.deepEqual((await posts()).filter((p) => p.t === "mcp"), [{ t: "mcp", name: "bench", action: "disable" }]);
  await send([{ t: "event", e: { type: "_mcp", servers: servers.map((x) => (x.name === "bench" ? { ...x, status: "disabled" } : x)) } }]);
  assert.deepEqual(await exec("return [...document.querySelector('.mcp-pop .mcp-row').querySelectorAll('button')].map((b) => b.textContent)"), ["Enable"]);
  // Escape closes it; the CLI's /mcp, typed, opens it again.
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await settle();
  assert.equal((await text(".mcp-pop")).length, 0);
  await clearPosts();
  // An earlier check's draft is this chat's too: from an empty input.
  await exec("const t = document.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true }))");
  await type("/mcp " + ENTER);
  assert.equal((await text(".mcp-pop")).length, 1);
  assert.ok(!(await posts()).some((p) => p.t === "send"), "the page answers it; nothing goes to Claude");
  assert.equal(await value(), "", "the draft clears");
  // A closed process: the list as last known, nothing to act on.
  await send([{ t: "event", e: { type: "_process", state: "closed" } }]);
  assert.equal(await exec("return document.querySelectorAll('.mcp-pop button').length"), 0);
  assert.ok((await text(".mcp-pop .pop-note"))[0].includes("next message starts every server afresh"));
  // A chat read-only here has no pill.
  await send([snapshot({}, { ...OURS, ours: false, readOnly: false, resumable: true })]);
  assert.equal((await text(".composer .pill.mcp")).length, 0);
});

await check("Esc that closes the MCP or the model panel does only that: the turn runs on, and it is not the first of Esc twice (73, 81)", async () => {
  await fresh({ mcp: [{ name: "embarch-api", status: "failed", error: "MCP error -32000: Connection closed" }] }, false);
  await send([sentU(1, "flash it"), toolCall("tf1", "mcp__embarch-api__flash", { project: "demo" })]);
  await type("/mcp " + ENTER);
  assert.equal((await text(".mcp-pop")).length, 1);
  assert.equal(await focused(), "TEXTAREA", "the input keeps the keys");
  await clearPosts();
  await keys(ESC);
  assert.equal((await text(".mcp-pop")).length, 0, "Esc closed the panel");
  assert.ok(!(await posts()).some((p) => p.t === "interrupt"), "and did not stop the turn");
  await keys(ESC);
  assert.ok((await posts()).some((p) => p.t === "interrupt"), "the next Esc is Stop's");
  // Idle, the input empty: the Esc that closes the model panel opens no rewind with the next.
  await basicChat();
  await click(".composer .pill.model");
  await settle();
  await keys(ESC);
  assert.equal((await text(".model-pop")).length, 0);
  await keys(ESC);
  assert.equal((await text(".dialog.rewind")).length, 0);
});

await check("the model pill by keyboard: Enter opens it, Tab reaches each model and Enter picks one, the keys back on the pill; the levels are radios (82)", async () => {
  await fresh({}, false);
  await exec("document.querySelector('.composer .pill.model').focus(); return true");
  await keys(ENTER);
  assert.equal((await text(".model-pop")).length, 1);
  const rows = await exec("return [...document.querySelectorAll('.model-pop [role=menuitemradio]')].map((r) => [r.tagName, r.textContent, r.getAttribute('aria-checked')])");
  assert.deepEqual(rows, [
    ["BUTTON", "Default model", "true"],
    ["BUTTON", "Opus", "false"],
    ["BUTTON", "Sonnet", "false"],
    ["BUTTON", "Haiku", "false"],
  ]);
  const levels = await exec("return [...document.querySelectorAll('.model-pop .effort-row button')].map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked')])");
  assert.ok(levels.length > 1 && levels.every(([role]) => role === "radio"), JSON.stringify(levels));
  assert.equal(levels.filter(([, on]) => on === "true").length, 1, "one level checked");
  await clearPosts();
  await keys(TAB + TAB);
  assert.equal(await exec("return document.activeElement.textContent"), "Opus");
  await keys(ENTER);
  assert.deepEqual((await posts()).filter((p) => p.t === "model"), [{ t: "model", model: "opus" }]);
  assert.equal((await text(".model-pop")).length, 0);
  assert.equal(await focused(), "BUTTON.pill.model");
});

// ------------------------------------------------------------ the rail and Promptu (decisions 94–98)

const PATTERNS = [
  { name: "debug-failure", version: 1, summary: "Investigate a failure whose cause is not known yet." },
  { name: "handoff", version: 1, summary: "Have this session write a self-contained brief." },
  { name: "implement-issue", version: 1, summary: "Build a feature or a change from an issue or an idea." },
];
const PSTATE = (over = {}) => ({ t: "promptuState", state: { available: true, enabled: true, quick: false, patterns: PATTERNS, why: null, ...over } });
const PROMPTU_OFF = { t: "promptuState", state: { available: false, enabled: true, quick: false, patterns: [], why: "promptu is not installed here: put it on PATH, or set embarchChat.promptuPath" } };
const isLit = () => exec("return document.querySelector('.rail .rail-entry.promptu').classList.contains('lit')");
const setDraft = (t) => exec("const e=document.querySelector('.composer textarea'); e.value=arguments[0]; e.dispatchEvent(new Event('input', {bubbles:true}))", [t]);
const Q_DONE = {
  question: "What does done look like, and how is it checked?",
  header: "Done when",
  multiSelect: false,
  options: [
    { label: "Build and tests pass (Recommended)", description: "Show the commands and their output." },
    { label: "I'll judge it", description: "Stop when you think it's done." },
  ],
};
const Q_GOAL = { question: "Why are we doing this, and for whom? One line.", header: "Goal", multiSelect: false, options: [{ label: "Leave it out", description: "Nothing about this goes into the prompt." }, { label: "Not sure", description: "The prompt says it is not known yet." }] };
/** Five words or fewer: a send of it is never held for the cards (26). */
const ROUGH = "add a loader watchdog";
const pView = (sid, seq, over = {}, step = {}) => ({
  t: "promptu",
  sid,
  view: {
    sid,
    seq,
    origin: "enter",
    rough: ROUGH,
    phase: "ask",
    quick: false,
    step: {
      promptu: 1,
      run: "20261030-120000-abcd",
      pattern: { id: "implement-issue", version: 1, picked_by: "model", confidence: 0.84, alt: [] },
      offline: false,
      offline_reason: null,
      filled: [{ q: "read", header: "Read first", value: "The issue and its PR", source: "desk", evidence: "read the issue and its PR" }],
      defaults: [{ q: "heavy", header: "How heavy", value: "Smallest that works" }],
      choose: null,
      pages: [{ ids: ["done", "goal"], questions: [Q_DONE, Q_GOAL] }],
      done: false,
      ...step,
    },
    ...over,
  },
});
const ctrlEnter = async () => {
  await wd("POST", `${S}/actions`, { actions: [{ type: "key", id: "kb", actions: [{ type: "keyDown", value: "" }, { type: "keyDown", value: "" }, { type: "keyUp", value: "" }, { type: "keyUp", value: "" }] }] });
  await wd("DELETE", `${S}/actions`);
  await settle();
};
const ESC_KEY = "";
const promptuPosts = async (op) => (await posts()).filter((p) => p.t === "promptu" && (!op || p.op === op));

await check("the rail: Memory, Promptu, the 📚 and the 💡 down the chat's left edge, folded to their icons until the pointer is on it, which shows their names over the timeline without moving it; the 💡 and 📚 left the input's bar (94)", async () => {
  await fresh();
  assert.deepEqual(await text(".rail .rail-entry .rail-label"), ["Memory", "Promptu", "Library", "Suggestions"]);
  assert.deepEqual(await exec("const r=document.querySelector('.rail'); return [r.getAttribute('role'), r.getAttribute('aria-label'), r.getAttribute('aria-orientation')]"), ["toolbar", "Chat tools", "vertical"], "named, a toolbar (review F9)");
  await exec("document.querySelector('.rail .rail-entry.memory').focus()");
  await keys("\uE015");
  assert.equal(await exec("return document.activeElement.classList.contains('promptu')"), true, "↓ moves to the next entry");
  assert.deepEqual(await text(".composer .bar .bulb, .composer .bar .library"), [], "not in the bar any more");
  assert.deepEqual(await text(".composer .bar .btw"), ["💬"], "the side question stays by the input");
  const width = () => exec("return Math.round(document.querySelector('.rail-col').getBoundingClientRect().width)");
  const shown = () => exec("return getComputedStyle(document.querySelector('.rail .rail-label')).opacity");
  assert.equal(await width(), 30);
  assert.equal(await shown(), "0");
  const timeline = await rect(".timeline");
  await hover(".rail .rail-entry.memory");
  await sleep(200);
  assert.equal(await width(), 140, "unfolded");
  assert.equal(await shown(), "1");
  assert.deepEqual(await rect(".timeline"), timeline, "the timeline never moves");
  await shot("rail-unfolded");
  await mouseAway();
  await sleep(200);
  assert.equal(await width(), 30);
  // A read-only chat has no input, so no rail.
  await send([snapshot({}, { ...OURS, ours: false, readOnly: true })]);
  assert.equal((await text(".rail")).length, 0);
});

await check("Promptu's icon lights when the next Enter runs the pass: at a task start with Promptu on, never for a command or a reply inside a task; a pattern forced on its card lights it for the next prompt (95)", async () => {
  try {
    await fresh();
    await send([PSTATE()]);
    assert.equal(await isLit(), false, "nothing to run it on");
    await type("add a watchdog");
    assert.equal(await isLit(), true, "a task start");
    const aria = () => exec("const b=document.querySelector('.rail .rail-entry.promptu'); return [b.getAttribute('aria-label'), b.getAttribute('aria-pressed'), b.getAttribute('aria-haspopup')]");
    assert.deepEqual(await aria(), ["Promptu — runs on next Enter", null, "dialog"], "an indicator: its name says it, no pressed state (review F8)");
    await setDraft("/compact the build");
    await settle();
    assert.equal(await isLit(), false, "a command goes as it is");
    assert.deepEqual((await aria()).slice(0, 2), ["Promptu", null]);
    await setDraft("## Goal\nx\n\n— promptu implement-issue@1 asked=done:rec");
    await settle();
    assert.equal(await isLit(), false, "a draft that went through it already");
    await send([PROMPTU_OFF]);
    await setDraft("add a watchdog");
    await settle();
    assert.equal(await isLit(), false, "not installed");
    await send([PSTATE({ enabled: false })]);
    assert.equal(await isLit(), false, "off");
    // A reply inside a running task never.
    await fresh();
    await send([PSTATE(), sent("first"), { t: "event", e: { type: "user", message: { role: "user", content: [{ type: "text", text: "first" }] }, parent_tool_use_id: null } }]);
    await type("and now the tests");
    assert.equal(await isLit(), false, "a reply");
    // The card: hover opens it, a forced pattern lights the icon for the next prompt.
    await exec("document.querySelector('.composer textarea').focus()");
    await hover(".rail .rail-entry.promptu");
    assert.equal((await text(".promptu-card")).length, 1, "hover opens the card");
    assert.equal(await focused(), "TEXTAREA", "a hover never takes the focus from the draft (review F10)");
    const card = (await text(".promptu-card"))[0];
    assert.ok(card.includes("Promptu on") && card.includes("Quick mode") && card.includes("Pattern for the next prompt"), card);
    assert.deepEqual(await text(".promptu-card select option"), ["Auto — Promptu picks", "debug-failure", "handoff", "implement-issue"]);
    await shot("promptu-card");
    await exec("const s=document.querySelector('.promptu-card select'); s.value='debug-failure'; s.dispatchEvent(new Event('change', {bubbles:true}))");
    await settle();
    assert.equal(await isLit(), true, "forced for the next prompt, mid-task too");
    await clearPosts();
    await exec("document.querySelectorAll('.promptu-card input[type=checkbox]')[1].click()");
    await exec("document.querySelectorAll('.promptu-card input[type=checkbox]')[0].click()");
    await settle();
    assert.deepEqual((await posts()).filter((p) => p.t === "promptuSettings"), [{ t: "promptuSettings", quick: true }, { t: "promptuSettings", enabled: false }]);
    await mouseAway();
    await sleep(500);
    assert.equal((await text(".promptu-card")).length, 0, "it closes when the pointer leaves");
    // By the keys: Enter on the icon opens the card with the focus in it; the pointer leaving keeps it; Esc gives the focus back.
    await exec("document.querySelector('.rail .rail-entry.promptu').focus()");
    await keys("\uE007");
    assert.equal(await exec("return !!document.activeElement.closest('.promptu-card')"), true, "the focus is in the card");
    await mouseAway();
    await sleep(500);
    assert.equal((await text(".promptu-card")).length, 1, "opened by the keys, it stays");
    await keys(ESC_KEY);
    assert.equal((await text(".promptu-card")).length, 0);
    assert.equal(await exec("return document.activeElement.classList.contains('promptu')"), true, "back on the icon");
    await exec("document.querySelector('.composer textarea').focus()");
    await clearPosts();
    await type(ENTER);
    const prep = await promptuPosts("prep");
    assert.deepEqual(prep, [{ t: "promptu", op: "prep", text: "and now the tests", pattern: "debug-failure", origin: "enter" }], "the forced pattern goes with it, once");
    assert.ok(!(await posts()).some((p) => p.t === "send"), "not sent");
  } finally {
    await send([PROMPTU_OFF]);
  }
});

await check("Enter at a task start runs Promptu instead of sending; its dialog over the chat asks the page, recommendations picked, Other for free text; Enter answers it (96)", async () => {
  try {
    const sid = await fresh();
    await send([PSTATE()]);
    await type(ROUGH);
    await clearPosts();
    await type(ENTER);
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "prep", text: ROUGH, pattern: null, origin: "enter" }]);
    assert.ok(!(await posts()).some((p) => p.t === "send"), "nothing sent");
    assert.equal(await value(), ROUGH, "the draft stays as typed meanwhile");
    await send([{ t: "promptu", sid, view: { sid, seq: 7, origin: "enter", rough: ROUGH, phase: "working", doing: "prep", quick: false } }]);
    assert.match((await text(".dialog.promptu.working .dialog-title"))[0], /reading your prompt/);
    await shot("promptu-working");
    await send([pView(sid, 7)]);
    assert.deepEqual(await text(".dialog.promptu .q > .q-head"), ["Done when", "Goal"]);
    assert.ok((await text(".dialog.promptu .promptu-title"))[0].includes("implement-issue"));
    assert.equal(await exec("const a=document.activeElement; return a.checked && a.closest('.opt').textContent.includes('Build and tests pass')"), true, "the focus starts on the option picked (review F6)");
    // Even when a question with nothing picked comes first: the picked option, not the first input.
    await send([pView(sid, 6, {}, { pages: [{ ids: ["goal", "done"], questions: [Q_GOAL, Q_DONE] }] })]);
    assert.equal(await exec("const a=document.activeElement; return !!a.checked && a.closest('.q').textContent.includes('Done when')"), true, "not Goal's first option");
    await send([pView(sid, 7)]);
    const checked = await exec("return [...document.querySelectorAll('.dialog.promptu .opt')].filter((o) => o.querySelector('input').checked).map((o) => o.querySelector('span > div').textContent)");
    assert.deepEqual(checked, ["Build and tests pass (Recommended)"], "the recommendation is picked; Goal has none");
    assert.equal(await exec("return document.querySelector('.dialog.promptu .dialog-buttons button.primary').disabled"), true, "Goal still needs an answer");
    assert.ok((await text(".promptu-filled summary"))[0].includes("Already answered (1)"));
    await shot("promptu-page");
    await exec("document.querySelectorAll('.dialog.promptu textarea.other')[1].setAttribute('data-g', '1')");
    const el = Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: "textarea[data-g='1']" }))[0];
    await clearPosts();
    await wd("POST", `${S}/element/${el}/value`, { text: "so field units recover" });
    await settle();
    assert.equal(await exec("return document.querySelector('.dialog.promptu .dialog-buttons button.primary').textContent"), "Done");
    await wd("POST", `${S}/element/${el}/value`, { text: ENTER });
    await settle();
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "answer", seq: 7, input: { answers: { done: "Build and tests pass (Recommended)", goal: { other: "so field units recover" } } } }]);
  } finally {
    await send([PROMPTU_OFF]);
  }
});

await check("Esc ends the dialog with what the owner touched, the rest as assumptions; Ctrl+Enter takes every recommendation; the chip row's pick goes as the pattern (96)", async () => {
  try {
    const sid = await fresh();
    await send([PSTATE(), pView(sid, 8)]);
    await exec("[...document.querySelectorAll('.dialog.promptu .opt')].find((o) => o.textContent.includes(\"I'll judge it\")).querySelector('input').click()");
    await settle();
    await clearPosts();
    await keys(ESC_KEY);
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "finish", seq: 8, rest: "assume", input: { answers: { done: "I'll judge it" } } }]);
    await send([pView(sid, 9)]);
    await clearPosts();
    await exec("document.querySelector('.dialog.promptu').focus()");
    await ctrlEnter();
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "finish", seq: 9, rest: "recommended", input: { answers: { done: "Build and tests pass (Recommended)" } } }]);
    const choose = { ids: ["_pattern"], questions: [{ question: "Which kind of task is this?", header: "Pattern", multiSelect: false, options: [{ label: "implement-issue (Recommended)", description: "Build a change." }, { label: "No pattern, send as is", description: "Run it as typed." }] }] };
    await send([pView(sid, 10, {}, { choose, pages: [], pattern: null })]);
    assert.deepEqual(await text(".dialog.promptu .dialog-buttons button.primary"), ["Next"]);
    assert.equal((await text(".dialog.promptu textarea.other")).length, 0, "the chip row takes no free text");
    await clearPosts();
    await click(".dialog.promptu .dialog-buttons button.primary");
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "answer", seq: 10, input: { pattern: "implement-issue" } }]);
    await send([{ t: "promptu", sid, view: null }]);
    assert.equal((await text(".dialog.promptu")).length, 0, "closed");
  } finally {
    await send([PROMPTU_OFF]);
  }
});

await check("the dialog is modal: aria-modal, Tab kept inside it, the chat behind inert, and a click on the backdrop keeps Esc and Enter working (review F4)", async () => {
  try {
    const sid = await fresh();
    await send([PSTATE(), pView(sid, 21)]);
    assert.equal(await exec("return document.querySelector('.dialog.promptu').getAttribute('aria-modal')"), "true");
    assert.equal(await exec("return document.querySelector('.body').inert"), true, "the chat behind is inert");
    // Tab from the last control comes back to the first, Shift+Tab from the first goes to the last.
    await exec("const b=[...document.querySelectorAll('.dialog.promptu button')]; b[b.length-1].focus()");
    await keys("\uE004");
    const first = await exec("const f=document.activeElement; return f.tagName + ':' + (f.closest('.dialog.promptu') ? 'in' : 'out') + ':' + (f === document.querySelector('.dialog.promptu input') ? 'first' : 'other')");
    assert.equal(first, "INPUT:in:first");
    // A click on the backdrop: the focus stays in the dialog, Esc still ends it.
    const backdrop = Object.values(await wd("POST", `${S}/element`, { using: "css selector", value: ".promptu-back" }))[0];
    await wd("POST", `${S}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: { "element-6066-11e4-a52e-4f735466cecf": backdrop }, x: -200, y: -400 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
    await wd("DELETE", `${S}/actions`);
    await settle();
    assert.equal(await exec("return !!document.activeElement.closest('.dialog.promptu')"), true, "the focus stayed in the dialog");
    await clearPosts();
    await keys(ESC_KEY);
    assert.deepEqual((await promptuPosts()).map((p) => [p.op, p.rest]), [["finish", "assume"]]);
  } finally {
    await send([PROMPTU_OFF]);
  }
});

await check("the prompt lands in the draft, not sent; Ctrl+Z puts the owner's back; this task start had its pass, so the next Enter sends (96)", async () => {
  try {
    const sid = await fresh();
    await send([PSTATE()]);
    await type(ROUGH);
    await type(ENTER);
    const prompt = `## Goal\n${ROUGH}\n\n## Done when\nIt builds and the tests pass.\n\n— promptu implement-issue@1 asked=done:rec`;
    await clearPosts();
    await send([{ t: "promptu", sid, view: null }, { t: "promptuResult", result: { sid, seq: 7, origin: "enter", rough: ROUGH, prompt, pattern: "implement-issue" } }]);
    assert.equal(await value(), prompt);
    assert.ok((await text(".paste-notice"))[0].includes("Promptu wrote this prompt (implement-issue)"));
    assert.equal(await isLit(), false, "the next Enter sends it");
    assert.ok(!(await posts()).some((p) => p.t === "send"), "not sent");
    await shot("promptu-landed");
    await type(CTRL_Z);
    assert.equal(await value(), ROUGH, "the owner's own back");
    assert.equal(await isLit(), false, "the pass was had");
    await clearPosts();
    await type(ENTER);
    assert.deepEqual((await posts()).filter((p) => p.t === "send").map((p) => p.text), [ROUGH]);
    assert.deepEqual(await promptuPosts(), []);
  } finally {
    await send([PROMPTU_OFF]);
  }
});

await check("a failure is one line and the draft stays as typed, Enter then sends; Esc while it reads cancels; Quick mode shows no dialog; Start work's starter fills an empty draft when there is no prompt (96)", async () => {
  try {
    let sid = await fresh();
    await send([PSTATE()]);
    await type(ROUGH);
    await type(ENTER);
    await exec("document.activeElement && document.activeElement.blur()");
    await send([{ t: "promptuResult", result: { sid, seq: 3, origin: "enter", rough: ROUGH, error: "promptu prep failed (exit 1): the pass broke" } }]);
    assert.equal(await value(), ROUGH);
    assert.equal(await focused(), "TEXTAREA", "the draft has the focus again (review F5)");
    assert.ok((await text(".paste-notice"))[0].includes("the pass broke — your draft is as you typed it"));
    await clearPosts();
    await type(ENTER);
    assert.deepEqual((await posts()).filter((p) => p.t === "send").map((p) => p.text), [ROUGH], "never blocks sending");
    // Esc while it reads the prompt.
    sid = await fresh();
    await send([PSTATE(), { t: "promptu", sid, view: { sid, seq: 4, origin: "enter", rough: ROUGH, phase: "working", doing: "prep", quick: false } }]);
    await clearPosts();
    await keys(ESC_KEY);
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "cancel", seq: 4 }]);
    // Quick mode: no dialog, the icon turns.
    sid = await fresh();
    await send([PSTATE({ quick: true }), { t: "promptu", sid, view: { sid, seq: 5, origin: "enter", rough: ROUGH, phase: "working", doing: "prep", quick: true } }]);
    assert.equal((await text(".dialog.promptu")).length, 0);
    assert.equal((await text(".rail .rail-entry.promptu .spinner")).length, 1);
    assert.equal(await exec("return document.querySelector('.body').inert"), true, "the chat is inert during Quick mode's pass too (review F4)");
    assert.match((await text(".promptu-quick"))[0], /Esc skips it/);
    await clearPosts();
    await keys(ESC_KEY);
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "cancel", seq: 5 }], "Esc stops Quick mode's pass, not Claude");
    assert.ok(!(await posts()).some((p) => p.t === "interrupt"));
    await send([{ t: "promptu", sid, view: null }]);
    assert.equal(await exec("return document.querySelector('.body').inert"), false);
    // Start work: the dialog over the empty chat, reading the issue; no prompt, the desk's starter went instead (P2).
    sid = await fresh();
    await send([PSTATE(), { t: "promptu", sid, view: { sid, seq: 6, origin: "start", rough: "Work on ABC-123 — Make the widget blink", phase: "working", doing: "prep", quick: false } }]);
    assert.match((await text(".dialog.promptu.working .dialog-title"))[0], /reading the issue/);
    await send([{ t: "promptu", sid, view: null }, { t: "promptuResult", result: { sid, seq: 6, origin: "start", rough: "Work on ABC-123 — Make the widget blink", error: "promptu prep took over 40 s", fallbackSent: true } }]);
    assert.equal(await value(), "", "the starter went to Claude; the draft stays empty");
    assert.ok((await text(".paste-notice"))[0].includes("the desk's starter went to Claude instead"));
    // An older host's fallback for the draft still fills an empty one.
    const starter = "Read ABC-123 — Make the widget blink with the desk's linear_get_issue tool, then wait.";
    sid = await fresh();
    await send([PSTATE(), { t: "promptuResult", result: { sid, seq: 7, origin: "start", rough: "Work on ABC-123", error: "x", fallback: starter } }]);
    assert.equal(await value(), starter);
    assert.ok((await text(".paste-notice"))[0].includes("the desk's starter is in the draft"));
    assert.equal(await focused(), "TEXTAREA", "and the focus with it (review F5)");
  } finally {
    await send([PROMPTU_OFF]);
  }
});

await check("the 💡's handoff card opens the handoff pattern's dialog while Promptu is on, with no preview; off, it edits the draft as before (97)", async () => {
  const handoff = { id: "h1", category: "context", kind: "handoff", title: "Hand off to a fresh chat", why: "The context is nearly full", edit: { op: "handoff" } };
  const draft = "now write the release notes for the whole quarter";
  try {
    const hsid = await fresh();
    await send([PSTATE()]);
    await send([sent("x"), { t: "event", e: { type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] }, parent_tool_use_id: null } }]);
    await setDraft(draft);
    const ask = await waitAssist("cards");
    await send([{ t: "cards", seq: ask.seq, cards: [handoff] }]);
    await click(".bulb");
    await settle();
    assert.ok((await text(".menu.bulb .menu-item-detail"))[0].startsWith("Opens Promptu's handoff questions"));
    await hover(".menu.bulb .menu-item", handoff.title);
    assert.equal(await exec("return document.querySelector('.composer textarea').classList.contains('previewing')"), false, "no preview: it opens a dialog");
    await clearPosts();
    await pick(".menu.bulb .menu-item", handoff.title);
    await settle();
    assert.deepEqual(await promptuPosts(), [{ t: "promptu", op: "prep", text: draft, pattern: "handoff", origin: "handoff" }]);
    assert.equal(await value(), draft, "the draft waits for the dialog's prompt");
    // Cancelled: the card is still there to try again (review F7).
    await send([{ t: "promptuResult", result: { sid: hsid, seq: 1, origin: "handoff", rough: draft, cancelled: true } }]);
    assert.equal((await text(".bulb .count"))[0], "1", "the card stays after a cancelled pass");
    await clearPosts();
    await click(".rail .bulb");
    await settle();
    await pick(".menu.bulb .menu-item", handoff.title);
    await settle();
    assert.equal((await promptuPosts("prep")).length, 1, "and runs again");
    // A prompt lands: now it is used.
    await send([{ t: "promptuResult", result: { sid: hsid, seq: 2, origin: "handoff", rough: draft, prompt: "## Goal\nnow the notes\n\n— promptu handoff@1 asked=reader:rec", pattern: "handoff" } }]);
    assert.equal((await text(".bulb .count")).length, 0, "used once its prompt is in the draft");
    await mouseAway();
    // Off: the card's edit, as decision 36 has it.
    await fresh();
    await send([PROMPTU_OFF, sent("x"), { t: "event", e: { type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] }, parent_tool_use_id: null } }]);
    await setDraft(draft);
    const ask2 = await waitAssist("cards");
    await send([{ t: "cards", seq: ask2.seq, cards: [handoff] }]);
    await click(".bulb");
    await settle();
    await pick(".menu.bulb .menu-item", handoff.title);
    await settle();
    assert.match(await value(), /^Write a handoff for a fresh chat/);
  } finally {
    await mouseAway();
    await send([PROMPTU_OFF]);
  }
});

await check("the Memory menu: scope, then domain, then kind, stale flags and where each was used; a click opens the entry's file, a dead link its index line (98)", async () => {
  await fresh();
  await clearPosts();
  await click(".rail .rail-entry.memory");
  await settle();
  assert.deepEqual((await posts()).filter((p) => p.t === "promptuMemory"), [{ t: "promptuMemory" }]);
  assert.ok((await text(".memory-pop"))[0].includes("Reading"));
  const mem = "/home/u/.claude/projects/-work/memory";
  const data = {
    promptu: 1,
    project_root: "/work/app",
    today: "2026-10-30",
    memory: { path: mem, exists: true, index: `${mem}/MEMORY.md` },
    scopes: [
      { id: "user", label: "User", files: ["/home/u/.claude/CLAUDE.md"], domains: ["Working rules"] },
      { id: "auto", label: "Auto memory", files: [`${mem}/MEMORY.md`, `${mem}/soak-test.md`], domains: ["testing", "tooling"] },
      { id: "project", label: "Project", files: [], domains: [] },
    ],
    entries: [
      { scope: "user", domain: "Working rules", kind: null, id: "claude-md", file: "/home/u/.claude/CLAUDE.md", title: "Working rules", line: "- Ask when unclear.", line_no: 12, modified: null, age_days: null, flags: [], stale: false, used: [] },
      { scope: "auto", domain: "testing", kind: "status", id: "08841b", file: `${mem}/soak-test.md`, title: "Soak test", line: "- [Soak test](soak-test.md) — paused", line_no: 3, modified: "2026-09-15", age_days: 45, flags: ["review_by_past"], stale: true, used: [{ pattern: "bench-session", question: "gate", date: "2026-10-29", changed: false }] },
      { scope: "auto", domain: "testing", kind: "trap", id: "de8cea", file: `${mem}/cache-trap.md`, title: "Cache trap", line: "- [Cache trap](cache-trap.md) — clear it", line_no: 4, modified: "2026-10-20", age_days: 10, flags: [], stale: false, used: [] },
      { scope: "auto", domain: "tooling", kind: null, id: "aa11bb", file: `${mem}/gone.md`, title: "Gone", line: "- [Gone](gone.md) — x", line_no: 7, modified: null, age_days: null, flags: ["dead_link"], stale: true, used: [] },
    ],
    counts: { entries: 4, stale: 2 },
    used_scanned: true,
    used_claude_md: [{ pattern: "implement-issue", question: "rules", date: "2026-10-28", changed: false }],
  };
  await send([{ t: "promptuMemory", data }]);
  assert.deepEqual(await text(".memory-pop .mem-domain-name"), ["testing", "tooling"]);
  assert.deepEqual(await text(".memory-pop .mem-kind .q-head"), ["trap", "status", "no kind"], "kinds in their order, within each domain");
  const soak = (await text(".memory-pop .mem-row.stale"))[0];
  assert.ok(soak.includes("Soak test") && soak.includes("45d") && soak.includes("review-by passed") && soak.includes("used ×1"), soak);
  assert.ok((await text(".memory-pop summary"))[0].includes("CLAUDE.md used ×1"));
  await shot("memory-menu");
  await clearPosts();
  await click(".memory-pop .mem-row", "Soak test");
  await click(".memory-pop .mem-row", "Gone");
  assert.deepEqual(
    (await posts()).filter((p) => p.t === "promptuOpen"),
    [
      { t: "promptuOpen", file: `${mem}/soak-test.md` },
      { t: "promptuOpen", file: `${mem}/MEMORY.md`, line: 7 },
    ],
  );
  await send([{ t: "promptuMemory", error: "promptu is not installed here" }]);
  assert.ok((await text(".memory-pop .warn"))[0].includes("not installed"));
  // By the keys (review F10): Enter on the entry puts the focus in the menu, Esc closes it and gives the focus back.
  await click(".rail .rail-entry.memory");
  await settle();
  assert.equal((await text(".memory-pop")).length, 0, "the click closed it");
  await exec("document.querySelector('.rail .rail-entry.memory').focus()");
  await keys("\uE007");
  assert.equal(await exec("return !!document.activeElement.closest('.memory-pop')"), true, "the focus is in the menu");
  await keys(ESC_KEY);
  assert.equal((await text(".memory-pop")).length, 0);
  assert.equal(await exec("return document.activeElement.classList.contains('memory')"), true, "back on its entry");
  await click(".rail .rail-entry.memory");
  await settle();
  await keys(ESC_KEY);
  await click(".composer textarea");
  await exec("document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))");
  await settle();
  assert.equal((await text(".memory-pop")).length, 0, "a click elsewhere closes it");
});

// ------------------------------------------------------------ the list

await go("/list.html");

let listMsg;
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
  listMsg = { t: "groups", groups, desk: "Example", error: null, selected: "o", now: Date.now() };
  await send([listMsg]);
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

await check("the list's ✎ names a thread this window runs or nothing runs; one run elsewhere has none", async () => {
  await send([listMsg]);
  await clearPosts();
  const renamable = await exec("return [...document.querySelectorAll('.thread')].filter((t) => t.querySelector('.rename')).map((t) => t.querySelector('.ttitle').textContent)");
  assert.deepEqual(renamable.sort(), ["My chat", "Yesterday's chat"]);
  await exec("[...document.querySelectorAll('.thread')].find((t) => t.textContent.includes('My chat')).querySelector('.rename').click()");
  await settle();
  assert.deepEqual((await posts()).filter((p) => p.t !== "ready"), [{ t: "rename", sid: "o" }], "it does not open the thread too");
});

await check("the list by keyboard: a row takes focus and Enter opens it; Tab reaches its actions and a group's +, which show while focused (review r4 P2)", async () => {
  await send([listMsg]);
  await clearPosts();
  const mine = "[...document.querySelectorAll('.thread')].find((t) => t.textContent.includes('My chat'))";
  assert.equal(await exec(`${mine}.focus(); return document.activeElement === ${mine}`), true, "the row takes focus");
  await keys("\uE007");
  assert.deepEqual((await posts()).filter((p) => p.t === "open"), [{ t: "open", sid: "o" }], "Enter opens it");
  await clearPosts();
  await keys("\uE004");
  const at = await exec("const e = document.activeElement; return [e.title, e.closest('.thread')?.textContent.includes('My chat'), getComputedStyle(e.closest('.acts')).opacity]");
  assert.deepEqual(at, ["Rename", true, "1"], "Tab goes to the row's first action, on screen");
  await keys("\uE007");
  assert.deepEqual((await posts()).filter((p) => p.t !== "ready"), [{ t: "rename", sid: "o" }], "Enter on it acts, and does not open the row too");
  const add = await exec("const b = document.querySelector('.group-head .add'); b.focus(); return [document.activeElement === b, getComputedStyle(b).opacity]");
  assert.deepEqual(add, [true, "1"], "a group's + too");
  await exec("document.activeElement.blur()");
});

await check("a chat whose turn finished unseen lists unread: a filled dot in the done colour, and Mark as Unread on its right-click", async () => {
  const groups = core.buildThreads({
    view: null,
    desk: null,
    repos: ["/work/fw"],
    own: [
      { sessionId: "u1", title: "Flash finished", status: "idle", itemId: null, lastMs: Date.now() - 60000, cwd: "/work/fw", unread: true },
      { sessionId: "r1", title: "Read already", status: "idle", itemId: null, lastMs: Date.now(), cwd: "/work/fw" },
    ],
    past: [{ sessionId: "p1", title: "Yesterday's chat", firstPrompt: null, cwd: "/work/fw", lastMs: Date.now() - 86400000 }],
    itemOf: {},
    now: Date.now(),
  });
  await send([{ t: "groups", groups, desk: "Example", error: null, selected: null, now: Date.now() }]);
  assert.deepEqual(await text(".thread .ttitle"), ["Flash finished", "Read already", "Yesterday's chat"], "unread ahead of what was read");
  assert.equal(await exec("return document.querySelectorAll('.dot.unread').length"), 1);
  assert.ok((await text(".thread .tmeta"))[0].includes("finished — unread"));
  const ok = await exec("const c = getComputedStyle(document.body).getPropertyValue('--ok').trim(); const d = document.createElement('i'); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return [v, getComputedStyle(document.querySelector('.dot.unread')).backgroundColor]");
  assert.equal(ok[1], ok[0], "filled in --ok");
  // This window's rows name their chat for the right-click menu; a past chat's offers nothing.
  const ctx = await exec("return [...document.querySelectorAll('.thread')].map((e) => e.getAttribute('data-vscode-context'))");
  assert.deepEqual(JSON.parse(ctx[0]), { webviewSection: "embarchChat", sid: "u1" });
  assert.equal(ctx[2], null);
  await shot("list-unread");
});

await check("the list says so when the desk is down", async () => {
  await send([{ t: "groups", groups: [], desk: null, error: "The desk is not running — showing this window's chats only.", selected: null, now: Date.now() }]);
  assert.ok((await text(".warn-line"))[0].includes("not running"));
  // Its links carry no href either.
  assert.equal(await exec("return document.body.querySelectorAll('[href]').length"), 0);
  await exec("window.__posts = []; window.__vscode = [];");
  await realClick(await wd("POST", `${S}/element`, { using: "css selector", value: ".list a" }));
  assert.deepEqual(await exec("return window.__vscode"), []);
  assert.ok((await posts()).some((p) => p.t === "newChat"));
});

await check("the list says so when the desk predates this panel", async () => {
  const notice = "Update embarch-desk: the running one predates this panel — only chats in this window's repos show.";
  await send([{ t: "groups", groups: [], desk: "Example", error: null, notice, selected: null, now: Date.now() }]);
  assert.deepEqual(await text(".warn-line"), [notice]);
  await send([{ t: "groups", groups: [], desk: "Example", error: null, notice: null, selected: null, now: Date.now() }]);
  assert.deepEqual(await text(".warn-line"), []);
});

await check("the pages run under the production CSP, with nothing refused", async () => {
  assert.deepEqual(await exec("return window.__violations"), [], "the list");
  await go("/chat.html");
  await send([snapshot(), ...events(outLines("basic"))]);
  assert.deepEqual(await exec("return window.__violations"), [], "the chat");
});

await check("a title that closes the <title> stays text: the page still runs", async () => {
  await go(`/chat.html?title=${encodeURIComponent("ABC-123 Fix </title><plaintext> parsing")}`);
  assert.equal(await exec("return document.title"), "ABC-123 Fix </title><plaintext> parsing");
  await send([snapshot()]);
  assert.ok((await text(".header"))[0].includes("Make the widget blink"));
});

// ------------------------------------------------------------ the look

await check("UI text is IBM Plex Sans from the page's own origin, a 600 is a 600, and code keeps the editor's font", async () => {
  await go("/chat.html");
  await send([snapshot(), sent("hi"), ...events(outLines("basic"))]);
  await click(".tool .line");
  const f = await wd("POST", `${S}/execute/async`, {
    script: `const done = arguments[0];
      document.fonts.ready.then(() => {
        const width = (w) => { const s = document.createElement("span"); s.style.cssText = "font: " + w + " 20px 'IBM Plex Sans'; white-space: nowrap"; s.textContent = "Threads waiting on you"; document.body.append(s); const x = s.getBoundingClientRect().width; s.remove(); return x; };
        done({
          faces: [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "IBM Plex Sans").map((f) => f.status),
          body: getComputedStyle(document.body).fontFamily,
          code: getComputedStyle(document.querySelector(".tool .summary")).fontFamily,
          out: getComputedStyle(document.querySelector(".tool pre.out")).fontFamily,
          widths: [400, 600, 700].map(width),
        });
      });`,
    args: [],
  });
  assert.deepEqual(f.faces, ["loaded"]);
  assert.deepEqual([...fontsServed], ["/dist/webview/fonts/ibm-plex-sans-var-latin.woff2"], "one file, from the page's origin");
  assert.match(f.body, /^"IBM Plex Sans", sans-serif$/);
  assert.equal(f.code, "monospace");
  assert.equal(f.out, "monospace");
  // One variable file: each weight is its own width. A static cut would
  // synthesise 600 and 700 alike.
  assert.ok(f.widths[0] < f.widths[1] && f.widths[1] < f.widths[2], JSON.stringify(f.widths));
  assert.deepEqual(await exec("return window.__violations"), []);
});

await check("dark and light take EmbArch's accents and semantics; a high-contrast theme keeps VS Code's", async () => {
  const tokens = "const c = getComputedStyle(document.body); return ['--accent', '--link', '--waiting', '--busy', '--ok', '--err'].map((t) => c.getPropertyValue(t).trim());";
  assert.deepEqual(await exec(tokens), ["oklch(72% 0.13 200)", "oklch(72% 0.13 200)", "oklch(78% 0.15 85)", "oklch(70% 0.11 240)", "oklch(72% 0.15 150)", "oklch(66% 0.19 25)"]);
  await exec("document.body.classList.replace('vscode-dark', 'vscode-high-contrast')");
  assert.deepEqual(await exec(tokens), ["#0e639c", "#4daafc", "#d18616", "#3794ff", "#388a34", "#f14c4c"]);
  await go("/chat.html?kind=light");
  assert.deepEqual(await exec(tokens), ["oklch(52% 0.13 200)", "oklch(52% 0.13 200)", "oklch(55% 0.14 80)", "oklch(50% 0.12 240)", "oklch(48% 0.13 150)", "oklch(50% 0.18 25)"]);
  // The light pages, for the screenshots.
  await send([snapshot(), sent("Run the bash command `echo hello-from-bash` and then reply with just: done"), ...events(outLines("basic"))]);
  await click(".tool .line");
  await send(events(upTo(outLines("deny"), (o) => o.type === "control_request")));
  await shot("chat-light");
  await go("/list.html?kind=light");
  await send([listMsg]);
  await shot("list-light");
  assert.deepEqual(await exec("return window.__violations"), []);
});

await check("high contrast: the chosen model and effort carry an outline, as VS Code marks a selection there (53)", async () => {
  await go("/chat.html");
  await fresh({}, false);
  await exec("document.body.classList.replace('vscode-dark', 'vscode-high-contrast')");
  await click(".composer .pill.model");
  await settle();
  assert.deepEqual(await exec("return [...document.querySelectorAll('.model-pop .on')].map((e) => [e.textContent, getComputedStyle(e).outlineStyle])"), [
    ["Default model", "solid"],
    ["Default", "solid"],
  ]);
});

await check("a chat tab's mark at 16 px: plain, amber while it waits, green when a turn finished unread; the mark's red never moves", async () => {
  // Each SVG drawn as VS Code draws a tab icon, at 16 px, and read back pixel by pixel.
  const files = ["", "pending-", "done-"].flatMap((st) => ["dark", "light"].map((th) => `embarch-tab-${st}${th}`));
  const urls = Object.fromEntries(files.map((f) => [f, `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, "media", `${f}.svg`)).toString("base64")}`]));
  await wd("POST", `${S}/url`, { url: "about:blank" });
  const px = await wd("POST", `${S}/execute/async`, {
    script: `const [urls, done] = arguments; (async () => { const out = {};
      const big = document.createElement("canvas"); big.width = 3 * 136; big.height = 300; document.body.style.cssText = "margin:0;background:#fff"; document.body.append(big);
      const g = big.getContext("2d"); g.imageSmoothingEnabled = false;
      let i = 0;
      for (const [name, url] of Object.entries(urls)) {
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement("canvas"); c.width = c.height = 16;
        const x = c.getContext("2d"); x.drawImage(img, 0, 0, 16, 16);
        const at = (px, py) => [...x.getImageData(px, py, 1, 1).data];
        out[name] = { dot: at(12, 3), a: at(13, 13), png: c.toDataURL("image/png") };
        // Plain, pending, done across; dark over light: magnified, and at 16 px under each.
        const X = Math.floor(i / 2) * 136, Y = (i % 2) * 150;
        g.fillStyle = name.endsWith("dark") ? "#1f1f1f" : "#f8f8f8"; g.fillRect(X, Y, 136, 150);
        g.drawImage(c, X + 4, Y + 4, 128, 128); g.drawImage(c, X + 60, Y + 134);
        i++;
      }
      done(out); })();`,
    args: [urls],
  });
  const hex = (p) => "#" + p.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
  assert.equal(hex(px["embarch-tab-pending-dark"].dot), "#e3ae28", "amber, --waiting");
  assert.equal(hex(px["embarch-tab-pending-light"].dot), "#9b6500");
  assert.equal(hex(px["embarch-tab-done-dark"].dot), "#53be70", "green, --ok");
  assert.equal(hex(px["embarch-tab-done-light"].dot), "#067132");
  assert.equal(hex(px["embarch-tab-dark"].dot), "#e74c3c", "the plain mark: the A's apex where the dot goes");
  for (const th of ["dark", "light"]) for (const st of ["pending-", "done-"]) assert.deepEqual(px[`embarch-tab-${st}${th}`].a, px[`embarch-tab-${th}`].a, `the A's red, ${st}${th}`);
  assert.equal(hex(px["embarch-tab-dark"].a), "#e74c3c");
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    for (const [name, v] of Object.entries(px)) fs.writeFileSync(path.join(SHOTS, `${name}-16px.png`), Buffer.from(v.png.split(",")[1], "base64"));
  }
  await shot("tab-icons");
});

await teardown();
console.log(failed ? `${failed} FAILED` : "all webview checks passed");
process.exit(failed ? 1 : 0);
