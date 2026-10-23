// A proposed Edit or Write, change by change (decision 64): the line diff,
// the text with only some changes kept, and the input that makes them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

const BEFORE = "alpha=1\nbeta=2\ngamma=3\ndelta=4\n";
// The recorded Edit (test/fixtures/wire/hunks.jsonl).
const EDIT = { file_path: "/work/rec/hunks/config.txt", old_string: "alpha=1\nbeta=2\ngamma=3\ndelta=4", new_string: "alpha=10\nbeta=2\ngamma=3\ndelta=40", replace_all: false };
const AFTER = BEFORE.replace(EDIT.old_string, EDIT.new_string);

test("two changed lines apart are two changes; all kept is the proposal, none kept the file as it was", () => {
  const h = core.lineHunks(BEFORE, AFTER);
  assert.deepEqual(h, [
    { at: 0, old: ["alpha=1"], add: ["alpha=10"] },
    { at: 3, old: ["delta=4"], add: ["delta=40"] },
  ]);
  assert.equal(core.applyHunks(BEFORE, h, [true, true]).text, AFTER);
  assert.equal(core.applyHunks(BEFORE, h, [false, false]).text, BEFORE);
  const some = core.applyHunks(BEFORE, h, [false, true]);
  assert.equal(some.text, "alpha=1\nbeta=2\ngamma=3\ndelta=40\n");
  assert.deepEqual(some.starts, [0, 3]);
  // Lines added and removed move what follows.
  const grow = core.lineHunks("a\nb\nc", "a\nx\ny\nb\nc\nz");
  assert.deepEqual(grow.map((x) => [x.at, x.old, x.add]), [[1, [], ["x", "y"]], [3, [], ["z"]]]);
  assert.deepEqual(core.applyHunks("a\nb\nc", grow, [true, true]).starts, [1, 5]);
  assert.deepEqual(core.lineHunks("same", "same"), []);
});

test("an Edit keeps its old_string and gets a new_string with only the kept changes; a Write gets its content", () => {
  const h = core.lineHunks(BEFORE, AFTER);
  assert.deepEqual(core.keptInput("Edit", EDIT, BEFORE, h, [true, false]), { ...EDIT, new_string: "alpha=10\nbeta=2\ngamma=3\ndelta=4" });
  assert.equal(core.keptInput("Edit", EDIT, BEFORE, h, [true, true]), EDIT, "all kept: the call as proposed");
  assert.equal(core.keptInput("Edit", EDIT, BEFORE, h, [false, false]), null, "none kept: a reject");
  const write = { file_path: "/work/a.txt", content: AFTER };
  assert.deepEqual(core.keptInput("Write", write, BEFORE, h, [false, true]), { ...write, content: "alpha=1\nbeta=2\ngamma=3\ndelta=40\n" });
  // A span that starts and ends inside a line; lines changed side by side are one change.
  const before = "x = foo(1);\nkeep();\ny = bar(2);\n";
  const edit = { file_path: "/work/b.c", old_string: "foo(1);\nkeep();\ny = bar(2)", new_string: "foo(10);\nkeep();\ny = bar(20)" };
  const hb = core.lineHunks(before, before.replace(edit.old_string, edit.new_string));
  assert.equal(hb.length, 2);
  assert.equal(core.keptInput("Edit", edit, before, hb, [false, true]).new_string, "foo(1);\nkeep();\ny = bar(20)");
  assert.equal(core.lineHunks("a\nb\n", "A\nB\n").length, 1);
});

test("only a Write, or an Edit of one place, is taken change by change; a huge middle is one change", () => {
  assert.ok(core.perChange("Edit", EDIT, BEFORE));
  assert.ok(core.perChange("Write", { content: "" }, ""));
  assert.ok(!core.perChange("Edit", { ...EDIT, replace_all: true }, BEFORE), "replace_all: every place at once");
  assert.ok(!core.perChange("Edit", EDIT, "the file changed since"), "old_string gone");
  assert.ok(!core.perChange("NotebookEdit", {}, BEFORE));
  const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n");
  assert.equal(core.lineHunks(a, b).length, 1);
});
