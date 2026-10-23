#!/usr/bin/env node
// A stand-in `claude` that replays one recorded stream-json session
// (test/fixtures/wire/*.jsonl, from record.mjs) against whatever drives it.
//
// It writes the recorded output lines in order and, at each recorded input,
// waits for the client to send a line of the same kind — checking that a
// permission answer has the recorded behavior, so a test fails when the
// panel answers differently from the real session. Session and request ids
// are rewritten to the client's own. A control request the recording does
// not expect next (the panel's own context-meter refresh, say) gets a canned
// answer instead of failing.
//
// Env: FAKE_CLAUDE_FIXTURE (the recording), FAKE_CLAUDE_ARGS_LOG (a file each
// invocation appends its argv to as one JSON line), FAKE_CLAUDE_VERSION.

import * as fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.287"} (Claude Code)\n`);
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_ARGS_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: { EMBARCH_DESK_INTERNAL: process.env.EMBARCH_DESK_INTERNAL ?? null } }) + "\n");
}

const fixture = process.env.FAKE_CLAUDE_FIXTURE;
const entries = fs
  .readFileSync(fixture, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

let sid = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--session-id") sid = argv[i + 1];
  if (argv[i].startsWith("--resume=")) sid = argv[i].slice(9);
  if (argv[i] === "--resume") sid = argv[i + 1];
}
const recordedSid = entries.find((e) => e.d === "out" && e.o.session_id)?.o.session_id;

const fail = (msg) => {
  process.stderr.write(`fake-claude: ${msg}\n`);
  process.exit(3);
};

let pos = 0;
const idMap = new Map(); // recorded request id -> the client's
const queue = [];
let wake = null;
let stdinEnded = false;

const subtypeOf = (o) => o.request?.subtype ?? o.response?.subtype;
const nextIn = () => entries.slice(pos).find((e) => e.d === "in")?.o;

function cannedAnswer(o) {
  const st = o.request?.subtype;
  const response =
    st === "get_context_usage"
      ? { categories: [{ name: "Messages", tokens: 1000, kind: "used" }], totalTokens: 1000, maxTokens: 200000, percentage: 1 }
      : st === "set_permission_mode"
        ? { mode: o.request.mode }
        : {};
  write({ type: "control_response", response: { subtype: "success", request_id: o.request_id, response } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    const want = nextIn();
    if (o.type === "control_request" && !(want && want.type === "control_request" && want.request?.subtype === o.request?.subtype)) {
      cannedAnswer(o);
      continue;
    }
    queue.push(o);
    if (wake) wake();
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (wake) wake();
});

function write(o) {
  let s = JSON.stringify(o);
  if (sid && recordedSid) s = s.split(recordedSid).join(sid);
  process.stdout.write(s + "\n");
}

async function nextInput() {
  while (!queue.length) {
    if (stdinEnded) return null;
    await new Promise((r) => (wake = r));
    wake = null;
  }
  return queue.shift();
}

for (; pos < entries.length; pos++) {
  const e = entries[pos];
  if (e.d === "out") {
    const o = structuredClone(e.o);
    if (o.type === "control_response" && o.response?.request_id && idMap.has(o.response.request_id)) {
      o.response.request_id = idMap.get(o.response.request_id);
    }
    write(o);
    await new Promise((r) => setImmediate(r));
    continue;
  }
  const got = await nextInput();
  if (!got) process.exit(0);
  const want = e.o;
  if (got.type !== want.type) fail(`expected ${want.type}/${subtypeOf(want)}, got ${got.type}/${subtypeOf(got)}: ${JSON.stringify(got).slice(0, 200)}`);
  if (want.type === "control_request") {
    if (got.request?.subtype !== want.request?.subtype) fail(`expected control ${want.request?.subtype}, got ${got.request?.subtype}`);
    idMap.set(want.request_id, got.request_id);
  }
  if (want.type === "control_response") {
    const w = want.response.response?.behavior;
    const g = got.response?.response?.behavior;
    if (got.response?.request_id !== want.response.request_id) fail(`answer for ${got.response?.request_id}, expected ${want.response.request_id}`);
    if (w !== g) fail(`permission answered ${g}, the recording answered ${w}`);
    if (want.response.response?.updatedInput?.answers && !got.response.response?.updatedInput?.answers) fail("a question answered without answers");
  }
}

// Recording done: stay up like the real CLI until stdin closes.
while (await nextInput()) {
  /* drain */
}
process.exit(0);
