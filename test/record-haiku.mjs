#!/usr/bin/env node
// Records real Haiku assistant calls for the tests: each scenario is one
// stripped `claude -p --model haiku` call made exactly as the extension makes
// it (src/assistant/haiku.ts), with a neutral draft and a made-up work item —
// never the owner's prompts. The fake `claude` (fake-claude.mjs) replays them
// by the prompt's TASK line.
//
//   node test/record-haiku.mjs <scratch-dir> [scenario ...]
//   node test/sanitize.mjs <scratch-dir>/<name>.jsonl test/fixtures/haiku/<name>.jsonl <scratch-dir>
//
// About $0.002–0.004 a call.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const core = createRequire(import.meta.url)("../test-out/core.js");
const [, , scratch, ...only] = process.argv;
if (!scratch) {
  console.error("usage: record-haiku.mjs <scratch-dir> [scenario ...]");
  process.exit(2);
}
fs.mkdirSync(scratch, { recursive: true });

const BASE = {
  lastReply:
    "The widget driver now builds. I changed `src/widget.c` so the blink period comes from the devicetree, and the unit tests pass. I have not flashed it yet.",
  item: { key: "ABC-123", title: "Make the widget blink", state: "In Progress", prs: ["PR #42 open"] },
  library: ["embarch-chat:embarch-permissions", "embarch-chat:embarch-claude-md", "embarch-chat:build-flash-verify"],
  context: { percentage: 34, totalTokens: 68000, maxTokens: 200000 },
};

export const SCENARIOS = {
  ghost: () => core.ghostPrompt({ ...BASE, draft: "now flash it on the" }),
  cards: () => core.cardsPrompt({ ...BASE, draft: "fix the flash thing" }),
  "cards-context": () =>
    core.cardsPrompt({ ...BASE, draft: "now write the release notes for the whole quarter", context: { percentage: 86, totalTokens: 172000, maxTokens: 200000 } }),
  "cards-compact": () =>
    core.cardsPrompt({
      ...BASE,
      draft: "the widget is done. next, move on to the UART driver: add a ring buffer for RX and a test for it",
      context: { percentage: 68, totalTokens: 136000, maxTokens: 200000 },
    }),
  turn: () => core.turnPrompt({ ...BASE, draft: "", cliSuggestion: "flash it" }, { chips: true, name: true }),
};

function record(name, prompt) {
  return new Promise((resolve) => {
    const lines = [{ d: "in", o: { prompt } }];
    const p = spawn("claude", core.haikuArgs(core.SYSTEM), { cwd: scratch, env: core.haikuEnv(), stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: p.stdout }).on("line", (l) => {
      try {
        lines.push({ d: "out", o: JSON.parse(l) });
      } catch {
        /* not a line of the wire */
      }
    });
    p.on("exit", () => {
      const out = path.join(scratch, `${name}.jsonl`);
      fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      const res = lines.find((l) => l.o.type === "result")?.o;
      console.log(`${name}: ${lines.length} lines, $${(res?.total_cost_usd ?? 0).toFixed(4)} -> ${out}\n  ${String(res?.result ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
      resolve();
    });
    p.stdin.end(prompt);
  });
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  for (const n of only.length ? only : Object.keys(SCENARIOS)) await record(n, SCENARIOS[n]());
}
