#!/usr/bin/env node
// Records real stream-json transcripts for the wire tests: one cheap,
// stripped Haiku session per scenario, every line in and out kept in order.
// The fake `claude` (fake-claude.mjs) replays them.
//
//   node test/record.mjs <scratch-dir> [scenario ...]
//
// Each run costs about a cent on Haiku. Sessions run in <scratch-dir>/<name>,
// never in a repo, and are written with neutral prompts only; sanitize.mjs
// then strips machine paths before a fixture is copied into test/fixtures/.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

// The handoff card's own words (src/assistant/edits.ts), so the recording asks as the panel does.
const core = createRequire(import.meta.url)("../test-out/core.js");
const HANDOFF_REQUEST = (draft) => core.handoffRequest(draft);

const [, , scratch, ...only] = process.argv;
if (!scratch) {
  console.error("usage: record.mjs <scratch-dir> [scenario ...]");
  process.exit(2);
}

const BASE = [
  "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--permission-prompt-tool=stdio", "--replay-user-messages", "--include-partial-messages",
  "--model", "haiku", "--max-thinking-tokens", "0", "--strict-mcp-config", "--setting-sources", "",
  "--system-prompt", "You are a terse test assistant. Follow instructions exactly.",
];

function cleanEnv() {
  const env = { ...process.env, EMBARCH_DESK_INTERNAL: "1" };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
  return env;
}

class Rec {
  constructor(name, args, { persist = false, system = true } = {}) {
    this.name = name;
    this.dir = path.join(scratch, name);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "note.txt"), "the secret is MANGO\n");
    this.lines = [];
    this.waiters = [];
    this.buffer = [];
    // Without the terse system prompt the session is big enough to cache,
    // which the CLI's prompt suggestions need (it skips a cold cache).
    const base = system ? BASE : BASE.slice(0, BASE.indexOf("--system-prompt"));
    const full = [...base, ...(persist ? [] : ["--no-session-persistence"]), ...args];
    this.p = spawn("claude", full, {
      cwd: this.dir,
      env: cleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.p.stderr.on("data", (d) => fs.appendFileSync(path.join(this.dir, "stderr.txt"), d));
    createInterface({ input: this.p.stdout }).on("line", (l) => {
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        return;
      }
      this.lines.push({ d: "out", o });
      this.buffer.push(o);
      this.wake();
    });
    this.exited = new Promise((r) => this.p.on("exit", r));
  }
  wake() {
    for (const w of this.waiters.splice(0)) w();
  }
  send(o) {
    this.lines.push({ d: "in", o });
    this.p.stdin.write(JSON.stringify(o) + "\n");
  }
  user(content) {
    this.send({ type: "user", message: { role: "user", content } });
  }
  control(request_id, request) {
    this.send({ type: "control_request", request_id, request });
  }
  respond(o, response) {
    this.send({ type: "control_response", response: { subtype: "success", request_id: o.request_id, response } });
  }
  /** Waits for a line matching `pred`; answers permission prompts with `policy` meanwhile. */
  async until(pred, policy = (o) => this.respond(o, { behavior: "allow", updatedInput: o.request.input }), ms = 120000) {
    const t0 = Date.now();
    for (;;) {
      while (this.buffer.length) {
        const o = this.buffer.shift();
        if (o.type === "control_request" && o.request?.subtype === "can_use_tool") policy(o);
        if (pred(o)) return o;
      }
      if (Date.now() - t0 > ms) throw new Error(`${this.name}: timeout`);
      await new Promise((r) => {
        this.waiters.push(r);
        setTimeout(r, 500);
      });
    }
  }
  result(policy) {
    return this.until((o) => o.type === "result", policy);
  }
  async close() {
    this.p.stdin.end();
    await this.exited;
    const out = path.join(scratch, `${this.name}.jsonl`);
    fs.writeFileSync(out, this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const cost = this.lines.filter((l) => l.o.type === "result").reduce((a, l) => a + (l.o.total_cost_usd ?? 0), 0);
    console.log(`${this.name}: ${this.lines.length} lines, $${cost.toFixed(4)} -> ${out}`);
  }
}

const isResp = (id) => (o) => o.type === "control_response" && o.response?.request_id === id;
const firstText = (o) => o.type === "stream_event" && o.event?.delta?.type === "text_delta";

const scenarios = {
  async basic() {
    const r = new Rec("basic", ["--tools", "Bash"]);
    r.user("Run the bash command `echo hello-from-bash` and then reply with just: done");
    await r.result();
    r.user("Reply with just: ok");
    await r.result();
    await r.close();
  },
  async deny() {
    const r = new Rec("deny", ["--tools", "Bash"]);
    r.user("Run the bash command `touch should-not-exist.txt`. If it is refused, reply with just: refused");
    await r.result((o) => r.respond(o, { behavior: "deny", message: "The owner declined this tool call." }));
    await r.close();
  },
  async question() {
    const r = new Rec("question", ["--tools", "AskUserQuestion"]);
    r.user("Use the AskUserQuestion tool to ask me whether I prefer tea or coffee (two options, each with a short description), then tell me in one line what I picked.");
    await r.result((o) => {
      const inp = { ...o.request.input };
      const q = inp.questions?.[0];
      inp.answers = q ? { [q.question]: q.options[1].label } : {};
      r.respond(o, { behavior: "allow", updatedInput: inp });
    });
    await r.close();
  },
  // A message sent while Claude's question waits (decision 55): the CLI
  // queues it, the question stays open, and the message goes in after the answer.
  async askqueued() {
    const r = new Rec("askqueued", ["--tools", "AskUserQuestion"]);
    r.user("Use the AskUserQuestion tool to ask me whether I prefer tea or coffee (two options, each with a short description), then tell me in one line what I picked.");
    const ask = await r.until((o) => o.type === "control_request" && o.request?.subtype === "can_use_tool", () => {});
    r.user("Also end your reply with the word: kiwi");
    // Whatever the CLI does with it while the question is open.
    const cancelled = await r.until((o) => o.type === "control_cancel_request", () => {}, 5000).catch(() => null);
    if (!cancelled) {
      const inp = { ...ask.request.input };
      const q = inp.questions?.[0];
      inp.answers = q ? { [q.question]: q.options[1].label } : {};
      r.respond(ask, { behavior: "allow", updatedInput: inp });
    }
    await r.result();
    // A turn of its own for the queued message, if the CLI makes one.
    await r.until((o) => o.type === "result", undefined, 30000).catch(() => null);
    await r.close();
  },
  async plan() {
    const r = new Rec("plan", ["--permission-mode", "plan", "--tools", "Read,Write,ExitPlanMode"]);
    r.user("Plan how to create hello.txt containing hi, then present the plan for approval with ExitPlanMode. Keep the plan to two lines. After approval, create the file.");
    await r.result();
    await r.close();
  },
  async interrupt() {
    const r = new Rec("interrupt", ["--tools", ""]);
    r.user("Write a 400-word story about a lighthouse keeper.");
    await r.until(firstText);
    r.control("int-1", { subtype: "interrupt" });
    await r.result();
    r.user("Reply with just: still here");
    await r.result();
    await r.close();
  },
  async controls() {
    const r = new Rec("controls", ["--tools", ""]);
    r.user("@note.txt what is the secret? One word.");
    await r.result();
    r.control("cu-1", { subtype: "get_context_usage" });
    await r.until(isResp("cu-1"));
    r.control("pm-1", { subtype: "set_permission_mode", mode: "acceptEdits" });
    await r.until(isResp("pm-1"));
    r.control("sm-1", { subtype: "set_model", model: "haiku" });
    await r.until(isResp("sm-1"));
    r.control("rn-1", { subtype: "rename_session", title: "ABC-123 fixture chat" });
    await r.until(isResp("rn-1"));
    r.user("/compact");
    await r.result();
    r.control("cu-2", { subtype: "get_context_usage" });
    await r.until(isResp("cu-2"));
    await r.close();
  },
  async subagent() {
    const r = new Rec("subagent", ["--tools", "Task,Agent,Bash"]);
    r.user("Use the Agent tool (subagent_type general-purpose) to have a subagent run the bash command `echo from-subagent` and report its output. Then reply with just: done");
    await r.result();
    await r.close();
  },
  async edit() {
    const r = new Rec("edit", ["--tools", "Read,Write,Edit"]);
    r.user("Use the Write tool to create a.txt containing exactly two lines: one, two. Then use the Edit tool to change two to three. Then reply with just: done");
    await r.result();
    await r.close();
  },
  async background() {
    const r = new Rec("background", ["--tools", "Bash"]);
    r.user("Run the bash command `sleep 4; echo bg-done` with run_in_background set to true. Reply with just: started");
    await r.result();
    // Whatever the CLI does when the background task ends.
    await new Promise((res) => setTimeout(res, 9000));
    r.user("Reply with just: ok");
    await r.result();
    await r.close();
  },
  // The CLI's own guess at the next prompt (decision 25): a prompt_suggestion
  // line after each turn, with --prompt-suggestions.
  async suggest() {
    const r = new Rec("suggest", ["--tools", "Bash", "--prompt-suggestions"], { system: false });
    // Trivial turns ("reply with just: done") get no suggestion: the CLI filters them.
    r.user("I am setting up a small Node project in this folder. Run `echo setup` with bash, then suggest what I should do first, in two sentences.");
    await r.result();
    await r.until((o) => o.type === "prompt_suggestion", undefined, 30000).catch(() => null);
    r.user("Now run `ls` and tell me how many files there are.");
    await r.result();
    await r.until((o) => o.type === "prompt_suggestion", undefined, 30000).catch(() => null);
    await r.close();
  },
  // The compact card's send sequence (decision 36): the /compact line, its
  // compaction finished, then the rest of the draft.
  async compact() {
    const r = new Rec("compact", ["--tools", ""]);
    r.user("@note.txt what is the secret? One word.");
    await r.result();
    r.user("/compact focus on: the secret word in note.txt");
    await r.result();
    r.user("What was the secret word? One word.");
    await r.result();
    await r.close();
  },
  // Local slash commands: the CLI answers each with a text and a result and
  // echoes nothing back, unlike a prompt (or /compact's stdout).
  async slash() {
    const r = new Rec("slash", ["--tools", ""]);
    r.user("/context");
    await r.result();
    r.user("/cost");
    await r.result();
    r.user("Reply with just: ok");
    await r.result();
    await r.close();
  },
  // A turn that writes a handoff (decision 36), asked as the handoff card asks.
  async handoff() {
    const r = new Rec("handoff", ["--tools", "Read"]);
    r.user("Read note.txt and tell me the secret in one word.");
    await r.result();
    r.user(HANDOFF_REQUEST("Next: write the secret into a file named answer.txt."));
    await r.result();
    await r.close();
  },
  async persist() {
    const r = new Rec("persist", ["--tools", ""], { persist: true });
    r.user("Remember the word PELICAN. Reply with just: noted");
    const res = await r.result();
    await r.close();
    fs.writeFileSync(path.join(scratch, "persist.sid"), res.session_id);
    const r2 = new Rec("resume", ["--tools", "", "--resume", res.session_id], { persist: true });
    r2.user("What word did I ask you to remember? One word.");
    await r2.result();
    await r2.close();
  },
};

const names = only.length ? only : Object.keys(scenarios);
for (const n of names) {
  try {
    await scenarios[n]();
  } catch (e) {
    console.error(`${n}: ${e.message}`);
  }
}
