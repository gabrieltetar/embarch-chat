// Atlas citation targets (decision 16) on a scratch atlas.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

function scratchAtlas() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-atlas-"));
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
