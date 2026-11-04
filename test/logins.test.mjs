// Which login and desk a window's chats use, and what that does to their environment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as os from "node:os";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const home = os.homedir();

const rules = [
  { folder: "~/Github/embarch", login: "personal", desk: "dev" },
  { folder: "/srv/other/", login: "other" },
];
const logins = { work: {}, personal: { configDir: "~/.claude-personal" } };
const desks = { dev: { url: "http://127.0.0.1:4892", tokenPath: "~/t", env: { EMBARCH_DESK_DATA_DIR: "~/.local/share/dev", PLAIN: "1" } } };

test("a folder rule applies to its folder and what is under it, never to a name that only starts the same", () => {
  assert.equal(core.matchFolderRule(rules, [`${home}/Github/embarch`])?.login, "personal");
  assert.equal(core.matchFolderRule(rules, ["/tmp/x", `${home}/Github/embarch/.dev-worktrees/a/embarch-ui`])?.login, "personal");
  assert.equal(core.matchFolderRule(rules, [`${home}/Github/embarch-other`]), null);
  assert.equal(core.matchFolderRule(rules, ["/srv/other/repo"])?.login, "other");
  assert.equal(core.matchFolderRule(rules, []), null);
});

test("the picked login wins over the folder rule, and a name no longer configured counts as unset", () => {
  assert.equal(core.currentLogin(undefined, null, logins), "work");
  assert.equal(core.currentLogin(undefined, rules[0], logins), "personal");
  assert.equal(core.currentLogin("work", rules[0], logins), "work");
  assert.equal(core.currentLogin("gone", rules[0], logins), "personal");
  assert.equal(core.currentLogin(undefined, rules[1], logins), "work");
});

test("a rule with no desk, or one not configured, stays on the default desk", () => {
  assert.equal(core.ruleDesk(rules[0], desks), desks.dev);
  assert.equal(core.ruleDesk(rules[1], desks), null);
  assert.equal(core.ruleDesk({ folder: "/x", login: "work", desk: "gone" }, desks), null);
  assert.equal(core.ruleDesk(null, desks), null);
});

test("the default login leaves the environment as it was; another sets its folder and the desk's variables, with ~/ expanded", () => {
  const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: undefined };
  assert.deepEqual(core.loginEnv(base, logins.work, null), base);
  const env = core.loginEnv(base, logins.personal, desks.dev);
  assert.equal(env.CLAUDE_CONFIG_DIR, `${home}/.claude-personal`);
  assert.equal(env.EMBARCH_DESK_DATA_DIR, `${home}/.local/share/dev`);
  assert.equal(env.PLAIN, "1");
  assert.equal(env.PATH, "/bin");
  assert.equal(base.CLAUDE_CONFIG_DIR, undefined);
});
