import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { parseArgs, parseSend, listFixture } from "../tools/wire-probe.mjs";

test("--send takes JSON with an optional @delay", () => {
  assert.deepEqual(parseSend('{"type":"user"}'), { value: { type: "user" }, delayMs: 0 });
  assert.deepEqual(parseSend('{"a":1}@250'), { value: { a: 1 }, delayMs: 250 });
  assert.deepEqual(parseSend('{"a":"x@y"}'), { value: { a: "x@y" }, delayMs: 0 });
  assert.deepEqual(parseSend('{"a":"x@5"}@7'), { value: { a: "x@5" }, delayMs: 7 });
  assert.throws(() => parseSend("{nope}@5"), /not JSON/);
});

test("arguments: flags, ordered sends, and the refusals", () => {
  const o = parseArgs(["--config-dir", "/c", "--bin", "/b/claude", "--model", "haiku", "--wait", "100", "--send", "1@10", "--send", '"two"']);
  assert.equal(o.configDir, "/c");
  assert.equal(o.bin, "/b/claude");
  assert.equal(o.model, "haiku");
  assert.equal(o.waitMs, 100);
  assert.deepEqual(o.sends, [{ value: 1, delayMs: 10 }, { value: "two", delayMs: 0 }]);
  assert.equal(parseArgs([]).bin, "claude");
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  assert.throws(() => parseArgs(["--model"]), /needs a value/);
  assert.throws(() => parseArgs(["--wait", "x"]), /milliseconds/);
  assert.throws(() => parseArgs(["--list", "f", "--send", "1"]), /do not combine/);
});

test("--list prints a fixture one row per entry", () => {
  const rows = listFixture(fs.readFileSync(new URL("./fixtures/wire/basic.jsonl", import.meta.url), "utf8"));
  assert.equal(rows.length, 33);
  assert.equal(rows[0], "in\tuser");
  assert.match(rows[1], /^out\tsystem\tinit$/);
  assert.ok(rows.some((r) => r.startsWith("out\tstream_event")));
});

test("--list shows a control request's subtype and a response's id", () => {
  const rows = listFixture('{"d":"in","o":{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}}\n{"d":"out","o":{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}}\n');
  assert.deepEqual(rows, ["in\tcontrol_request\tinitialize", "out\tcontrol_response\tsuccess"]);
});
