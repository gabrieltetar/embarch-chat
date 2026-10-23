// Work that runs on its own (port items 70 and 71): a Bash call or a
// subagent in the foreground can be moved to the background, and each
// background task — a shell, a Monitor, a subagent — shows its latest output
// or progress, with a Stop of its own. Send now (item 72) moves such a step
// first. Pure, shared by the host and the page.

import type { ChatState, ToolEntry } from "./reducer";

/**
 * A step "Run in background" can move: one the CLI registered as a task in
 * the foreground (task_started with is_backgrounded false — a Bash call or
 * a subagent; an MCP call never is), still running. As Claude Code's own
 * panel decides it (its foregroundCalls).
 */
export function movable(t: ToolEntry): boolean {
  return !!t.task && t.background === false && !t.taskEnd && t.status === "running";
}

/** Whether any step of the chat runs in the foreground with a task: Send now moves those to the background first. */
export function anyMovable(s: ChatState): boolean {
  return Object.values(s.entries).some((e) => e.kind === "tool" && movable(e));
}

/**
 * A Bash call or a subagent that runs but has no task yet: the CLI
 * registers one as it starts (recorded: within a second of the call), and
 * then it can move.
 */
export function soonMovable(s: ChatState): boolean {
  return Object.values(s.entries).some((e) => e.kind === "tool" && e.status === "running" && !e.task && !e.background && ["Bash", "Agent", "Task"].includes(e.name));
}

/** What a background task is, in the owner's words. A Monitor is a local_bash task too; its call says so. */
export function taskKind(type: string, tool?: ToolEntry): string {
  if (tool?.name === "Monitor") return "monitor";
  if (type === "local_bash") return "shell";
  if (type === "local_agent") return "agent";
  return type.replace(/^local_/, "");
}

/** Whether `get_task_output` reads it: shells and Monitors (both local_bash), not agents. */
export function hasOutput(type: string): boolean {
  return type === "local_bash";
}

// CSI and OSC sequences, and the lone ESC forms: the output is the command's own, escapes included (CLI schema).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;

/** A task's output as plain text: escape sequences out, a carriage-return redraw kept as its last state per line. */
export function plainOutput(s: string): string {
  return s
    .replace(ANSI, "")
    .split("\n")
    .map((l) => {
      const i = l.lastIndexOf("\r", l.length - 2);
      return (i >= 0 ? l.slice(i + 1) : l).replace(/\r$/, "");
    })
    .join("\n");
}
