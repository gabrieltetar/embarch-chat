// A long chat for the webview's speed checks (decision 85): the lines a
// long hardware session would leave — turns of builds, flashes and serial
// logs folded into runs (decision 50), now and then an edit, a few build
// logs of 100K characters, long Markdown replies with code blocks — and a
// reply that streams in small deltas. Generated here, with a fixed seed so
// two runs are the same chat; nothing in it is recorded from a real one.

/** A small seeded generator: the same chat on every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the board resets after the flash and the console shows the boot banner twice so the watchdog fires before the scheduler starts the sensor thread reads the bus at the wrong rate when the clock is not ready yet a retry with a longer delay settles it the log shows each step in order the build links the new driver and the image grows by four kilobytes".split(
    " ",
  );
const FILES = ["src/main.c", "src/sensor.c", "src/sensor.h", "drivers/bus.c", "boards/dev.overlay", "prj.conf", "CMakeLists.txt", "src/power.c", "tests/sensor_test.c"];

function words(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  return out.join(" ");
}

function sentence(r, n = 8 + Math.floor(r() * 12)) {
  const s = words(r, n);
  return s[0].toUpperCase() + s.slice(1) + ".";
}

/** A Markdown reply about `chars` long: headings, paragraphs, lists, code blocks, a table. */
export function markdownReply(r, chars) {
  const parts = [];
  let n = 0;
  let k = 0;
  while (n < chars) {
    let p;
    switch (k++ % 6) {
      case 0:
        p = `## ${sentence(r, 4).slice(0, -1)}`;
        break;
      case 1:
      case 4:
        p = [sentence(r), sentence(r), `It is in \`${FILES[Math.floor(r() * FILES.length)]}\`, **${words(r, 2)}** and *${words(r, 2)}*.`].join(" ");
        break;
      case 2:
        p = Array.from({ length: 3 + Math.floor(r() * 3) }, () => `- ${sentence(r, 6)}`).join("\n");
        break;
      case 3: {
        const lines = Array.from({ length: 6 + Math.floor(r() * 10) }, (_, i) => `    ${["int", "static int", "uint32_t"][i % 3]} v${i} = read_reg(0x${(0x40 + i).toString(16)}); /* ${words(r, 4)} */`);
        p = ["```c", "int sensor_init(const struct device *dev)", "{", ...lines, "    return 0;", "}", "```"].join("\n");
        break;
      }
      default:
        p = ["| step | result | time |", "| --- | --- | --- |", ...Array.from({ length: 4 }, (_, i) => `| ${words(r, 2)} | ${i % 3 ? "pass" : "fail"} | ${(r() * 9).toFixed(1)} s |`)].join("\n");
    }
    parts.push(p);
    n += p.length + 2;
  }
  return parts.join("\n\n");
}

/** A build log of about `chars` characters. */
function buildLog(r, chars) {
  const lines = [];
  let n = 0;
  for (let i = 1; n < chars; i++) {
    const l = `[${i}/${Math.ceil(chars / 70)}] Building C object CMakeFiles/app.dir/${FILES[i % FILES.length].replace(/\..*$/, "")}_${i}.c.obj ${words(r, 3)}`;
    lines.push(l);
    n += l.length + 1;
  }
  return lines.join("\n");
}

const QUIET = [
  (r, i) => ({ name: "Bash", input: { command: `west build -b dev_board app -- -DSTEP=${i}`, description: "Build the app for the dev board" }, out: `-- west build: building application\n[${i}/180] Linking C executable zephyr/zephyr.elf\nMemory region  Used Size\nFLASH: ${200 + i} KB` }),
  (r, i) => ({ name: "Bash", input: { command: "west flash --runner jlink", description: "Flash the board" }, out: `-- runners.jlink: Flashing file: build/zephyr/zephyr.hex\n-- runners.jlink: reset after flashing requested\nflash ${i} ok` }),
  (r, i) => ({ name: "Bash", input: { command: `timeout 5 cat /dev/ttyACM0 | head -${20 + (i % 30)}`, description: "Read the serial console" }, out: Array.from({ length: 20 }, (_, k) => `[00:00:0${k % 10}.${(k * 37) % 1000}] <inf> app: ${words(r, 6)}`).join("\n") }),
  (r, i) => ({ name: "Read", input: { file_path: `/work/fw/app/${FILES[i % FILES.length]}` }, out: Array.from({ length: 40 }, (_, k) => `${k + 1}\t${words(r, 7)}`).join("\n") }),
  (r) => ({ name: "Grep", input: { pattern: words(r, 1), path: "/work/fw/app/src" }, out: `Found 3 files\nsrc/main.c\nsrc/sensor.c\nsrc/power.c` }),
  (r, i) => ({ name: "mcp__embarch-api__serial_log", input: { port: "COM7", seconds: 5 }, out: `${i}: ${sentence(r)}\n${sentence(r)}` }),
];

/**
 * The chat's wire lines, as the host would fold them for a snapshot: `turns`
 * of the owner's messages, `steps` tool calls spread over them, `big` of
 * them build logs of `bigChars` characters.
 */
export function longSession({ turns = 60, steps = 600, big = 6, bigChars = 100_000, seed = 85 } = {}) {
  const r = rng(seed);
  const lines = [];
  const t0 = Date.parse("2026-10-20T08:00:00.000Z");
  let clock = t0;
  const ts = (ms = 2000) => new Date((clock += ms)).toISOString();
  let tool = 0;
  const bigAt = new Set(Array.from({ length: big }, (_, i) => Math.floor(((i + 0.5) * steps) / big)));
  lines.push({ type: "system", subtype: "init", session_id: "perf", cwd: "/work/fw/app", model: "claude-opus-4", permissionMode: "auto", tools: ["Bash", "Read", "Grep", "Edit"], slash_commands: ["compact"] });
  for (let t = 0; t < turns; t++) {
    lines.push({ type: "user", message: { role: "user", content: `Turn ${t + 1}: ${sentence(r, 10 + Math.floor(r() * 20))}` }, uuid: `00000000-0000-4000-8000-${String(t + 1).padStart(12, "0")}`, timestamp: ts() });
    // The turn's share of the steps, uneven: some turns are one flash, some a long debugging loop.
    const n = t === turns - 1 ? steps - tool : Math.max(0, Math.min(steps - tool, Math.round((steps / turns) * (0.3 + r() * 1.4))));
    let m = 0;
    const msg = () => `msg_${t}_${m++}`;
    lines.push({ type: "assistant", message: { id: msg(), content: [{ type: "text", text: sentence(r) }] }, timestamp: ts() });
    for (let k = 0; k < n; k++, tool++) {
      const id = `toolu_perf_${String(tool).padStart(4, "0")}`;
      if (r() < 0.25) lines.push({ type: "assistant", message: { id: msg(), content: [{ type: "thinking", thinking: sentence(r, 30) }] }, timestamp: ts(300) });
      // Now and then an edit: it stands alone, and ends the run before it.
      const edit = k > 0 && k % 7 === 0;
      const step = edit
        ? { name: "Edit", input: { file_path: `/work/fw/app/${FILES[tool % FILES.length]}`, old_string: `${words(r, 6)}\n${words(r, 5)}`, new_string: `${words(r, 6)}\n${words(r, 7)}\n${words(r, 3)}` }, out: "The file has been updated." }
        : QUIET[Math.floor(r() * QUIET.length)](r, tool);
      if (bigAt.has(tool) && !edit) {
        step.name = "Bash";
        step.input = { command: "west build -p always -b dev_board app", description: "Rebuild from scratch" };
        step.out = buildLog(r, bigChars);
      }
      lines.push({ type: "assistant", message: { id: msg(), content: [{ type: "tool_use", id, name: step.name, input: step.input }] }, timestamp: ts(500) });
      const err = !edit && r() < 0.04;
      lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: err ? `Exit code 1\n${sentence(r)}` : step.out, is_error: err }] }, timestamp: ts(1500 + Math.floor(r() * 9000)) });
    }
    lines.push({ type: "assistant", message: { id: msg(), content: [{ type: "text", text: markdownReply(r, 400 + Math.floor(r() * (t % 5 === 0 ? 8000 : 2500))) }] }, timestamp: ts() });
    lines.push({ type: "result", subtype: "success", is_error: false, result: "", session_id: "perf" });
  }
  return lines;
}

/**
 * A reply streaming in: `chars` of Markdown in deltas of about `delta`
 * characters, then the finished message — the lines a live turn brings,
 * one host update each.
 */
export function streamedReply({ chars = 20_000, delta = 24, seed = 86, id = "msg_live" } = {}) {
  const r = rng(seed);
  const text = markdownReply(r, chars);
  const lines = [
    { type: "stream_event", event: { type: "message_start", message: { id } }, parent_tool_use_id: null },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null },
  ];
  for (let i = 0; i < text.length; ) {
    const n = Math.max(1, Math.round(delta * (0.5 + r())));
    lines.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + n) } }, parent_tool_use_id: null });
    i += n;
  }
  const done = [
    { type: "assistant", message: { id, content: [{ type: "text", text }] } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null },
    { type: "result", subtype: "success", is_error: false, result: "", session_id: "perf" },
  ];
  return { text, deltas: lines, done };
}

// ------------------------------------------------------------ measuring, page side

/**
 * WebDriver async scripts that time the page. Each host message is
 * dispatched as the host's would arrive, and timed from the dispatch (the
 * reducer) through the page's next frame — its render and a forced layout —
 * to a frame callback registered after the page's own; a callback
 * registered before it marks where that frame's work starts, so the wait
 * for the frame is not counted. Paint is not: no page can time it.
 */
export const MEASURE_OPEN = `const [msg, done] = arguments;
const t0 = performance.now();
window.dispatchEvent(new MessageEvent("message", { data: msg }));
requestAnimationFrame(() => {
  const b = performance.now();
  void document.body.offsetHeight;
  const c = performance.now();
  setTimeout(() => done({ ms: c - t0, layout: c - b, nodes: document.getElementsByTagName("*").length }), 150);
});`;

/**
 * Times each message on its own frame: `work` per update, of it `layout`
 * (the rest is script: the reducer and the render), and `gaps` between the
 * frames that showed them.
 */
export const MEASURE_UPDATES = `const [msgs, done] = arguments;
const work = [], layout = [], gaps = [];
let i = 0, prev = null;
const step = () => {
  if (i >= msgs.length) return done({ work, layout, gaps, nodes: document.getElementsByTagName("*").length });
  let a = 0, b = 0;
  requestAnimationFrame(() => { a = performance.now(); });
  const t0 = performance.now();
  window.dispatchEvent(new MessageEvent("message", { data: msgs[i++] }));
  const r = performance.now() - t0;
  requestAnimationFrame(() => { b = performance.now(); });
  requestAnimationFrame((ts) => {
    void document.body.offsetHeight;
    const c = performance.now();
    work.push(r + c - a);
    layout.push(c - b);
    if (prev !== null) gaps.push(ts - prev);
    prev = ts;
    setTimeout(step, 0);
  });
};
step();`;

export function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
}
