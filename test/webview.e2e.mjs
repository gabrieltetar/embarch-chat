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
const THEME_LIGHT = `:root{--vscode-font-family:sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;
--vscode-foreground:#3b3b3b;--vscode-sideBar-background:#f8f8f8;--vscode-editor-background:#fff;--vscode-input-background:#fff;--vscode-input-border:#cecece;
--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;
--vscode-descriptionForeground:#3b3b3b;--vscode-textLink-foreground:#005fb8;--vscode-textCodeBlock-background:#f8f8f8;--vscode-panel-border:#e5e5e5}`;
const KINDS = { dark: { vars: THEME, body: "vscode-dark" }, light: { vars: THEME_LIGHT, body: "vscode-light" } };

// The page VS Code would get (src/views/page.ts): the same strict CSP —
// scripts by nonce only — and the title escaped; the stand-in for the
// webview's API rides in with the page's nonce, and so does VS Code's own
// click handler for webview pages (fixtures/vscode-webview-click.js), which
// records in `__vscode` what it would hand the workbench to open. `?title=`
// sets the title.
const PAGE_PORT = 4989;
const WD_PORT = 4988;
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
  // With the page's own /copy (decision 74).
  assert.deepEqual(await text(".popup div"), ["/compact", "/context", "/copy"]);
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
  const cards = core.parseCards(haikuAnswer("cards"), ask.text, "w");
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
  await click(".bulb");
  await settle();
  await pick(".menu.bulb .menu-item", first.title);
  await settle();
  assert.equal(await value(), after, "applied");
  assert.equal((await text(".menu.bulb")).length, 0, "the menu closes");
  await type(CTRL_Z);
  assert.equal(await value(), "fix the flash thing", "Ctrl+Z restores the draft");
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
  assert.ok((await text(".user.pending .held"))[0]?.includes("after the compaction"));
  await shot("assist-compact-held");
  // The recorded compaction and turn after it, with this draft's words in place of the recording's.
  const lines = outLines("compact");
  const firstResult = lines.findIndex((o) => o.type === "result");
  const rest = JSON.parse(JSON.stringify(lines.slice(firstResult + 1)).split("What was the secret word? One word.").join(split.rest.replace(/"/g, '\\"')));
  await send(events(rest));
  assert.ok((await text(".note.compact")).length === 1, "compacted");
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
  await send([{ t: "cards", seq: ask.seq, cards: [{ id: "h1", category: "improve", title: "Name the readme section", edit: { op: "append", text: "(the Flashing section)" } }] }]);
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
    cliAsks("r-url", { subtype: "elicitation", mcp_server_name: "bench", message: "Sign in to the test bench to continue.", mode: "url", url: "https://example.com/bench/sign-in", elicitation_id: "bench-sign-in-1" }),
  ]);
  assert.deepEqual(await text(".card .url"), ["https://example.com/bench/sign-in"]);
  await click(".card button", "Open");
  const ps = await posts();
  assert.deepEqual(ps.find((p) => p.t === "openLink"), { t: "openLink", url: "https://example.com/bench/sign-in" });
  assert.deepEqual(ps.find((p) => p.t === "respond").response, { action: "accept" });
  await clearPosts();
  await click(".card button.close");
  assert.deepEqual((await responded()).map((x) => x.response), [{ action: "cancel" }]);
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
  assert.equal((await text(".card.dialog")).length, 1);
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
  await fresh({}, false);
  await send([sent("flash it"), limit(limitLine.rate_limit_info)]);
  assert.deepEqual(await text(".limit-banner"), [], "allowed: nothing");
  await send([limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.69, resetsAt: inH(50) })]);
  assert.deepEqual(await text(".limit-banner"), [], "under 70 %: nothing");
  await send([limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.86, resetsAt: inH(50) })]);
  assert.deepEqual(await text(".limit-banner.warn span"), ["You've used 86% of your weekly limit · resets in 2d"]);
  await shot("limit-warning");
  await click(".limit-banner button");
  assert.deepEqual(await text(".limit-banner"), [], "hidden");
  await send([limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, resetsAt: inH(50) })]);
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

// ------------------------------------------------------------ work that runs on its own (port items 70, 71)

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
  assert.deepEqual(await text(".popup div"), ["/embarch-chat:build-flash-verifyBench"]);
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
  assert.deepEqual(save, { t: "exportSave", text: t, filename: "2026-10-23-140509-run-the-bash-command-echo-hello-from-bash-and-th.txt" });
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

await check("a past chat nothing runs offers the fork alone; a thread run elsewhere, nothing", async () => {
  await basicChat({ ...OURS, ours: false, resumable: true });
  await messageMenu("Reply with just: ok");
  assert.deepEqual(await text(".msg-menu .menu-item"), ["Fork conversation from here"]);
  await basicChat({ ...OURS, ours: false, readOnly: true });
  assert.equal((await text(".user .msg-act")).length, 0);
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

await check("the header's ✎ asks the host to rename the chat; a thread run elsewhere has none", async () => {
  await basicChat();
  await click(".header .rename");
  assert.ok((await posts()).some((p) => p.t === "rename"));
  await basicChat({ ...OURS, ours: false, readOnly: true });
  assert.equal((await text(".header .rename")).length, 0);
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

await teardown();
console.log(failed ? `${failed} FAILED` : "all webview checks passed");
process.exit(failed ? 1 : 0);
