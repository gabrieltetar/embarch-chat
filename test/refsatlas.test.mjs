// The linker's datasheet and spec section source (decision 114), against a
// fake `embarch-atlas` (fake-atlas.mjs) and a scratch repo with an atlas folder.

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
const FAKE = path.join(here, "fake-atlas.mjs");
fs.chmodSync(FAKE, 0o755);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-refsatlas-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function repo(withAtlas = true) {
  const r = fs.mkdtempSync(path.join(ROOT, "repo-"));
  if (withAtlas) {
    const a = path.join(r, "embarch", "atlas");
    fs.mkdirSync(path.join(a, "docs", "tps2595@A"), { recursive: true });
    fs.mkdirSync(path.join(a, "atlases"), { recursive: true });
    fs.writeFileSync(path.join(a, "current.json"), "{}");
  }
  return r;
}

/** Reads the repo with the fake, then the block's lines for a draft. */
async function lines(folder, draft, reader = new core.AtlasRefs(), logs = []) {
  process.env.FAKE_ATLAS_LOG = path.join(folder, "calls.jsonl");
  await reader.refresh(folder, FAKE, (s) => logs.push(s));
  return core.linkReferences([core.atlasSource(reader.get(folder), draft)], draft).map((r) => r.line);
}

test("a cue word and a title word offer the section, written as a citation head, section and title", async () => {
  const r = repo();
  assert.deepEqual(await lines(r, "check the protection section of the switch datasheet"), ['tps2595@A p14 §7.3 "Protection features"', 'nrf54l15-rm@B p131 §6.9 "Protection of the peripheral bus"']);
  const calls = fs.readFileSync(path.join(r, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.args), [["refs", "--json"]]);
  assert.equal(fs.realpathSync(calls[0].cwd), fs.realpathSync(r));
});

test("the written head is what decision 16's citation link matches, and the card writes the whole line", async () => {
  const r = repo();
  const reader = new core.AtlasRefs();
  const refs = core.linkReferences([core.atlasSource((await lines(r, "x", reader), reader.get(r)), "the tps2595 protection section")], "the tps2595 protection section");
  const text = core.referenceText(refs.find((x) => x.line.startsWith("tps2595")), "the tps2595 protection section");
  assert.equal(text, 'tps2595@A p14 §7.3 "Protection features"');
  // webview/chat/atlas.tsx: `(<doc_id>)\s+p\.?\s?(\d{1,4})\b` over the chat's repo's doc ids.
  const re = new RegExp("(tps2595@A|nrf54l15-rm@B)" + "\\s+p\\.?\\s?(\\d{1,4})\\b");
  const m = re.exec(text);
  assert.deepEqual([m[1], m[2]], ["tps2595@A", "14"]);
  // The doc ids are what the atlas folder's docs/ holds, so the host knows them as the link does.
  assert.ok(core.atlasInfo(r).docs.includes("tps2595@A"));
});

test("a part named in the draft opens the gate for that document alone", async () => {
  const r = repo();
  assert.deepEqual(await lines(r, "the TPS2595 protection"), ['tps2595@A p14 §7.3 "Protection features"']);
});

test("no cue word and no part name: no section line", async () => {
  const r = repo();
  assert.deepEqual(await lines(r, "tune the protection and the clock control for the board"), []);
});

test("no binary, an atlas-less folder, and a failing run each give no line and one log line", async () => {
  const draft = "check the protection section of the datasheet";
  const r = repo();
  let logs = [];
  const reader = new core.AtlasRefs();
  await reader.refresh(r, path.join(r, "missing-bin"), (s) => logs.push(s));
  await reader.refresh(r, path.join(r, "missing-bin"), (s) => logs.push(s));
  assert.equal(logs.length, 1, logs.join("|"));
  assert.deepEqual(core.linkReferences([core.atlasSource(reader.get(r), draft)], draft), []);

  logs = [];
  const bare = repo(false);
  const r2 = new core.AtlasRefs();
  assert.deepEqual(await lines(bare, draft, r2, logs), []);
  await lines(bare, draft, r2, logs);
  assert.equal(logs.length, 1, logs.join("|"));

  logs = [];
  process.env.FAKE_ATLAS_FAIL = "no such thing";
  try {
    const r3 = new core.AtlasRefs();
    assert.deepEqual(await lines(r, draft, r3, logs), []);
    assert.equal(logs.length, 1, logs.join("|"));
    assert.match(logs[0], /failed \(exit 3\): embarch-atlas: no such thing/);
    process.env.FAKE_ATLAS_FAIL = "";
    process.env.FAKE_ATLAS_JUNK = "1";
    const r4 = new core.AtlasRefs();
    logs = [];
    assert.deepEqual(await lines(r, draft, r4, logs), []);
    assert.equal(logs.length, 1);
  } finally {
    delete process.env.FAKE_ATLAS_FAIL;
    delete process.env.FAKE_ATLAS_JUNK;
  }
});

test("a run past the limit is a failure", async () => {
  const slow = path.join(ROOT, "slow.sh");
  fs.writeFileSync(slow, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const r = repo();
  const logs = [];
  const reader = new core.AtlasRefs();
  await reader.refresh(r, slow, (s) => logs.push(s), 200);
  assert.equal(reader.get(r), null);
  assert.match(logs[0], /took over/);
});

test("two cards calls with no atlas change run the verb once; a change runs it again", async () => {
  const r = repo();
  const reader = new core.AtlasRefs();
  await lines(r, "the datasheet section", reader);
  await lines(r, "the datasheet section", reader);
  assert.equal(reader.spawns, 1);
  const cur = path.join(r, "embarch", "atlas", "current.json");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(cur, later, later);
  await lines(r, "the datasheet section", reader);
  assert.equal(reader.spawns, 2);
  fs.mkdirSync(path.join(r, "embarch", "atlas", "docs", "newdoc@1"));
  await lines(r, "the datasheet section", reader);
  assert.equal(reader.spawns, 3);
});
