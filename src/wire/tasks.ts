// Work that runs on its own (port item 70): a Bash call or a subagent in the
// foreground can be moved to the background. Pure, shared by the host and
// the page.

import type { ToolEntry } from "./reducer";

/**
 * A step "Run in background" can move: one the CLI registered as a task in
 * the foreground (task_started with is_backgrounded false — a Bash call or
 * a subagent; an MCP call never is), still running. As Claude Code's own
 * panel decides it (its foregroundCalls).
 */
export function movable(t: ToolEntry): boolean {
  return !!t.task && t.background === false && !t.taskEnd && t.status === "running";
}
