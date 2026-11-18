// last_session: the previous session's last turns, read from synthetic transcripts in a temp projects/ tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const core = createRequire(import.meta.url)("../test-out/core.js");

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ls-"));
const line = (o) => JSON.stringify(o);
const user = (t) => line({ type: "user", message: { role: "user", content: t } });
const asst = (...blocks) => line({ type: "assistant", message: { role: "assistant", content: blocks } });
const write = (root, cwd, id, lines, ageMs) => {
  const dir = core.projectDir(cwd, root);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, lines.join("\n") + "\n");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
};
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { stdio: "ignore" });

test("the previous session's last turns, tool calls and pending background work, oldest first", () => {
  const root = tmp(), cwd = tmp();
  write(root, cwd, OLD, [
    user("first question"),
    asst({ type: "text", text: "first answer" }),
    user("run the build"),
    asst({ type: "tool_use", id: "t1", name: "Bash", input: { command: "make all " + "x".repeat(500), run_in_background: true } }),
    asst({ type: "tool_use", id: "t2", name: "Monitor", input: { description: "watch the log" } }),
    asst({ type: "tool_use", id: "t3", name: "Agent", input: { description: "side job", run_in_background: true } }),
    line({ type: "user", message: { role: "user", content: "<task-notification><tool-use-id>t3</tool-use-id><status>completed</status></task-notification>" } }),
    asst({ type: "text", text: "waiting on the build" }),
  ], 3_600_000);
  const s = core.lastSession({ cwd, turns: 2, root });
  assert.equal(s.sessionId, OLD);
  assert.deepEqual(s.items.map((i) => i.kind), ["user", "tool", "tool", "tool", "assistant"]);
  assert.ok(s.items[1].text.startsWith("Bash: ") && s.items[1].text.length < 400, "a tool call is its name and the start of its input");
  assert.ok(s.pending[0].startsWith("Bash: make all"));
  assert.equal(s.pending[1], "Monitor: watch the log");
  assert.equal(s.pending.length, 2, "the finished agent is not pending");
  assert.match(core.formatLastSession(s), /\[assistant\] waiting on the build/);
});

test("never the current session: by id when given", () => {
  const root = tmp(), cwd = tmp();
  write(root, cwd, OLD, [user("old one"), asst({ type: "text", text: "a" })], 3_600_000);
  write(root, cwd, NEW, [user("this session"), asst({ type: "text", text: "b" })], 1_000);
  const s = core.lastSession({ cwd, root, currentSessionId: NEW });
  assert.equal(s.sessionId, OLD);
  assert.equal(core.lastSession({ cwd, root, currentSessionId: OLD }).sessionId, NEW, "the id decides, not the age");
});

test("never the current session: without an id, a file still being written is refused", () => {
  const root = tmp(), cwd = tmp();
  write(root, cwd, OLD, [user("old one")], 3_600_000);
  write(root, cwd, NEW, [user("being written")], 1_000);
  assert.equal(core.lastSession({ cwd, root }).sessionId, OLD);
  const only = tmp();
  write(root, only, NEW, [user("being written")], 1_000);
  assert.equal(core.lastSession({ cwd: only, root }), null);
  assert.match(core.formatLastSession(null), /No previous session/);
});

test("from a worktree, a session filed under the main clone's folder is found; the worktree's own folder first", () => {
  const root = tmp(), main = tmp(), wt = path.join(tmp(), "wt");
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "x");
  git(main, "worktree", "add", "-q", "-b", "b", wt);
  assert.equal(core.mainClone(wt), main);
  assert.equal(core.mainClone(main), null);
  write(root, main, OLD, [user("from the main clone")], 3_600_000);
  const s = core.lastSession({ cwd: wt, root });
  assert.equal(s.sessionId, OLD);
  assert.equal(s.folder, "main-clone");
  write(root, wt, NEW, [user("from the worktree")], 3_600_000);
  assert.equal(core.lastSession({ cwd: wt, root }).sessionId, NEW);
});

test("the MCP tool answers for the chat's folder, and never with the chat's own session", async () => {
  const root = tmp(), cwd = tmp();
  write(root, cwd, OLD, [user("hello"), asst({ type: "text", text: "hi there" })], 3_600_000);
  write(root, cwd, NEW, [user("live")], 1_000);
  const server = core.mcpServer({ name: "p", version: "0" }, [{ ...core.LAST_SESSION_TOOL, call: core.lastSessionCall(cwd, NEW, root) }]);
  const r = await server({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "last_session", arguments: { turns: 1 } } });
  const text = r.result.content[0].text;
  assert.match(text, /hi there/);
  assert.doesNotMatch(text, /live/);
});

test("a chat on a configDir login reads that login's projects/ folder, not the host's", async () => {
  const login = tmp(), host = tmp(), cwd = tmp();
  const chat = new core.Chat({ sessionId: NEW, cwd, claudePath: "unused", existing: false, idleMs: 60000, env: { ...process.env, CLAUDE_CONFIG_DIR: login } });
  assert.equal(chat.projectsRoot, path.join(login, "projects"));
  write(chat.projectsRoot, cwd, OLD, [user("on the login"), asst({ type: "text", text: "login answer" })], 3_600_000);
  write(path.join(host, "projects"), cwd, "33333333-3333-4333-8333-333333333333", [user("on the host"), asst({ type: "text", text: "host answer" })], 3_600_000);
  const server = core.mcpServer({ name: "p", version: "0" }, [{ ...core.LAST_SESSION_TOOL, call: core.lastSessionCall(cwd, chat.sessionId, chat.projectsRoot) }]);
  const r = await server({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "last_session", arguments: {} } });
  const text = r.result.content[0].text;
  assert.match(text, /login answer/);
  assert.doesNotMatch(text, /host answer/);
});
