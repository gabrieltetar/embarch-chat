// The linker's bench instruments (decision 116): `embarch-api --json
// list-instruments` through the runner (apiRun.ts), on a fake embarch-api
// (fake-api.mjs) that never reaches a Core.

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
const FAKE = path.join(here, "fake-api.mjs");
fs.chmodSync(FAKE, 0o755);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-refsapi-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const folder = (n) => fs.mkdirSync(path.join(ROOT, n), { recursive: true }) ?? path.join(ROOT, n);
const withEnv = async (env, fn) => {
  const was = {};
  for (const k of Object.keys(env)) {
    was[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) was[k] === undefined ? delete process.env[k] : (process.env[k] = was[k]);
  }
};
const logFile = (n) => path.join(ROOT, `${n}.log`);
const calls = (n) => (fs.existsSync(logFile(n)) ? fs.readFileSync(logFile(n), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
/** The block's lines for a draft, after a cards call's refresh. */
async function lines(runner, f, draft, now = 0, logs = []) {
  await runner.refresh(f, core.INSTRUMENTS_VERB, (s) => logs.push(s), now);
  const src = core.instrumentSource(core.parseInstruments(runner.get(f, core.INSTRUMENTS_VERB)), draft);
  return core.linkReferences([src], draft).map((r) => r.line);
}

test("a draft with an instrument word is offered every declared instrument, written with its protocol", async () => {
  const f = folder("a");
  await withEnv({ PATH: `${path.join(ROOT, "bin-a")}:${process.env.PATH}`, FAKE_API_LOG: logFile("a") }, async () => {
    fs.mkdirSync(path.join(ROOT, "bin-a"));
    fs.symlinkSync(FAKE, path.join(ROOT, "bin-a", "embarch-api"));
    const r = new core.ApiRunner();
    assert.deepEqual(await lines(r, f, "set the load to 1 A"), ['instrument "eload" (scpi)', 'instrument "psu" (scpi)']);
    assert.deepEqual(calls("a").map((c) => c.args), [["--json", "list-instruments"]]);
    assert.equal(fs.realpathSync(calls("a")[0].cwd), fs.realpathSync(f), "run in the chat's folder");
    // A name offers that instrument alone, with no instrument word.
    assert.deepEqual(await lines(r, f, "ask eload for its voltage"), ['instrument "eload" (scpi)']);
    // No word and no name: no line.
    assert.deepEqual(await lines(r, f, "tidy the changelog fragment"), []);
    // The written text is the entry's, never the model's.
    const refs = core.linkReferences([core.instrumentSource(core.parseInstruments(r.get(f, core.INSTRUMENTS_VERB)), "the psu")], "the psu");
    assert.equal(core.referenceText(refs.find((x) => x.line.includes("psu")), "the psu"), 'instrument "psu" (scpi)');
  });
});

test("cards calls within 5 minutes run the verb once; after them it runs again", async () => {
  const f = folder("b");
  await withEnv({ PATH: `${path.join(ROOT, "bin-a")}:${process.env.PATH}`, FAKE_API_LOG: logFile("b") }, async () => {
    const r = new core.ApiRunner();
    await lines(r, f, "x", 0);
    await lines(r, f, "x", 299_000);
    assert.equal(calls("b").length, 1);
    await lines(r, f, "x", 301_000);
    assert.equal(calls("b").length, 2);
  });
});

test("no refresh, no spawn: a chat that asks for no cards runs nothing", async () => {
  const f = folder("c");
  await withEnv({ PATH: `${path.join(ROOT, "bin-a")}:${process.env.PATH}`, FAKE_API_LOG: logFile("c") }, async () => {
    const r = new core.ApiRunner();
    assert.deepEqual(core.linkReferences([core.instrumentSource(core.parseInstruments(r.get(f, core.INSTRUMENTS_VERB)), "set the load")], "set the load"), []);
    assert.equal(calls("c").length, 0);
  });
});

test("no binary means no spawn; a failing or junk binary logs once and offers nothing", async () => {
  const f = folder("d");
  const logs = [];
  await withEnv({ PATH: path.join(ROOT, "empty"), FAKE_API_LOG: logFile("d") }, async () => {
    const r = new core.ApiRunner();
    assert.deepEqual(await lines(r, f, "set the load", 0, logs), []);
    assert.equal(r.spawns, 0);
    assert.equal(logs.length, 0);
  });
  await withEnv({ PATH: `${path.join(ROOT, "bin-a")}:${process.env.PATH}`, FAKE_API_FAIL: "no embarch.toml found" }, async () => {
    const r = new core.ApiRunner();
    assert.deepEqual(await lines(r, f, "set the load", 0, logs), []);
    assert.deepEqual(await lines(r, f, "set the load", 301_000, logs), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /failed \(exit 3\): embarch-api: no embarch.toml found/);
  });
  await withEnv({ PATH: `${path.join(ROOT, "bin-a")}:${process.env.PATH}`, FAKE_API_JUNK: "1" }, async () => {
    const r = new core.ApiRunner();
    const more = [];
    assert.deepEqual(await lines(r, f, "set the load", 0, more), []);
    assert.equal(more.length, 1);
  });
});

test("the verb's JSON is read strictly: a failure or odd entries offer nothing", () => {
  assert.equal(core.parseInstruments({ success: false, instruments: [] }), null);
  assert.equal(core.parseInstruments("x"), null);
  assert.deepEqual(core.parseInstruments({ success: true, instruments: [{ name: "a<b", protocol: "scpi" }, { name: "ok", protocol: "scpi" }, { name: "n" }] }), [{ name: "ok", protocol: "scpi" }]);
});
