#!/usr/bin/env node
// How the chat webview holds up in a long session (decision 85), measured in
// headless Firefox as test/webview.e2e.mjs drives it: test/longsession.mjs's
// chat opened by a snapshot, a 20 KB reply streamed into it one delta per
// frame, then a hardware loop's steps arriving. Prints the numbers; asserts
// nothing — the suite's own check does, with a generous bound.
//
//   node build.mjs && node build.mjs --tests && node test/perf.e2e.mjs [runs] [session scale] [reply scale] [checkout ...]
//
// Each extra checkout (another tree with its own `node build.mjs` done) is
// measured beside this one, run by run in turn, so a machine that slows
// down mid-way slows both: compare them, not runs taken an hour apart.
// It binds the suites' ports, so run it under the same lock as the suites.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MEASURE_OPEN, MEASURE_UPDATES, longSession, quantile, streamedReply } from "./longsession.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const core = require("../test-out/core.js");
const RUNS = Number(process.argv[2] ?? 3);
/** How many times the default session (60 turns, 600 steps) and reply (20 KB). */
const SCALE = Number(process.argv[3] ?? 1);
const REPLY = Number(process.argv[4] ?? 1);
const ROOTS = [path.dirname(here), ...process.argv.slice(5).map((p) => path.resolve(p))];

// The tests' scratch range (scratch-desk.mjs): EMBARCH_CHAT_TEST_PORT_BASE moves it.
const PORT_BASE = Number(process.env.EMBARCH_CHAT_TEST_PORT_BASE) || 4980;
const PAGE_PORT = PORT_BASE + 9;
const WD_PORT = PORT_BASE + 8;
const origin = `http://127.0.0.1:${PAGE_PORT}`;
const THEME = ":root{--vscode-font-family:sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-foreground:#ccc;--vscode-sideBar-background:#1f1f1f}";
/** Checkout k's page, at /k/chat.html, its bundle beside it. */
function page(k) {
  const nonce = Math.random().toString(36).slice(2);
  const head = `<style>${THEME}</style><script nonce="${nonce}">window.__posts = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posts.push(m), getState: () => undefined, setState: () => {} });</script>`;
  const at = `${origin}/${k}/dist/webview`;
  return core.pageHtml({ nonce, cspSource: origin, js: `${at}/chat.js`, css: `${at}/chat.css`, title: "Perf", head }).replace("<body>", `<body class="vscode-dark">`);
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const m = /^\/(\d+)(\/.*)$/.exec(u.pathname);
  const root = m && ROOTS[Number(m[1])];
  if (root && m[2] === "/chat.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page(m[1]));
  }
  const file = root ? path.join(root, m[2]) : "";
  if (!root || !file.startsWith(path.join(root, "dist")) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : file.endsWith(".woff2") ? "font/woff2" : "text/javascript" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PAGE_PORT, "127.0.0.1", r));

// System access: the page's memory is read from Firefox's own reporters.
const gecko = spawn("geckodriver", ["--port", String(WD_PORT), "--allow-system-access"], { stdio: "ignore" });
const wdBase = `http://127.0.0.1:${WD_PORT}`;
let S = null;
async function wd(method, p, body) {
  const r = await fetch(wdBase + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${p}: ${j.value.error}: ${j.value.message}`);
  return j.value;
}
const teardown = async () => {
  if (S) await wd("DELETE", S).catch(() => {});
  gecko.kill();
  server.close();
};
for (let i = 0; i < 50; i++) {
  try {
    await fetch(wdBase + "/status");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
try {
  const sess = await wd("POST", "/session", {
    // Timers to the microsecond: Firefox rounds them to the millisecond otherwise.
    capabilities: { alwaysMatch: { "moz:firefoxOptions": { args: ["-headless", "-width", "460", "-height", "900"], prefs: { "privacy.reduceTimerPrecision": false } } } },
  });
  S = `/session/${sess.sessionId}`;
  await wd("POST", `${S}/timeouts`, { script: 600_000 });
  const exec = (script, args = []) => wd("POST", `${S}/execute/sync`, { script, args });
  const execAsync = (script, args = []) => wd("POST", `${S}/execute/async`, { script, args });
  const settle = () => execAsync("const done = arguments[0]; setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true))), 60);");
  const go = async (k) => {
    await wd("POST", `${S}/url`, { url: "about:blank" });
    await wd("POST", `${S}/url`, { url: `${origin}/${k}/chat.html` });
    for (let i = 0; i < 50; i++) {
      if (await exec("return window.__posts && window.__posts.some(p => p.t === 'ready')")) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the webview never said ready");
  };

  /** Checkout k's page's own memory, from Firefox's memory reporters: its window's DOM, layout and JS (chrome context). */
  const memory = async (k) => {
    try {
      await wd("POST", `${S}/moz/context`, { context: "chrome" });
      // Reporters write a URL's slashes as backslashes.
      const top = `explicit/window-objects/top(${`${origin}/${k}/chat.html`.replace(/\//g, "\\")}`;
      return await execAsync(
        `const [top, done] = arguments;
        const mgr = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);
        const sum = { page: 0, js: 0 };
        mgr.minimizeMemoryUsage(() =>
          mgr.getReports((proc, p, kind, units, amount) => {
            if (units !== Ci.nsIMemoryReporter.UNITS_BYTES || !p.startsWith(top)) return;
            sum.page += amount;
            if (p.includes("/js-")) sum.js += amount;
          }, null, () => done({ page: sum.page / 1048576, js: sum.js / 1048576 }), null, false));`,
        [top],
      );
    } catch (e) {
      return { page: NaN, js: NaN, error: e.message };
    } finally {
      await wd("POST", `${S}/moz/context`, { context: "content" }).catch(() => {});
    }
  };

  const SID = "11111111-2222-4333-8444-555555555555";
  const lines = longSession({ turns: 60 * SCALE, steps: 600 * SCALE, big: 6 * SCALE });
  const state = core.reduceAll({ ...core.initialState(SID), cwd: "/work/fw/app", process: "running" }, lines);
  const view = { ours: true, readOnly: false, resumable: false, inEditor: false, uiUrl: "http://127.0.0.1:4890/", atlas: null };
  const snapshot = { t: "snapshot", state, view, header: null, warning: null };
  const reply = streamedReply({ chars: 20_000 * REPLY });
  const ev = (e) => ({ t: "event", e });
  const ask = ev({ type: "_sent", n: 1, text: "Why does the sensor read zero after a flash?" });
  // A hardware loop's steps arriving after the reply: each call, then its result.
  const loop = [ev({ type: "_sent", n: 2, text: "Flash it and read the console" })];
  for (let k = 0; k < 20; k++) {
    const id = `toolu_live_${k}`;
    loop.push(ev({ type: "assistant", message: { id: `msg_live_${k}`, content: [{ type: "tool_use", id, name: "Bash", input: { command: "west flash", description: `Flash attempt ${k}` } }] } }));
    loop.push(ev({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `flash ${k} ok` }] } }));
  }

  const measure = async (k) => {
    await go(k);
    const open = await execAsync(MEASURE_OPEN, [snapshot]);
    await settle();
    const memOpen = await memory(k);
    await exec("for (const m of arguments[0]) window.postMessage(m, '*');", [[ask]]);
    await settle();
    const stream = await execAsync(MEASURE_UPDATES, [reply.deltas.map(ev)]);
    const land = await execAsync(MEASURE_UPDATES, [reply.done.map(ev)]);
    const steps = await execAsync(MEASURE_UPDATES, [loop]);
    await settle();
    const memEnd = await memory(k);
    // The same reply in a chat with nothing else: what the reply alone costs.
    await go(k);
    await execAsync(MEASURE_OPEN, [{ ...snapshot, state: { ...core.initialState(SID), cwd: "/work/fw/app", process: "running" } }]);
    await exec("for (const m of arguments[0]) window.postMessage(m, '*');", [[ask]]);
    await settle();
    const alone = await execAsync(MEASURE_UPDATES, [reply.deltas.map(ev)]);
    const row = {
      openMs: open.ms,
      openLayout: open.layout,
      openNodes: open.nodes,
      streamP50: quantile(stream.work, 0.5),
      streamP95: quantile(stream.work, 0.95),
      streamMax: Math.max(...stream.work),
      tailP50: quantile(stream.work.slice(-100), 0.5),
      layoutP50: quantile(stream.layout, 0.5),
      frameP50: quantile(stream.gaps, 0.5),
      frameP95: quantile(stream.gaps, 0.95),
      landMs: Math.max(...land.work),
      aloneP50: quantile(alone.work, 0.5),
      aloneTail: quantile(alone.work.slice(-100), 0.5),
      stepP50: quantile(steps.work, 0.5),
      stepP95: quantile(steps.work, 0.95),
      endNodes: steps.nodes,
      memOpenMB: memOpen.page,
      jsOpenMB: memOpen.js,
      memEndMB: memEnd.page,
      jsEndMB: memEnd.js,
    };
    if (memOpen.error) row.memError = memOpen.error;
    return row;
  };

  const rows = ROOTS.map(() => []);
  for (let run = 0; run < RUNS; run++) {
    for (let k = 0; k < ROOTS.length; k++) {
      const row = await measure(k);
      rows[k].push(row);
      console.log(`run ${run + 1} [${k}]: ${JSON.stringify(row, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v))}`);
    }
  }
  console.log(`\nsession: ${state.timeline.length} timeline entries, ${Object.values(state.entries).filter((e) => e.kind === "tool").length} tool steps; reply ${reply.text.length} chars in ${reply.deltas.length - 2} deltas`);
  console.log(`median of ${RUNS} runs:${ROOTS.map((r, k) => `  [${k}] ${r}`).join("")}`);
  for (const key of Object.keys(rows[0][0]).filter((x) => typeof rows[0][0][x] === "number")) {
    console.log(`  ${key.padEnd(10)} ${rows.map((rs) => quantile(rs.map((r) => r[key]), 0.5).toFixed(1).padStart(8)).join("")}`);
  }
} finally {
  await teardown();
}
