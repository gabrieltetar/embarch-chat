// An issue's status ends its chat (decision 104): the `end` and `unfinished`
// mailbox entries, a turn that holds an `end` back, a reload that keeps it,
// and a chat that never starts a process after it. A fake desk's entries and a
// fake Memento: no desk, no folder removed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const core = require("../test-out/core.js");
const FAKE = path.join(here, "fake-claude.mjs");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-ending-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const memento = (init = {}) => {
  const data = { ...init };
  return { data, get: (k) => data[k], update: async (k, v) => void (data[k] = v) };
};
const entry = (kind, over = {}) => ({ id: `m-${kind}`, kind, folder: "/work/x", item_id: "i1", issue_key: "ABC-123", created_ms: 1, expires_ms: 2, taken_ms: 3, ...over });
const end = (outcome = "done") => entry("end", { outcome });
const unfinished = (blockers = [{ repo: "embarch-chat", reason: "2 commits not pushed" }]) => entry("unfinished", { blockers });

test("an end for each outcome shows the exact message, and is kept", async () => {
  for (const [outcome, text] of [["done", "Chat has ended because the issue is done"], ["canceled", "Chat has ended because the issue is canceled"]]) {
    const mem = memento();
    const e = new core.Endings(mem, () => true);
    const seen = [];
    e.on("changed", (id) => seen.push(id));
    assert.equal(e.receive(end(outcome)), true);
    assert.deepEqual(e.get("i1"), { kind: "ended", outcome, message: text });
    assert.ok(e.ended("i1"));
    assert.equal(e.get("other"), null);
    assert.deepEqual(seen, ["i1"]);
    // A window reload: a new Endings on the same memory.
    const after = new core.Endings(mem, () => true);
    assert.deepEqual(after.get("i1"), { kind: "ended", outcome, message: text });
    assert.ok(after.ended("i1"));
  }
});

test("with a turn running, the end waits for the turn to finish", () => {
  let idle = false;
  const e = new core.Endings(memento(), () => idle);
  const seen = [];
  e.on("changed", (id) => seen.push(id));
  e.receive(end("canceled"));
  assert.equal(e.get("i1"), null, "nothing shows mid-turn");
  assert.ok(e.waiting("i1"));
  e.settle();
  assert.equal(e.get("i1"), null, "still mid-turn");
  idle = true;
  e.settle();
  assert.equal(e.get("i1").kind, "ended");
  assert.ok(!e.waiting("i1"));
  assert.deepEqual(seen, ["i1"]);
});

test("a second end changes nothing; an unfinished after an end changes nothing", () => {
  const e = new core.Endings(memento(), () => true);
  const seen = [];
  e.on("changed", (id) => seen.push(id));
  e.receive(end("done"));
  assert.equal(e.receive(end("canceled")), false);
  assert.equal(e.receive(unfinished()), false);
  assert.equal(e.get("i1").outcome, "done");
  assert.deepEqual(seen, ["i1"]);
});

test("an unfinished shows each blocker and leaves the chat live; a later one replaces it, and an end replaces it", () => {
  const e = new core.Endings(memento(), () => false);
  e.receive(unfinished());
  assert.deepEqual(e.get("i1"), { kind: "unfinished", blockers: [{ repo: "embarch-chat", reason: "2 commits not pushed" }] });
  assert.ok(!e.ended("i1"), "the chat takes input");
  // Mid-turn, an unfinished shows at once: only an end waits.
  e.receive(unfinished([{ repo: "embarch-desk", reason: "branch not merged" }, { repo: "embarch-doc", reason: "dirty" }]));
  assert.deepEqual(e.get("i1").blockers.map((b) => b.repo), ["embarch-desk", "embarch-doc"]);
  e.receive(end());
  assert.ok(e.waiting("i1"));
  // A newer unfinished replaces an end that still waits.
  e.receive(unfinished([{ repo: "embarch-doc", reason: "dirty" }]));
  assert.ok(!e.waiting("i1"));
  assert.equal(e.get("i1").kind, "unfinished");
});

test("entries that do not say what they must change nothing", () => {
  const e = new core.Endings(memento(), () => true);
  assert.equal(e.receive(entry("end", { outcome: "wontfix" })), false);
  assert.equal(e.receive(entry("end", { item_id: undefined, outcome: "done" })), false);
  assert.equal(e.receive(entry("unfinished", { blockers: "none" })), false);
  assert.equal(e.receive(entry("focus")), false);
  assert.equal(e.get("i1"), null);
  // An unfinished with junk among its blockers keeps the good ones.
  e.receive(entry("unfinished", { blockers: [{ repo: "r" }, { repo: "a", reason: "b" }, null] }));
  assert.deepEqual(e.get("i1").blockers, [{ repo: "a", reason: "b" }]);
  assert.ok(core.isEndingEntry(end()) && core.isEndingEntry(unfinished()) && !core.isEndingEntry(entry("start")));
});

test("an ended chat starts no process and sends nothing, however it is asked", async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "chat-"));
  const argsLog = path.join(dir, "args.jsonl");
  const chat = new core.Chat({
    sessionId: "11111111-2222-4333-8444-555555555555",
    cwd: dir,
    claudePath: FAKE,
    existing: true,
    idleMs: 60000,
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: path.join(here, "fixtures", "wire", "basic.jsonl"), FAKE_CLAUDE_ARGS_LOG: argsLog },
  });
  assert.ok(!chat.hasEnded);
  chat.end();
  assert.ok(chat.hasEnded);
  chat.end();
  chat.send("one more thing");
  chat.continueInterrupted();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(argsLog), "no claude was started");
  assert.ok(!chat.running);
  const notes = chat.state.timeline.map((id) => chat.state.entries[id]).filter((x) => x.kind === "note");
  assert.ok(notes.some((n) => /ended/.test(n.text)), "the owner is told");
  chat.dispose();
});

test("an ended chat is never adopted: a viewer stays read-only and is not resumed", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "mgr-"));
  const manager = new core.ChatManager(() => ({ claudePath: FAKE, idleMs: 60000, log: () => {} }));
  const sid = "11111111-2222-4333-8444-5555555555aa";
  const rec = manager.openViewer(sid, dir, "i1", "Item", true);
  assert.ok(rec);
  const mem = memento();
  const e = new core.Endings(mem, () => true);
  manager.isEnded = (r) => e.ended(r.itemId);
  assert.equal(manager.adopt(sid)?.ours, true, "before the end it resumes");
  rec.ours = false;
  rec.viewer = true;
  e.receive(end());
  assert.equal(manager.adopt(sid), null, "after it does not");
  manager.dispose();
});
