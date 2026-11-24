// Atlas citation targets (decision 16) on a scratch atlas.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-atlas-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function scratchAtlas() {
  const repo = fs.mkdtempSync(path.join(ROOT, "repo-"));
  const a = path.join(repo, "embarch", "atlas");
  fs.mkdirSync(path.join(a, "docs", "abc123@A", "pages"), { recursive: true });
  fs.writeFileSync(path.join(a, "docs", "abc123@A", "card.md"), "# abc123\n");
  fs.writeFileSync(path.join(a, "docs", "abc123@A", "pages", "p012.txt"), "page twelve\n");
  fs.mkdirSync(path.join(a, "boards", "A"), { recursive: true });
  fs.writeFileSync(path.join(a, "boards", "A", "nets.md"), "# nets\n| VBUS | U3-12 | J1-1 |\n| GND | U3-1 |\n");
  fs.writeFileSync(path.join(a, "boards", "A", "parts.md"), "# parts\n| U7 | regulator |\n");
  fs.mkdirSync(path.join(repo, "src", "drivers"), { recursive: true });
  return repo;
}

test("the atlas is found above the chat's folder, with its doc ids and boards", () => {
  const repo = scratchAtlas();
  const info = core.atlasInfo(path.join(repo, "src", "drivers"));
  assert.equal(info.root, path.join(repo, "embarch", "atlas"));
  assert.deepEqual(info.docs, ["abc123@A"]);
  assert.deepEqual(info.boards, ["A"]);
  assert.equal(core.atlasInfo(os.tmpdir()), null);
});

test("a page cite opens the page's text, else the card; a board ref opens its line", () => {
  const repo = scratchAtlas();
  const info = core.atlasInfo(repo);
  assert.equal(core.citationTarget(info, { doc: "abc123@A", page: 12 }).file, path.join(info.root, "docs", "abc123@A", "pages", "p012.txt"));
  assert.equal(core.citationTarget(info, { doc: "abc123@A", page: 99 }).file, path.join(info.root, "docs", "abc123@A", "card.md"));
  assert.deepEqual(core.citationTarget(info, { board: "A", ref: "U3-12" }), { file: path.join(info.root, "boards", "A", "nets.md"), line: 2 });
  assert.deepEqual(core.citationTarget(info, { board: "A", ref: "U7" }), { file: path.join(info.root, "boards", "A", "parts.md"), line: 2 });
  assert.equal(core.citationTarget(info, { doc: "nope@1", page: 1 }), null);
});

function worktreeBeside(withAtlas) {
  const main = withAtlas ? scratchAtlas() : fs.mkdtempSync(path.join(ROOT, "repo-"));
  const git = (...a) => execFileSync("git", ["-C", main, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  const wt = path.join(ROOT, path.basename(main) + "-wt");
  git("worktree", "add", "-q", "-b", "wt", wt);
  return { main, wt };
}

test("a chat in a linked worktree finds the main clone's atlas; its own wins", () => {
  const { main, wt } = worktreeBeside(true);
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  const info = core.atlasInfo(path.join(wt, "src"));
  assert.equal(info.root, path.join(main, "embarch", "atlas"));
  assert.deepEqual(info.docs, ["abc123@A"]);
  assert.deepEqual(info.boards, ["A"]);
  const own = path.join(wt, "embarch", "atlas", "boards", "B");
  fs.mkdirSync(own, { recursive: true });
  assert.equal(core.atlasRoot(wt), path.join(wt, "embarch", "atlas"));
});

test("a worktree of a main clone with no atlas gives null", () => {
  const { wt } = worktreeBeside(false);
  assert.equal(core.atlasRoot(wt), null);
});
