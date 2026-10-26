// A file link as Claude writes one, and where it is on disk (decision 93):
// its lines from `:42`, `:42:7`, `:42-51` or `#L42-L51`; a path as written,
// from `~`, or from a folder above the chat's; the file a bare name means
// among those the chat's own steps read or edited.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

test("a link's lines, in each shape Claude writes them", () => {
  const p = core.parseFileLink;
  assert.deepEqual(p("src/a.c"), { path: "src/a.c" });
  assert.deepEqual(p("src/a.c", 12), { path: "src/a.c", line: 12 });
  assert.deepEqual(p("src/a.c:42"), { path: "src/a.c", line: 42 });
  assert.deepEqual(p("src/a.c:42:7"), { path: "src/a.c", line: 42, column: 7 });
  assert.deepEqual(p("src/a.c:42-51"), { path: "src/a.c", line: 42, endLine: 51 });
  assert.deepEqual(p("src/a.c#L42"), { path: "src/a.c", line: 42 });
  assert.deepEqual(p("src/a.c#L42-L51"), { path: "src/a.c", line: 42, endLine: 51 });
  assert.deepEqual(p("src/a.c#L42-51"), { path: "src/a.c", line: 42, endLine: 51 });
  assert.deepEqual(p("src/a.c#L42C5"), { path: "src/a.c", line: 42, column: 5 });
  assert.deepEqual(p("docs/spec.md#the-column"), { path: "docs/spec.md" }, "a heading anchor opens the file at its top");
  assert.deepEqual(p("My%20Notes/a%20b.md"), { path: "My Notes/a b.md" });
  assert.deepEqual(p("100%.md"), { path: "100%.md" }, "a lone % is part of the name");
  assert.deepEqual(p("src/a.c:51-42"), { path: "src/a.c", line: 51 }, "a range that runs backwards is its first line");
  for (const bad of ["", "  ", "vscode://x", "command:foo", "file:///etc/hostname", "javascript:alert(1)", "#L3"]) assert.equal(p(bad), null, bad);
});

test("a path as written, from ~, and from a folder above the chat's only when asked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-links-"));
  try {
    const home = path.join(root, "users", "me");
    const cwd = path.join(home, "repos", "app");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(home, "repos", "lib", "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "main.c"), "");
    fs.writeFileSync(path.join(home, "repos", "lib", "src", "lib.c"), "");
    fs.writeFileSync(path.join(home, "notes.md"), "");
    fs.writeFileSync(path.join(root, "outside.md"), "");
    const r = core.resolveFileLink;
    assert.equal(r("src/main.c", cwd, home), path.join(cwd, "src", "main.c"));
    assert.equal(r("./src/main.c", cwd, home), path.join(cwd, "src", "main.c"));
    assert.equal(r(path.join(cwd, "src", "main.c"), "", home), path.join(cwd, "src", "main.c"));
    assert.equal(r("~/notes.md", cwd, home), path.join(home, "notes.md"));
    assert.equal(r("src", cwd, home), path.join(cwd, "src"), "a folder is found too");
    assert.equal(r("lib/src/lib.c", cwd, home), null, "not above unless asked");
    assert.equal(r("lib/src/lib.c", cwd, home, { up: true }), path.join(home, "repos", "lib", "src", "lib.c"), "a sibling repo");
    assert.equal(r("outside.md", cwd, home, { up: true }), null, "never above home's parent");
    fs.writeFileSync(path.join(root, "users", "shared.md"), "");
    assert.equal(r("shared.md", cwd, home, { up: true }), path.join(root, "users", "shared.md"), "home's parent is the last folder looked in");
    assert.equal(r("nope.c", cwd, home, { up: true }), null);
    assert.equal(r("src/main.c", "", home), null, "a relative path needs the chat's folder");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a bare name is the file the chat's steps named, whole names only, the latest first", () => {
  const steps = [
    { file_path: "/w/app/apps/one/src/main.c" },
    { command: "make" },
    { file_path: "/w/app/apps/one/src/hal.c" },
    { file_path: "/w/app/lib/domain.c" },
    { notebook_path: "/w/app/nb/plot.ipynb" },
    { file_path: "tests/two/src/main.c" },
    { file_path: "/w/app/apps/one/src/hal.c" },
  ];
  const t = core.touchedMatches;
  assert.deepEqual(t("hal.c", steps, "/w/app"), ["/w/app/apps/one/src/hal.c"], "named twice, listed once");
  assert.deepEqual(t("main.c", steps, "/w/app"), ["/w/app/tests/two/src/main.c", "/w/app/apps/one/src/main.c"], "relative to the chat's folder; the latest first");
  assert.deepEqual(t("src/main.c", steps, "/w/app"), ["/w/app/tests/two/src/main.c", "/w/app/apps/one/src/main.c"]);
  assert.deepEqual(t("one/src/main.c", steps, "/w/app"), ["/w/app/apps/one/src/main.c"]);
  assert.deepEqual(t("ain.c", steps, "/w/app"), [], "a whole name, never its tail");
  assert.deepEqual(t("plot.ipynb", steps, "/w/app"), ["/w/app/nb/plot.ipynb"]);
  assert.deepEqual(t("../x/main.c", steps, "/w/app"), []);
  assert.deepEqual(t("/abs/main.c", steps, "/w/app"), []);
});

test("a path as a literal glob", () => {
  assert.equal(core.globLiteral("src/a.c"), "src/a.c");
  assert.equal(core.globLiteral("x[1]/{a}*?.c"), "x[[]1[]]/[{]a[}][*][?].c");
});
