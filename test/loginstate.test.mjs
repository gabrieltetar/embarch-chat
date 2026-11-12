// One pick decides a window's login for every Claude surface in it, and a
// chat keeps the login it started on (decision 106): the file shared with
// claude-login, the order a chat's login is chosen in, a resume through
// ChatManager, and the status item's account and its warning.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const home = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-logins-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
// A past chat is looked for in a scratch config folder, never the real one.
process.env.CLAUDE_CONFIG_DIR = path.join(ROOT, "claude");
let n = 0;
const stateFile = () => path.join(ROOT, `s${++n}`, "logins.json");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const empty = () => ({ logins: {}, folders: {}, sessions: {} });

const WORK = path.join(ROOT, "work");
const PERSONAL = path.join(ROOT, "personal");
const two = { work: { configDir: WORK }, personal: { configDir: PERSONAL } };
const sid = () => crypto.randomUUID();

test("a chat's login: its own record, else the chat it carries on from, else the window's; a name no longer configured is no record", () => {
  const [a, b, c] = [sid(), sid(), sid()];
  const s = { ...empty(), sessions: { [a]: "work", [b]: "gone" } };
  assert.deepEqual(core.chatLogin(s, a, null, "personal", two), { login: "work", recorded: true });
  assert.deepEqual(core.chatLogin(s, c, a, "personal", two), { login: "work", recorded: false }, "a fork or handoff takes its parent's");
  assert.deepEqual(core.chatLogin(s, c, null, "personal", two), { login: "personal", recorded: false });
  assert.deepEqual(core.chatLogin(s, b, null, "personal", two), { login: "personal", recorded: false }, "a login removed from settings");
  assert.deepEqual(core.chatLogin({ ...s, sessions: { [c]: "personal", [a]: "work" } }, c, a, "work", two), { login: "personal", recorded: true }, "its own record before its parent's");
});

test("resolving puts the answer on record only when asked, and the record then wins over a new pick", () => {
  const file = stateFile();
  const a = sid();
  assert.equal(core.resolveChatLogin(file, a, null, "work", two, false), "work");
  assert.ok(!fs.existsSync(file), "a read-only view writes nothing");
  assert.equal(core.resolveChatLogin(file, a, null, "work", two, true), "work");
  assert.equal(read(file).sessions[a], "work");
  assert.equal(core.resolveChatLogin(file, a, null, "personal", two, true), "work", "picked personal since: the chat keeps work");
  assert.equal(core.resolveChatLogin(file, a, null, "personal", two, false), "work");
});

test("with one login there is nothing to pick or record", () => {
  const file = stateFile();
  assert.equal(core.resolveChatLogin(file, sid(), null, "work", { work: {} }, true), "work");
  assert.ok(!fs.existsSync(file));
  const s = empty();
  assert.equal(core.mirrorWindow(s, { work: {} }, ["/w"], "work"), false);
  assert.deepEqual(s, empty());
});

test("a window's pick is mirrored for each of its folders, and taken out when it has none", () => {
  const s = empty();
  const logins = { work: {}, personal: { configDir: "~/.claude-personal" } };
  assert.equal(core.mirrorWindow(s, logins, ["/a", "/b"], "personal"), true);
  assert.deepEqual(s.folders, { "/a": "personal", "/b": "personal" });
  assert.deepEqual(s.logins, { work: null, personal: `${home}/.claude-personal` }, "absolute, null for the CLI's default");
  assert.equal(core.mirrorWindow(s, logins, ["/a", "/b"], "personal"), false, "nothing to write");
  s.folders["/other"] = "work";
  assert.equal(core.mirrorWindow(s, logins, ["/a"], null), true);
  assert.deepEqual(s.folders, { "/b": "personal", "/other": "work" }, "only this window's folders move");
  assert.equal(core.mirrorWindow(s, logins, ["/b"], "gone"), true, "a pick no longer configured is no pick");
  assert.deepEqual(s.folders, { "/other": "work" });
  assert.equal(core.mirrorWindow(s, { work: {} }, ["/other"], "work"), true, "down to one login: the window's entries go");
  assert.deepEqual(s.folders, {});
});

test("the file is written whole, survives garbage, and keeps the newest chats", () => {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(core.readLoginState(file), empty());
  fs.writeFileSync(file, JSON.stringify({ logins: { a: "/a", b: 3 }, folders: [], sessions: { x: "a", y: null } }));
  assert.deepEqual(core.readLoginState(file), { logins: { a: "/a" }, folders: {}, sessions: { x: "a" } });
  core.updateLoginState(file, (s) => core.mirrorWindow(s, two, ["/w"], "work"));
  assert.deepEqual(read(file).folders, { "/w": "work" });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["logins.json"], "no temporary file left");
  const s = empty();
  for (let i = 0; i < core.SESSIONS_KEPT + 2; i++) core.recordSession(s, `id${i}`, "work");
  const ids = Object.keys(s.sessions);
  assert.equal(ids.length, core.SESSIONS_KEPT);
  assert.equal(ids[0], "id2", "the oldest go first");
});

test("a resumed chat keeps the login it started on, whatever the window picks since", () => {
  const file = stateFile();
  let picked = "work";
  const settings = () => ({
    claudePath: "/bin/false",
    idleMs: 60_000,
    log: () => {},
    env: (id, from, keep) => core.loginEnv({}, two[core.resolveChatLogin(file, id, from, picked, two, keep)], null),
  });
  const dir = (rec) => rec.chat.opts.env.CLAUDE_CONFIG_DIR;

  // Started on work in one window, which then closes.
  const started = sid();
  const first = new core.ChatManager(settings);
  assert.equal(dir(first.create(started, ROOT, null, null)), WORK);
  first.dispose();

  // A forked chat keeps its parent's login, not the window's.
  picked = "personal";
  const second = new core.ChatManager(settings);
  assert.equal(dir(second.create(sid(), ROOT, null, null, { fork: { from: started, at: sid() } })), WORK);
  assert.equal(dir(second.create(sid(), ROOT, null, null, { loginFrom: started })), WORK, "a handoff's fresh session too");
  assert.equal(dir(second.create(sid(), ROOT, null, null)), PERSONAL, "a new chat takes the window's pick");

  // Opened from the list where personal is picked, and resumed.
  const viewed = second.openViewer(started, ROOT, null, null, true);
  assert.equal(dir(viewed), WORK);
  assert.equal(dir(second.adopt(started)), WORK);

  // A past chat with no record: viewing it records nothing; resuming it records the window's.
  const past = sid();
  second.openViewer(past, ROOT, null, null, true);
  assert.equal(read(file).sessions[past], undefined);
  assert.equal(dir(second.adopt(past)), PERSONAL);
  assert.equal(read(file).sessions[past], "personal");
  second.dispose();
});

/** A login folder whose CLI config names `account`; made-up people and organisations. */
function loginFolder(name, account) {
  const d = path.join(ROOT, `acct-${name}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, ".claude.json"), JSON.stringify({ numStartups: 3, ...(account ? { oauthAccount: account } : {}) }));
  return d;
}

test("the item names the account in the login's folder, and warns while two labels hold one", () => {
  const alice = { accountUuid: "u1", emailAddress: "alice@example.com", organizationUuid: "o1", organizationName: "Example Org" };
  const work = core.readAccount(loginFolder("w", alice));
  const personal = core.readAccount(loginFolder("p", { ...alice, organizationUuid: "o2", organizationName: "Alice" }));
  assert.equal(work.email, "alice@example.com");
  assert.equal(core.readAccount(loginFolder("none", null)), null);
  assert.equal(core.readAccount(path.join(ROOT, "missing")), null);
  assert.equal(core.accountFile(undefined), path.join(home, ".claude.json"), "the CLI's default keeps it beside its folder");

  // One person in two organisations is two accounts.
  let item = core.loginItem("work", { work, personal });
  assert.equal(item.text, "$(account) work · Example Org");
  assert.match(item.tooltip, /alice@example\.com \(Example Org\)/);
  assert.equal(item.warn, false);

  // A /login on the personal label signed in to the work account.
  const again = core.readAccount(loginFolder("p2", alice));
  item = core.loginItem("personal", { work, personal: again });
  assert.equal(item.text, "$(warning) personal · Example Org");
  assert.match(item.tooltip, /work and personal hold the same account: alice@example\.com \(Example Org\)/);
  assert.equal(item.warn, true);
  assert.deepEqual(core.sharedAccounts({ work, personal: again, spare: null }), [["work", "personal"]]);

  item = core.loginItem("spare", { work, spare: null });
  assert.equal(item.text, "$(account) spare · not logged in");
});
