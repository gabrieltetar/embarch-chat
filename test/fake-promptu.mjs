#!/usr/bin/env node
// A stand-in `promptu` (embarch-promptu's CLI) for the chat's tests: it
// answers `prep`, `next`, `render`, `patterns --json` and `memory --json`
// in the shapes of embarch-promptu's docs/contract.md §5, §7.8 and §8, with
// invented data, and never calls a model. The real one is exercised by
// promptu.test.mjs when PROMPTU_BIN names a build of it.
//
// Env: FAKE_PROMPTU_DIR (its scratch folder: the run it is on, and `log.jsonl`
// — one line per call: argv, stdin, cwd, and the `--desk` file's JSON),
// FAKE_PROMPTU_SLEEP_MS (prep waits this long first), FAKE_PROMPTU_FAIL
// (`<command>:<exit>:<stderr line>`: that command fails so), FAKE_PROMPTU_PAGES
// (how many pages prep plans, default 1; 0 with no chip row is `done`),
// FAKE_PROMPTU_CHOOSE (1: prep opens the chip row first).

import * as fs from "node:fs";
import * as path from "node:path";

const [cmd, ...rest] = process.argv.slice(2);
const dir = process.env.FAKE_PROMPTU_DIR ?? "/tmp";
const stdin = fs.readFileSync(0, "utf8");
const arg = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const flag = (name) => rest.includes(name);
const deskFile = arg("--desk");
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(
  path.join(dir, "log.jsonl"),
  JSON.stringify({ cmd, args: rest, stdin, cwd: process.cwd(), desk: deskFile && fs.existsSync(deskFile) ? JSON.parse(fs.readFileSync(deskFile, "utf8")) : null, deskMode: deskFile && fs.existsSync(deskFile) ? (fs.statSync(deskFile).mode & 0o777).toString(8) : null }) + "\n",
);

const fail = (process.env.FAKE_PROMPTU_FAIL ?? "").split(":");
if (fail[0] === cmd) {
  process.stderr.write(`promptu: ${fail.slice(2).join(":") || "it failed"}\n`);
  process.exit(Number(fail[1]) || 1);
}

const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
const runFile = path.join(dir, "run.json");
const Q_DONE = {
  question: "What does done look like, and how is it checked?",
  header: "Done when",
  multiSelect: false,
  options: [
    { label: "Build and tests pass (Recommended)", description: "Show the commands and their output." },
    { label: "I'll judge it", description: "Stop when you think it's done." },
  ],
};
const Q_GOAL = {
  question: "Why are we doing this, and for whom? One line.",
  header: "Goal",
  multiSelect: false,
  options: [
    { label: "Leave it out", description: "Nothing about this goes into the prompt." },
    { label: "Not sure", description: "The prompt says it is not known yet." },
  ],
};
const Q_RULES = {
  question: "Which house rules apply?",
  header: "House rules",
  multiSelect: true,
  options: [
    { label: "Use another checkout (Recommended)", description: "A worktree." },
    { label: "Only I open PRs (Recommended)", description: "Never open one." },
    { label: "Never push", description: "Local commits only." },
  ],
};

function describe(run) {
  const pages = [];
  for (let i = run.page; i < run.pages; i++) pages.push(i === 0 ? { ids: ["done", "goal"], questions: [Q_DONE, Q_GOAL] } : { ids: ["rules"], questions: [Q_RULES] });
  return {
    promptu: 1,
    run: run.id,
    pattern: run.choose ? null : { id: run.pattern, version: 1, picked_by: run.forced ? "flag" : "model", confidence: 0.84, alt: [], start_default: false },
    offline: false,
    offline_reason: null,
    mode: "normal",
    parts: run.have,
    flags: { firmware: false, hardware: false, item: !!run.desk },
    filled: run.desk ? [{ q: "read", header: "Read first", value: "The issue and its PR", source: "desk", entry: null, evidence: "Read the issue and its PR" }] : [],
    dropped: [],
    defaults: [{ q: "heavy", header: "How heavy", value: "Smallest that works" }],
    choose: run.choose
      ? {
          ids: ["_pattern"],
          questions: [
            {
              question: "Which kind of task is this?",
              header: "Pattern",
              multiSelect: false,
              options: [
                { label: "implement-issue (Recommended)", description: "Build a change." },
                { label: "debug-failure", description: "Find a cause." },
                { label: "No pattern, send as is", description: "Run the prompt exactly as typed." },
              ],
            },
          ],
        }
      : null,
    pages: run.choose ? [] : pages,
    done: !run.choose && pages.length === 0,
    start: run.start,
    pass: { ms: 1, cost_usd: 0, effort: "medium" },
    warnings: [],
  };
}

if (cmd === "patterns") {
  out({
    promptu: 1,
    patterns: [
      { name: "debug-failure", version: 1, summary: "Investigate a failure whose cause is not known yet.", description: "…", desk: "possible" },
      { name: "handoff", version: 1, summary: "Have this session write a self-contained brief.", description: "…", desk: "never" },
      { name: "implement-issue", version: 1, summary: "Build a feature or a change from an issue or an idea.", description: "…", desk: "default" },
    ],
  });
} else if (cmd === "prep") {
  const ms = Number(process.env.FAKE_PROMPTU_SLEEP_MS ?? 0);
  if (ms) await new Promise((r) => setTimeout(r, ms));
  const forced = arg("--pattern");
  const run = {
    id: `20261030-120000-${Math.random().toString(16).slice(2, 6)}`,
    rough: stdin,
    pattern: forced ?? "implement-issue",
    forced: !!forced,
    have: (arg("--have") ?? "none") === "none" ? [] : arg("--have").split(","),
    desk: !!deskFile,
    start: flag("--start"),
    rec: flag("--rec"),
    choose: !forced && process.env.FAKE_PROMPTU_CHOOSE === "1",
    page: 0,
    pages: flag("--rec") ? 0 : Number(process.env.FAKE_PROMPTU_PAGES ?? 1),
    answers: {},
  };
  if (run.rec) run.choose = false;
  fs.writeFileSync(runFile, JSON.stringify(run));
  out(describe(run));
} else if (cmd === "next" || cmd === "render") {
  const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
  if (rest[0] !== run.id) {
    process.stderr.write(`promptu: no run \`${rest[0]}\`\n`);
    process.exit(2);
  }
  const input = stdin.trim() ? JSON.parse(stdin) : {};
  if (input.pattern) {
    run.choose = false;
    run.pattern = input.pattern.replace(/ \(Recommended\)$/, "");
  }
  Object.assign(run.answers, input.answers ?? {});
  if (cmd === "next" && Object.keys(input.answers ?? {}).length) run.page += 1;
  fs.writeFileSync(runFile, JSON.stringify(run));
  if (cmd === "next") out(describe(run));
  else {
    const restMode = arg("--rest") ?? input.rest ?? null;
    const asked = Object.keys(run.answers);
    const assume = restMode === "assume" ? ["done", "goal"].filter((q) => !asked.includes(q)) : [];
    const footer = `— promptu ${run.pattern}@1${asked.length ? ` asked=${asked.map((q) => `${q}:${restMode === "recommended" ? "all" : "rec"}`).join(",")}` : ""}${assume.length ? ` assume=${assume.join(",")}` : ""}`;
    const prompt = `## Goal\n${run.rough}\n\n## Done when\nIt builds and the tests pass.${assume.length ? "\n\n## Constraints\n- Not answered; state your assumption before you start: …" : ""}\n\n${footer}`;
    out({ promptu: 1, run: run.id, pattern: run.pattern, prompt, footer, sections: ["Goal", "Done when"] });
  }
} else if (cmd === "memory") {
  const cwd = process.cwd();
  const mem = path.join(dir, "memory");
  out({
    promptu: 1,
    cwd,
    project_root: cwd,
    today: "2026-10-30",
    hook: "warn",
    memory: { path: mem, chosen_by: "default", exists: true, index: path.join(mem, "MEMORY.md"), source_root: cwd },
    scopes: [
      { id: "user", label: "User", files: [path.join(dir, "CLAUDE.md")], domains: ["Working rules"] },
      { id: "auto", label: "Auto memory", files: [path.join(mem, "MEMORY.md"), path.join(mem, "soak-test.md")], domains: ["testing"] },
      { id: "project", label: "Project", files: [], domains: [] },
    ],
    entries: [
      { scope: "user", domain: "Working rules", kind: null, type: null, id: "claude-md", file: path.join(dir, "CLAUDE.md"), title: "Working rules", line: "- Ask when unclear.", line_no: 3, chars: null, modified: null, age_days: null, review_by: null, source: [], flags: [], stale: false, used: [] },
      {
        scope: "auto",
        domain: "testing",
        kind: "status",
        type: "project",
        id: "08841b",
        file: path.join(mem, "soak-test.md"),
        title: "Soak test",
        line: "- [Soak test](soak-test.md) — the nightly soak test is paused",
        line_no: 3,
        chars: 60,
        modified: "2026-09-15",
        age_days: 45,
        review_by: "2026-10-01",
        source: [],
        flags: ["review_by_past"],
        stale: true,
        used: [{ pattern: "bench-session", question: "gate", date: "2026-10-29", changed: false }],
      },
    ],
    counts: { entries: 2, stale: 1 },
    used_scanned: true,
    used_claude_md: [],
  });
} else {
  process.stderr.write(`promptu: unknown command ${cmd}\n`);
  process.exit(2);
}
