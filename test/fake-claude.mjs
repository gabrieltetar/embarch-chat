#!/usr/bin/env node
// A stand-in `claude` that replays one recorded stream-json session
// (test/fixtures/wire/*.jsonl, from record.mjs) against whatever drives it.
//
// It writes the recorded output lines in order and, at each recorded input,
// waits for the client to send a line of the same kind — checking that a
// permission answer has the recorded behavior, so a test fails when the
// panel answers differently from the real session. Session and request ids,
// and the uuids messages were sent with, are rewritten to the client's own.
// A control request the recording does not expect next (the panel's own
// context-meter refresh, say) gets a canned answer instead of failing.
//
// With -p it stands in for one of the Haiku assistant's calls instead
// (test/fixtures/haiku/*.jsonl, from record-haiku.mjs): it reads the prompt
// from stdin, picks the recording by the prompt's TASK line, and writes it.
//
// Env: FAKE_CLAUDE_FIXTURE (the recording), FAKE_CLAUDE_ARGS_LOG (a file each
// invocation appends its argv to as one JSON line, `--version` and `agents`
// too), FAKE_CLAUDE_VERSION, FAKE_CLAUDE_AGENTS (what `agents --json` lists),
// FAKE_CLAUDE_SIGNAL (dies by it on the first message), FAKE_CLAUDE_TRANSCRIPT
// ("queue" or "prompt": what the CLI writes to the session's transcript for
// each message, under $CLAUDE_CONFIG_DIR/projects — its queue lines, and
// with "prompt" the message too), FAKE_CLAUDE_STRICT (refuses an id as the
// CLI does: `--session-id` once the transcript exists, `--resume` while it
// holds no message);
// for -p, FAKE_HAIKU_DIR (default test/fixtures/haiku), FAKE_HAIKU_<TASK>
// (a recording for one task, e.g. FAKE_HAIKU_CARDS), FAKE_HAIKU_DELAY_MS
// (between lines, default 5); FAKE_CLAUDE_INPUT_LOG (each line the client
// sends, with how many lines had been written by then).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const logArgs = (extra = {}) => {
  if (process.env.FAKE_CLAUDE_ARGS_LOG) {
    const env = {
      EMBARCH_DESK_INTERNAL: process.env.EMBARCH_DESK_INTERNAL ?? null,
      CLAUDE_CODE_RESUME_INTERRUPTED_TURN: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ?? null,
      CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS ?? null,
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ?? null,
    };
    fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, JSON.stringify({ argv, cwd: process.cwd(), ...extra, env }) + "\n");
  }
};
if (argv.includes("--version")) {
  logArgs();
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.287"} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === "agents") {
  // FAKE_CLAUDE_AGENTS: the sessions running elsewhere, as `claude agents --json` lists them.
  logArgs();
  process.stdout.write((process.env.FAKE_CLAUDE_AGENTS ?? "[]") + "\n");
  process.exit(0);
}
if (argv.includes("-p")) {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const d of process.stdin) prompt += d;
  const task = /^TASK: (\S+)/m.exec(prompt)?.[1] ?? "none";
  logArgs({ prompt, task });
  const dir = process.env.FAKE_HAIKU_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "haiku");
  const file = process.env[`FAKE_HAIKU_${task.toUpperCase()}`] ?? path.join(dir, `${task}.jsonl`);
  if (!fs.existsSync(file)) {
    process.stderr.write(`fake-claude: no Haiku recording for ${task}\n`);
    process.exit(3);
  }
  const delay = Number(process.env.FAKE_HAIKU_DELAY_MS ?? 5);
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const e = JSON.parse(l);
    if (e.d !== "out") continue;
    process.stdout.write(JSON.stringify(e.o) + "\n");
    await new Promise((r) => setTimeout(r, delay));
  }
  process.exit(0);
}
logArgs();

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

// The session's transcript, where the CLI keeps it.
const transcript = sid && path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
const holdsMessage = (file) =>
  fs.existsSync(file) &&
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .some((l) => {
      try {
        return ["user", "assistant"].includes(JSON.parse(l).type);
      } catch {
        return false;
      }
    });
if (process.env.FAKE_CLAUDE_STRICT && transcript) {
  // As CLI 2.1.287 refuses them, before reading any input.
  if (argv.includes("--session-id") && fs.existsSync(transcript)) {
    process.stderr.write(`Error: Session ID ${sid} is already in use.\n`);
    process.exit(1);
  }
  if (!argv.includes("--session-id") && !holdsMessage(transcript)) {
    process.stderr.write(`No conversation found with session ID: ${sid}\n`);
    process.exit(1);
  }
}
function writeTranscript(o) {
  const mode = process.env.FAKE_CLAUDE_TRANSCRIPT;
  if (!mode || !transcript || o.type !== "user") return;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const at = new Date().toISOString();
  const content = typeof o.message?.content === "string" ? o.message.content : "";
  const lines = [
    { type: "queue-operation", operation: "enqueue", timestamp: at, sessionId: sid, content },
    { type: "queue-operation", operation: "dequeue", timestamp: at, sessionId: sid },
    ...(mode === "prompt" ? [{ type: "user", message: { role: "user", content }, sessionId: sid, timestamp: at }] : []),
  ];
  fs.appendFileSync(transcript, lines.map((l) => JSON.stringify(l) + "\n").join(""));
}

const fail = (msg) => {
  process.stderr.write(`fake-claude: ${msg}\n`);
  process.exit(3);
};

let pos = 0;
const idMap = new Map(); // recorded request id -> the client's
const uuidMap = new Map(); // a recorded message's uuid -> the one the client stamped it with
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
    if (process.env.FAKE_CLAUDE_INPUT_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_INPUT_LOG, JSON.stringify({ written, o }) + "\n");
    writeTranscript(o);
    // FAKE_CLAUDE_SIGNAL: dies by that signal on its first message (a crash, an OOM kill).
    if (process.env.FAKE_CLAUDE_SIGNAL && o.type === "user") process.kill(process.pid, process.env.FAKE_CLAUDE_SIGNAL);
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

let written = 0;
function write(o) {
  written++;
  let s = JSON.stringify(o);
  if (sid && recordedSid) s = s.split(recordedSid).join(sid);
  for (const [rec, got] of uuidMap) s = s.split(rec).join(got);
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
  // The CLI's queue knows a message by the uuid the client sent it with: its echo and command_lifecycle carry the client's.
  if (want.type === "user" && want.uuid && got.uuid) uuidMap.set(want.uuid, got.uuid);
  if (want.type === "control_request") {
    if (got.request?.subtype !== want.request?.subtype) fail(`expected control ${want.request?.subtype}, got ${got.request?.subtype}`);
    idMap.set(want.request_id, got.request_id);
  }
  if (want.type === "control_response") {
    // A permission's or a dialog's behavior, an elicitation's action, and an error answer's subtype (decision 66).
    const answerOf = (r) => r?.response?.behavior ?? r?.response?.action ?? (r?.subtype === "error" ? "error" : undefined);
    const w = answerOf(want.response);
    const g = answerOf(got.response);
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
