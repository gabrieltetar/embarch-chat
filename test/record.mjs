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
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

// The handoff card's own words (src/assistant/edits.ts), so the recording asks as the panel does.
const core = createRequire(import.meta.url)("../test-out/core.js");
const HANDOFF_REQUEST = (draft) => core.handoffRequest(draft);
// The one-tool MCP server whose tool asks with an elicitation (decision 66).
const ELICIT_MCP = path.join(path.dirname(new URL(import.meta.url).pathname), "mcp-elicit.mjs");
const mcpConfig = (env = {}) => JSON.stringify({ mcpServers: { bench: { command: process.execPath, args: [ELICIT_MCP], env } } });
const isElicit = (o) => o.type === "control_request" && o.request?.subtype === "elicitation";

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
  constructor(name, args, { persist = false, system = true, dir, env } = {}) {
    this.name = name;
    this.dir = dir ?? path.join(scratch, name);
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
      env: { ...cleanEnv(), ...env },
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
      // REC_TRACE: every line out as it comes, to see where a scenario waits.
      if (process.env.REC_TRACE) fs.appendFileSync(path.join(this.dir, "trace.jsonl"), l + "\n");
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
  /** `uuid`: the message's own, as the panel stamps it, for the CLI's queue (cancel_async_message, command_lifecycle). */
  user(content, uuid) {
    this.send({ type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content } });
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
        // The CLI calling back into the panel: a hook's callback, a message for the panel's own MCP server.
        else if (o.type === "control_request" && this.onControl) this.onControl(o);
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
const taskStarted = (type) => (o) => o.type === "system" && o.subtype === "task_started" && o.task_type === type;
const taskEnded = (o) => o.type === "system" && o.subtype === "task_notification";
const isResult = (o) => o.type === "result";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** Fixed uuids for the panel's messages: a fixture carries them, fake-claude maps them to the client's. */
const uuidOf = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
  // A run of quiet steps (decision 50): Bash calls with their own one-line
  // descriptions, a Read, a Grep, one failing step; then a second turn.
  async steps() {
    const r = new Rec("steps", ["--tools", "Bash,Read,Grep"]);
    r.user(
      "Make these tool calls one at a time, one per message, giving each Bash call a short description: " +
        "1) Bash `ls`; 2) Read note.txt; 3) Bash `wc -c note.txt`; 4) Grep for MANGO; 5) Bash `cat missing.txt`; 6) Bash `date +%Y`. " +
        "Write no text before or between the calls. Then reply with just: done",
    );
    await r.result();
    r.user("Run the bash command `echo second-turn`, then reply with just: ok");
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
  // "Run in background" on a running Bash call (port item 70): the CLI's
  // task_started for the call in the foreground, background_tasks with its
  // tool_use_id, the turn going on; then the task's output and its Stop
  // (item 71), and its output once more after it ended.
  async runbg() {
    const r = new Rec("runbg", ["--tools", "Bash"]);
    r.user("Run the bash command `for i in $(seq 1 20); do echo tick $i; sleep 2; done` in the foreground (not in the background). When it returns, reply with just: done", uuidOf(1));
    const call = await r.until((o) => o.type === "assistant" && o.message?.content?.some((b) => b.type === "tool_use"));
    const t = (await r.until(taskStarted("local_bash"), undefined, 20000).catch(() => null)) ?? { tool_use_id: call.message.content.find((b) => b.type === "tool_use").id };
    await pause(3000);
    r.control("bg-1", { subtype: "background_tasks", tool_use_id: t.tool_use_id });
    await r.until(isResp("bg-1"));
    await r.result();
    r.control("out-1", { subtype: "get_task_output", task_id: t.task_id });
    await r.until(isResp("out-1"));
    r.control("stop-1", { subtype: "stop_task", task_id: t.task_id });
    await r.until(isResp("stop-1"));
    await r.until(taskEnded, undefined, 15000).catch(() => null);
    // Whatever turn the CLI runs for the ended task.
    await r.until(isResult, undefined, 20000).catch(() => null);
    r.control("out-2", { subtype: "get_task_output", task_id: t.task_id });
    await r.until(isResp("out-2"));
    await r.close();
  },
  // Stop on a turn while a background task runs (item 71): what the
  // interrupt leaves running, then the task's own Stop.
  async bgstop() {
    const r = new Rec("bgstop", ["--tools", "Bash"]);
    r.user("Run the bash command `for i in $(seq 1 30); do echo tick $i; sleep 2; done` with run_in_background set to true. Reply with just: started", uuidOf(1));
    const t = await r.until(taskStarted("local_bash"), undefined, 30000);
    await r.result();
    r.user("Write a 400-word story about a lighthouse keeper.", uuidOf(2));
    await r.until(firstText);
    r.control("int-1", { subtype: "interrupt" });
    await r.until(isResp("int-1"));
    await r.result();
    await pause(1500);
    r.control("out-1", { subtype: "get_task_output", task_id: t.task_id });
    await r.until(isResp("out-1"));
    r.control("stop-1", { subtype: "stop_task", task_id: t.task_id });
    await r.until(isResp("stop-1"));
    await r.until(taskEnded, undefined, 15000).catch(() => null);
    await r.until(isResult, undefined, 20000).catch(() => null);
    await r.close();
  },
  // A subagent moved to the background (item 70), then stopped (item 71's "Stop agent").
  async agentbg() {
    const r = new Rec("agentbg", ["--tools", "Agent,Task,Bash"]);
    r.user("Use the Agent tool (subagent_type general-purpose, in the foreground) to have a subagent run the bash command `sleep 45; echo from-subagent` and report its output. Then reply with just: done", uuidOf(1));
    const t = await r.until(taskStarted("local_agent"), undefined, 30000);
    await pause(4000);
    r.control("bg-1", { subtype: "background_tasks", tool_use_id: t.tool_use_id });
    await r.until(isResp("bg-1"));
    await r.result();
    r.control("stop-1", { subtype: "stop_task", task_id: t.task_id });
    await r.until(isResp("stop-1"));
    await r.until(taskEnded, undefined, 15000).catch(() => null);
    await r.until(isResult, undefined, 20000).catch(() => null);
    await r.close();
  },
  // Messages sent while Claude works (item 72), each with its uuid: the
  // CLI's command_lifecycle for each, and one taken back before Claude took it.
  async queue() {
    const r = new Rec("queue", ["--tools", "Bash"]);
    r.user("Run the bash command `sleep 8; echo one`, then reply with just: one", uuidOf(1));
    await r.until((o) => o.type === "assistant" && o.message?.content?.some((b) => b.type === "tool_use"));
    r.user("Also end your reply with the word: two", uuidOf(2));
    r.user("Also end your reply with the word: three", uuidOf(3));
    await pause(500);
    r.control("cq-1", { subtype: "cancel_async_message", message_uuid: uuidOf(3) });
    await r.until(isResp("cq-1"));
    await r.result();
    // A turn of its own for what was queued, if the CLI makes one.
    await r.until(isResult, undefined, 30000).catch(() => null);
    await r.close();
  },
  // Send now on a queued message (item 72): interrupt with send_now and the
  // message's uuid, while a Bash call runs in the foreground.
  async sendnow() {
    const r = new Rec("sendnow", ["--tools", "Bash"]);
    r.user("Run the bash command `for i in $(seq 1 20); do echo tick $i; sleep 2; done` in the foreground (not in the background), then reply with just: one", uuidOf(1));
    const call = await r.until((o) => o.type === "assistant" && o.message?.content?.some((b) => b.type === "tool_use"));
    const t = (await r.until(taskStarted("local_bash"), undefined, 20000).catch(() => null)) ?? { tool_use_id: call.message.content.find((b) => b.type === "tool_use").id };
    r.user("Reply with just: two", uuidOf(2));
    await r.until((o) => o.type === "command_lifecycle" && o.command_uuid === uuidOf(2), undefined, 5000).catch(() => null);
    await pause(1000);
    r.control("sn-1", { subtype: "interrupt", send_now: true, message_uuid: uuidOf(2) });
    await r.until(isResp("sn-1"));
    await r.result();
    await r.until(isResult, undefined, 30000).catch(() => null);
    r.control("stop-1", { subtype: "stop_task", task_id: t.task_id });
    await r.until(isResp("stop-1"));
    await r.until(taskEnded, undefined, 15000).catch(() => null);
    await r.until(isResult, undefined, 20000).catch(() => null);
    await r.close();
  },
  // Send now as the panel does it while a step runs in the foreground: the
  // step goes to the background (background_tasks, no tool_use_id: all of
  // them) and the turn takes the queued message in — the send_now
  // interrupt above stops such a step instead.
  async sendnowbg() {
    const r = new Rec("sendnowbg", ["--tools", "Bash"]);
    r.user("Run the bash command `for i in $(seq 1 20); do echo tick $i; sleep 2; done` in the foreground (not in the background), then reply with just: one", uuidOf(1));
    const t = await r.until(taskStarted("local_bash"), undefined, 30000);
    r.user("Also end your reply with the word: two", uuidOf(2));
    await r.until((o) => o.type === "command_lifecycle" && o.command_uuid === uuidOf(2), undefined, 5000).catch(() => null);
    await pause(1000);
    r.control("bg-1", { subtype: "background_tasks" });
    await r.until(isResp("bg-1"));
    await r.result();
    await r.until(isResult, undefined, 20000).catch(() => null);
    r.control("stop-1", { subtype: "stop_task", task_id: t.task_id });
    await r.until(isResp("stop-1"));
    await r.until(taskEnded, undefined, 15000).catch(() => null);
    await r.until(isResult, undefined, 20000).catch(() => null);
    await r.close();
  },
  // Send now while Claude writes, no step running: the send_now interrupt.
  async sendnowtext() {
    const r = new Rec("sendnowtext", ["--tools", ""]);
    r.user("Write a 400-word story about a lighthouse keeper.", uuidOf(1));
    await r.until(firstText);
    r.user("Stop the story. Reply with just: two", uuidOf(2));
    await r.until((o) => o.type === "command_lifecycle" && o.command_uuid === uuidOf(2), undefined, 5000).catch(() => null);
    r.control("sn-1", { subtype: "interrupt", send_now: true, message_uuid: uuidOf(2) });
    await r.until(isResp("sn-1"));
    await r.result();
    await r.until(isResult, undefined, 30000).catch(() => null);
    await r.close();
  },
  // A Monitor's output (item 71): get_task_output reads Monitors as it reads shells.
  async monitor() {
    const r = new Rec("monitor", ["--tools", "Bash,Monitor"]);
    r.user("Use the Monitor tool to watch the output of the command `for i in $(seq 1 30); do echo tick $i; sleep 2; done`. Reply with just: watching", uuidOf(1));
    const t = await r.until((o) => o.type === "system" && o.subtype === "task_started", undefined, 30000);
    await r.result();
    await pause(3000);
    r.control("out-1", { subtype: "get_task_output", task_id: t.task_id });
    await r.until(isResp("out-1"));
    r.control("stop-1", { subtype: "stop_task", task_id: t.task_id });
    await r.until(isResp("stop-1"));
    await r.until(taskEnded, undefined, 15000).catch(() => null);
    await r.until(isResult, undefined, 20000).catch(() => null);
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
  // An MCP server's elicitation (decision 66), with the panel's initialize
  // first, declaring the dialogs it renders: a form accepted, then one
  // declined. The line after the initialize's answer is the account's
  // rate_limit_event (decision 67), kept with neutral numbers by sanitize.mjs.
  async elicit() {
    const r = new Rec("elicit", ["--tools", "", "--mcp-config", mcpConfig()]);
    r.control("init-1", { subtype: "initialize", supportedDialogKinds: core.DIALOG_KINDS });
    await r.until(isResp("init-1"));
    r.user("Call the pick_port tool once, then reply with just the tool's result text.");
    const ask = await r.until(isElicit);
    r.respond(ask, { action: "accept", content: { port: "/dev/ttyACM0", baud: 115200, parity: "none", verbose: false } });
    await r.result();
    r.user("Call the pick_port tool once more, then reply with just the tool's result text.");
    r.respond(await r.until(isElicit), { action: "decline" });
    await r.result();
    await r.close();
  },
  // Not a fixture: what the CLI does when nobody answers an elicitation
  // (the panel before decision 66, which sent no initialize either) — it
  // waits 20 s and writes down whatever comes, then declines.
  async elicitbare() {
    const r = new Rec("elicitbare", ["--tools", "", "--mcp-config", mcpConfig({ ELICIT_MODE: "url" })]);
    r.user("Call the pick_port tool once, then reply with just the tool's result text.");
    const ask = await r.until(isElicit);
    const t0 = Date.now();
    const late = await r.until((o) => o.type !== "stream_event", undefined, 20000).catch(() => null);
    fs.writeFileSync(path.join(scratch, "elicitbare.probe.txt"), `elicitation unanswered for ${Date.now() - t0} ms; next line: ${late ? JSON.stringify(late).slice(0, 300) : "none"}\n`);
    r.respond(ask, { action: "decline" });
    await r.result();
    await r.close();
  },
  // Claude Code's own autosave (decision 61): an SDK hook declared in
  // `initialize`, which the CLI calls back as a `hook_callback` control
  // request before each Read, Edit and Write, and waits on.
  async autosave() {
    const r = new Rec("autosave", ["--tools", "Read,Edit"]);
    r.onControl = (o) => o.request.subtype === "hook_callback" && r.respond(o, { continue: true });
    // The panel's own request (process.ts, src/wire/host.ts), so the recording declares what the panel does.
    r.control("init-1", { subtype: "initialize", supportedDialogKinds: core.DIALOG_KINDS, ...core.initializeRequest({ beforeFileTool: async () => {} }) });
    await r.until(isResp("init-1"));
    r.user("Read note.txt, then use the Edit tool to change MANGO to KIWI in it. Then reply with just: done");
    await r.result();
    await r.close();
  },
  // The panel's own MCP server (decision 65): named in initialize, then the
  // CLI speaks MCP to it as `mcp_message` control requests. Its Problems
  // panel is made up: one file, an error and a warning.
  async diagnostics() {
    const r = new Rec("diagnostics", ["--tools", "Read"]);
    const problems = [
      {
        uri: `file://${r.dir}/src/main.c`,
        diagnostics: [
          { message: "expected ';' before '}' token", severity: 0, range: { start: { line: 11, character: 14 }, end: { line: 11, character: 15 } }, source: "gcc" },
          { message: "unused variable 'count'", severity: 1, range: { start: { line: 4, character: 6 }, end: { line: 4, character: 11 } }, source: "clangd", code: "-Wunused-variable" },
        ],
      },
    ];
    const tool = { ...core.DIAGNOSTICS_TOOL, call: async (args) => core.formatDiagnostics(args.uri ? problems.filter((f) => f.uri === args.uri) : problems, !!args.uri) };
    // With autosave's hook beside it, and the dialogs: the one initialize the panel sends, all three parts.
    const hooks = { beforeFileTool: async () => {}, mcp: { [core.PANEL_MCP_SERVER]: core.mcpServer({ name: core.PANEL_MCP_SERVER, version: "0.1.0" }, [tool]) } };
    const answer = core.answererFor(hooks, console.log);
    r.onControl = (o) => answer(o.request)?.then((resp) => r.respond(o, resp));
    r.control("init-1", { subtype: "initialize", supportedDialogKinds: core.DIALOG_KINDS, ...core.initializeRequest(hooks) });
    r.user("Read note.txt, then call the getDiagnostics tool with no arguments, then reply in one line: the secret word, and how many errors and how many warnings it reports.");
    await r.result();
    await r.close();
  },
  // Some of a proposed Edit's changes (decision 64): in ask mode the Edit's
  // permission is answered with an input that keeps the first of its two
  // changes and not the second, as the diff tab's Accept sends it.
  async hunks() {
    const r = new Rec("hunks", ["--tools", "Read,Edit"]);
    const before = "alpha=1\nbeta=2\ngamma=3\ndelta=4\n";
    fs.writeFileSync(path.join(r.dir, "config.txt"), before);
    r.user("Read config.txt, then make ONE call to the Edit tool on it that changes alpha=1 to alpha=10 and delta=4 to delta=40 together, its old_string spanning from alpha=1 through delta=4. Then reply with just: done");
    await r.result((o) => {
      const inp = o.request.input;
      if (o.request.tool_name !== "Edit") return r.respond(o, { behavior: "allow", updatedInput: inp });
      const after = before.replace(inp.old_string, inp.new_string);
      const hunks = core.lineHunks(before, after);
      r.respond(o, { behavior: "allow", updatedInput: core.keptInput("Edit", inp, before, hunks, hunks.map((_, k) => k === 0)) });
    });
    await r.close();
    console.log(`hunks: config.txt is now ${JSON.stringify(fs.readFileSync(path.join(r.dir, "config.txt"), "utf8"))}`);
  },
  // A window reload mid-turn (decision 63): the extension host's deactivate
  // kills the chat's process (SIGTERM) while its Bash call runs; the next
  // process resumes with CLAUDE_CODE_RESUME_INTERRUPTED_TURN set, as Claude
  // Code's continueAfterReload spawns it, writes only the panel's
  // initialize, and the CLI continues the interrupted step on its own. The
  // fixture (wire/reload.jsonl) is reload-resumed's recording.
  async reload() {
    const signal = process.env.RELOAD_SIGNAL ?? "SIGTERM";
    const r = new Rec("reload", ["--tools", "Bash"], { persist: true });
    r.user("Run the bash command `sleep 12; echo slept` and then reply with just: done");
    await r.until((o) => o.type === "assistant" && o.message.content.some((b) => b.type === "tool_use"));
    await new Promise((res) => setTimeout(res, 4000));
    r.p.kill(signal);
    await r.close();
    const sid = r.lines.find((l) => l.o.type === "system" && l.o.subtype === "init").o.session_id;
    const env = { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1", CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "3600000" };
    const r2 = new Rec("reload-resumed", ["--tools", "Bash", "--resume", sid], { persist: true, dir: r.dir, env });
    r2.onControl = (o) => o.request.subtype === "hook_callback" && r2.respond(o, { continue: true });
    r2.control("init-1", { subtype: "initialize", supportedDialogKinds: core.DIALOG_KINDS, ...core.initializeRequest({ beforeFileTool: async () => {} }) });
    await r2.until((o) => o.type === "result", undefined, 60000).catch((e) => console.error(`reload: ${e.message}`));
    await r2.close();
  },
  // Export (decision 74): a closed chat resumed for `export_conversation`, asked
  // before any message — the text Claude Code's /export writes.
  async export() {
    const r = new Rec("exportsetup", ["--tools", "Bash"], { persist: true, dir: path.join(scratch, "export") });
    r.user("Run the bash command `echo hello-from-bash` and then reply with just: done");
    const res = await r.result();
    await r.close();
    const q = new Rec("export", ["--tools", "Bash", "--resume", res.session_id], { persist: true });
    q.control("ex-1", { subtype: "export_conversation" });
    await q.until(isResp("ex-1"));
    await q.close();
  },
  // Rewind (decision 73): with the SDK's file checkpointing on, as Claude Code's
  // panel spawns it, `rewind_files` at the second message — first a dry run,
  // then for real — puts a.txt back as the first turn left it. Then the
  // session as a closed chat has it: resumed, and a dry run at the first
  // message asked before any message.
  async rewind() {
    const env = { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" };
    const r = new Rec("rewind", ["--tools", "Read,Write,Edit"], { persist: true, env });
    r.user("Use the Write tool to create a.txt containing exactly the word: one. Then reply with just: done");
    const first = await r.until((o) => o.type === "user" && o.isReplay);
    await r.result();
    r.user("Use the Edit tool to change one to two in a.txt. Then reply with just: done");
    const second = await r.until((o) => o.type === "user" && o.isReplay);
    await r.result();
    fs.writeFileSync(path.join(scratch, "rewind.before"), fs.readFileSync(path.join(r.dir, "a.txt")));
    r.control("rw-1", { subtype: "rewind_files", user_message_id: second.uuid, dry_run: true });
    await r.until(isResp("rw-1"));
    r.control("rw-2", { subtype: "rewind_files", user_message_id: second.uuid });
    await r.until(isResp("rw-2"));
    fs.writeFileSync(path.join(scratch, "rewind.after"), fs.readFileSync(path.join(r.dir, "a.txt")));
    r.user("Reply with just: ok");
    const res = await r.result();
    await r.close();
    const q = new Rec("rewindresume", ["--tools", "Read,Write,Edit", "--resume", res.session_id], { persist: true, env, dir: "rewind" });
    q.control("rw-3", { subtype: "rewind_files", user_message_id: first.uuid, dry_run: true });
    await q.until(isResp("rw-3"));
    await q.close();
  },
  // Fork (decision 73): a new session from the parent's transcript up to the
  // entry before its second message — `--resume <parent> --fork-session
  // --session-id <new> --resume-session-at <entry>` — knows only the first.
  async fork() {
    const p = new Rec("forkparent", ["--tools", ""], { persist: true, dir: "fork" });
    p.user("Remember the word PELICAN. Reply with just: noted");
    await p.result();
    p.user("Also remember the word OTTER. Reply with just: noted");
    const second = await p.until((o) => o.type === "user" && o.isReplay);
    const res = await p.result();
    await p.close();
    const sid = res.session_id;
    const proj = path.join(os.homedir(), ".claude", "projects", p.dir.replace(/[^a-zA-Z0-9]/g, "-"));
    const lines = fs.readFileSync(path.join(proj, `${sid}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const at = lines.find((l) => l.uuid === second.uuid)?.parentUuid;
    const fid = randomUUID();
    fs.writeFileSync(path.join(scratch, "fork.ids"), JSON.stringify({ parent: sid, second: second.uuid, at, fork: fid }) + "\n");
    const f = new Rec("fork", ["--tools", "", "--resume", sid, "--fork-session", "--session-id", fid, "--resume-session-at", at], { persist: true });
    f.user("Which words did I ask you to remember? Reply with the words only.");
    await f.result();
    await f.close();
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
