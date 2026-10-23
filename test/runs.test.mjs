// Runs of steps (decision 50): the pure folding and the streaming call's
// input, without a webview.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");
const here = path.dirname(fileURLToPath(import.meta.url));

const outLines = (name) =>
  fs
    .readFileSync(path.join(here, "fixtures", "wire", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.d === "out")
    .map((e) => e.o);

const quiet = (t) => core.quietTool(t.name);
/** A timeline from a compact spec: "Bash" a quiet tool, "Edit" a loud one, "~" thinking, "t" text, "u" the owner, "n" a note. */
function timeline(spec) {
  const entries = {};
  const ids = spec.split(" ").map((k, i) => {
    const id = `${k}${i}`;
    entries[id] =
      k === "~"
        ? { kind: "thinking", id, text: "hm", parent: null }
        : k === "t"
          ? { kind: "text", id, text: "x", parent: null }
          : k === "u"
            ? { kind: "user", id, text: "x", images: 0 }
            : k === "n"
              ? { kind: "note", id, text: "x", tone: "info" }
              : { kind: "tool", id, name: k, input: {}, parent: null, status: "done", children: [] };
    return id;
  });
  return { ids, get: (id) => entries[id] };
}
/** The rows as a spec again: a run in brackets. */
const shape = (spec, q = quiet) => {
  const { ids, get } = timeline(spec);
  return core
    .foldRuns(ids, get, q)
    .map((f) => (f.run ? `[${f.ids.map((id) => id.replace(/\d+$/, "")).join(" ")}]` : f.ids[0].replace(/\d+$/, "")))
    .join(" ");
};

test("two or more quiet steps in a row fold into one run; one stays a plain row", () => {
  assert.equal(shape("u Bash t"), "u Bash t");
  assert.equal(shape("u Bash Read Grep t"), "u [Bash Read Grep] t");
  assert.equal(shape("u Bash Read u Glob WebFetch"), "u [Bash Read] u [Glob WebFetch]");
});

test("thinking between quiet steps folds in; before the first or after the last it stands alone", () => {
  assert.equal(shape("u ~ Bash ~ Read ~ Grep ~ t"), "u ~ [Bash ~ Read ~ Grep] ~ t");
  assert.equal(shape("u Bash ~ t"), "u Bash ~ t", "one step and thinking: no run");
  assert.equal(shape("u Bash ~ ~ Read"), "u [Bash ~ ~ Read]");
});

test("text, the owner, notes and loud tools end a run; loud tools stand alone", () => {
  for (const loud of ["Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "Agent", "Task"]) {
    assert.equal(shape(`u Bash Read ${loud} Grep Glob`), `u [Bash Read] ${loud} [Grep Glob]`, loud);
    assert.equal(core.quietTool(loud), false, loud);
  }
  assert.equal(shape("Bash Read t Grep Glob n Bash Bash"), "[Bash Read] t [Grep Glob] n [Bash Bash]");
  assert.equal(shape("Bash ~ Edit Read"), "Bash ~ Edit Read", "thinking before a loud tool is not between quiet steps");
  for (const q of ["Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Skill", "mcp__x__y"]) assert.equal(core.quietTool(q), true, q);
});

test("a tool a renderer claims (a bench card) stands alone and ends a run", () => {
  const build = "mcp__embarch-api__build";
  const q = (t) => core.quietTool(t.name) && !core.hasBenchCard(t.name);
  assert.equal(shape(`Bash Read ${build} Grep Glob`, q), `[Bash Read] ${build} [Grep Glob]`);
  assert.equal(core.hasBenchCard(build), true);
  assert.equal(core.hasBenchCard("mcp__plugin_x_embarch-api__run_study"), true);
  assert.equal(core.hasBenchCard("mcp__embarch-api__list_projects"), false, "no card, so quiet");
  assert.equal(core.hasBenchCard("Bash"), false);
});

test("a run is keyed by its first step, which stays the same as it grows", () => {
  const { ids, get } = timeline("u Bash Read Grep Glob");
  const keys = [3, 4, 5].map((n) => core.foldRuns(ids.slice(0, n), get, quiet).find((f) => f.run)?.key);
  assert.deepEqual(keys, [ids[1], ids[1], ids[1]]);
  assert.equal(core.foldRuns(ids.slice(0, 2), get, quiet)[1].key, ids[1], "as a plain row it had the same key");
});

test("the recorded session: six steps fold into one run in the first turn, the second turn's one step stays plain", () => {
  const s = core.reduceAll(core.initialState("s"), outLines("steps"));
  const rows = core.foldRuns(s.timeline, (id) => s.entries[id], quiet);
  const kinds = rows.map((f) => (f.run ? `run:${f.ids.length}` : s.entries[f.ids[0]].kind));
  assert.deepEqual(kinds, ["user", "run:6", "text", "user", "tool", "text"]);
  const steps = rows[1].ids.map((id) => s.entries[id]);
  assert.deepEqual(core.runTally(steps), { steps: 6, running: 0, awaiting: 0, error: 1, denied: 0 });
  assert.equal(core.toolIntent(core.runHead(steps).name, core.runHead(steps).input), "Print current year");
  assert.deepEqual(
    steps.map((t) => core.toolIntent(t.name, t.input)),
    ["List files in current directory", null, "Count bytes in note.txt", null, "Try to read missing.txt", "Print current year"],
  );
});

test("a subagent's steps fold the same way", () => {
  const s = core.reduceAll(core.initialState("s"), outLines("subagent"));
  const agent = Object.values(s.entries).find((e) => e.kind === "tool" && e.name === "Agent");
  const rows = core.foldRuns(agent.children, (id) => s.entries[id], quiet);
  assert.deepEqual(rows.map((f) => (f.run ? "run" : s.entries[f.ids[0]].kind)), ["tool", "text"], "one step: a plain row");
});

test("a step's own words: a built-in tool's description, first line; never an MCP tool's", () => {
  assert.equal(core.toolIntent("Bash", { command: "ls", description: "  List files  " }), "List files");
  assert.equal(core.toolIntent("Agent", { description: "Find the bug\nand more", prompt: "..." }), "Find the bug");
  assert.equal(core.toolIntent("Bash", { command: "ls" }), null);
  assert.equal(core.toolIntent("Bash", { command: "ls", description: "  " }), null);
  assert.equal(core.toolIntent("Bash", { command: "ls", description: 3 }), null);
  assert.equal(core.toolIntent("mcp__linear__save_issue", { title: "T", description: "The issue's body" }), null);
});

test("the red count says what failed", () => {
  assert.equal(core.failedText({ error: 0, denied: 0 }), "");
  assert.equal(core.failedText({ error: 1, denied: 0 }), "1 error");
  assert.equal(core.failedText({ error: 2, denied: 1 }), "2 errors · 1 denied");
  assert.equal(core.failedText({ error: 0, denied: 3 }), "3 denied");
});

test("a streaming input: every prefix reads as far as it has come, the whole one exactly", () => {
  const final = { command: 'printf "a\\tb\\n" > "x y.txt"', description: "Write é and \"quotes\" \\ to x y.txt", timeout: 60000, todos: [{ content: "a, b", status: "x" }], flag: true };
  const json = JSON.stringify(final, null, 1);
  for (let n = 0; n <= json.length; n++) {
    const { input, open } = core.partialInput(json.slice(0, n));
    for (const [k, v] of Object.entries(input)) {
      if (typeof final[k] === "string") assert.ok(final[k].startsWith(v), `${n}: ${k} = ${JSON.stringify(v)}`);
      else assert.deepEqual(v, final[k], `${n}: ${k} is whole or absent`);
      if (k !== open && typeof v === "string") assert.equal(v, final[k], `${n}: ${k} is closed, so whole`);
    }
    if (open) assert.equal(typeof input[open], "string");
  }
  assert.deepEqual(core.partialInput(json), { input: final, open: null });
  assert.deepEqual(core.partialInput(""), { input: {}, open: null });
  assert.deepEqual(core.partialInput('{"command": "ls", "descr'), { input: { command: "ls" }, open: null });
});

test("a streaming call is the step it is about to be: its description once whole, its own id", () => {
  const block = (text) => ({ type: "tool_use", text, name: "Bash", id: "toolu_1" });
  assert.deepEqual(core.liveTool(block('{"command": "wc -c no'), 0).input, { command: "wc -c no" });
  assert.deepEqual(core.liveTool(block('{"command": "wc -c note.txt", "description": "Count'), 0).input, { command: "wc -c note.txt" }, "half a description is not shown");
  const t = core.liveTool(block('{"command": "wc -c note.txt", "description": "Count bytes"}'), 0);
  assert.deepEqual(t, { kind: "tool", id: "toolu_1", name: "Bash", input: { command: "wc -c note.txt", description: "Count bytes" }, parent: null, status: "running", children: [] });
  // Every recorded call: once its input has streamed whole, the step reads as the entry it lands as.
  const s = core.reduceAll(core.initialState("s"), outLines("steps"));
  const lines = outLines("steps");
  for (const o of lines) {
    if (o.type !== "assistant") continue;
    for (const b of o.message.content.filter((c) => c.type === "tool_use")) {
      const start = lines.findIndex((x) => x.event?.content_block?.id === b.id);
      let text = "";
      for (let i = start + 1; i < lines.length && lines[i].event?.type === "content_block_delta" && lines[i].event.index === lines[start].event.index; i++) text += lines[i].event.delta.partial_json ?? "";
      assert.deepEqual(core.liveTool({ type: "tool_use", text, name: b.name, id: b.id }, 0).input, s.entries[b.id].input, b.id);
    }
  }
});
