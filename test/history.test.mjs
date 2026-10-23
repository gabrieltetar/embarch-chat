// A chat's history over the wire (decision 75), against recorded
// real sessions replayed by fake-claude.mjs: a name given by hand. Run with
// `npm test`.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fake-claude.mjs");
const fixture = (n) => path.join(here, "fixtures", "wire", `${n}.jsonl`);
fs.chmodSync(FAKE, 0o755);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-history-"));
const tmp = (prefix) => fs.mkdtempSync(path.join(ROOT, prefix));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const SID = "11111111-2222-4333-8444-555555555555";

function makeChat(name, opts = {}) {
  const dir = tmp("chat-");
  const argsLog = path.join(dir, "args.jsonl");
  const inputLog = path.join(dir, "in.jsonl");
  const chat = new core.Chat({
    sessionId: opts.sessionId ?? SID,
    cwd: opts.cwd ?? dir,
    claudePath: FAKE,
    existing: opts.existing ?? false,
    idleMs: opts.idleMs ?? 60000,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: fixture(name), FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_CLAUDE_INPUT_LOG: inputLog, ...(opts.env ?? {}) },
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { chat, dir, spawns: () => read(argsLog), inputs: () => read(inputLog).map((l) => l.o) };
}

const once = (em, ev) => new Promise((r) => em.once(ev, r));
const turns = (chat, n) =>
  new Promise((r) => {
    let k = 0;
    const f = (o) => {
      if (++k >= n) {
        chat.off("turn", f);
        r(o);
      }
    };
    chat.on("turn", f);
  });
const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const users = (s) => s.timeline.map((id) => s.entries[id]).filter((e) => e.kind === "user");

// ------------------------------------------------------------ a name by hand

test("a name given by hand to a running chat goes out with rename_session and stays", async () => {
  const { chat, inputs } = makeChat("controls");
  chat.send("@note.txt what is the secret? One word.");
  await turns(chat, 1);
  await chat.renameByHand("Widget blink bring-up");
  assert.equal(chat.state.title, "Widget blink bring-up");
  assert.ok(chat.handNamed && chat.renamed);
  assert.deepEqual(
    inputs()
      .filter((o) => o.request?.subtype === "rename_session")
      .map((o) => o.request.title),
    ["Widget blink bring-up"],
  );
  chat.dispose();
});

test("a closed chat's name by hand is Claude Code's custom-title line, and wins over a later ai-title", async () => {
  const config = tmp("config-");
  const cwd = tmp("work-");
  const file = core.transcriptPath(cwd, SID, path.join(config, "projects"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A transcript whose last line Claude did not end: the name still lands on a line of its own.
  fs.writeFileSync(file, [JSON.stringify({ type: "user", uuid: "aaaaaaaa-0000-4000-8000-000000000001", message: { role: "user", content: "hi" }, cwd }), JSON.stringify({ type: "ai-title", aiTitle: "Greeting" })].join("\n"));
  const { chat, spawns } = makeChat("basic", { existing: true, cwd, env: { CLAUDE_CONFIG_DIR: config } });
  await chat.renameByHand("Named by hand");
  assert.equal(spawns().length, 0, "no process started for a name");
  fs.appendFileSync(file, JSON.stringify({ type: "ai-title", aiTitle: "Claude renews its own" }) + "\n");
  const { meta } = core.readTranscript(file);
  assert.equal(meta.title, "Named by hand", "after a reload the list and the chat read it back");
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"custom-title"')).length, 1);
  chat.dispose();
});

test("a chat with no transcript yet keeps its name by hand until its first turn has ended", async () => {
  const { chat, inputs } = makeChat("basic");
  await chat.renameByHand("Before the first turn");
  assert.equal(chat.state.title, "Before the first turn");
  chat.send("Run the bash command `echo hello-from-bash` and then reply with just: done");
  await turns(chat, 1);
  await waitFor(() => inputs().some((o) => o.request?.subtype === "rename_session"));
  assert.equal(inputs().find((o) => o.request?.subtype === "rename_session").request.title, "Before the first turn");
  chat.dispose();
});
