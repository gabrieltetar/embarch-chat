// What the panel does for the CLI itself, over the control channel, as
// Claude Code's own panel does through its SDK: hooks declared in
// `initialize` and called back as `hook_callback` requests (decision 61),
// and MCP servers of the panel's own, named in `initialize` and spoken to as
// `mcp_message` requests (65). Nothing here knows VS Code: the extension
// hands in what each one does.

import type { ControlAnswerer } from "./process";

export interface HostHooks {
  /** Before a Read, Edit or Write runs (Claude Code's `saveFileIfNeeded`, 61): save that file's unsaved changes. Never stops the tool. */
  beforeFileTool?: (tool: string, file: string, cwd: string) => Promise<void>;
  /** The panel's own MCP servers by name (65): one JSON-RPC message in, its reply out (null for a notification). */
  mcp?: Record<string, (message: Record<string, unknown>) => Promise<Record<string, unknown> | null>>;
}

/** Claude Code's own matcher for its autosave hook. */
const FILE_TOOLS = ["Edit", "Write", "Read"];
const SAVE_HOOK = "save_before_file_tool";

/** The `initialize` request's fields for these hooks and servers; null when there is nothing to declare. */
export function initializeRequest(h: HostHooks): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  if (h.beforeFileTool) fields.hooks = { PreToolUse: [{ matcher: FILE_TOOLS.join("|"), hookCallbackIds: [SAVE_HOOK] }] };
  const servers = Object.keys(h.mcp ?? {});
  if (servers.length) fields.sdkMcpServers = servers;
  return Object.keys(fields).length ? fields : null;
}

/** Answers the CLI's calls into what `initializeRequest` declared; anything else goes on as a message. */
export function answererFor(h: HostHooks, log: (line: string) => void): ControlAnswerer {
  return (req) => {
    if (req.subtype === "hook_callback") {
      if (req.callback_id !== SAVE_HOOK || !h.beforeFileTool) return Promise.reject(new Error(`no hook ${String(req.callback_id)}`));
      const input = (req.input ?? {}) as { tool_name?: string; tool_input?: { file_path?: unknown }; cwd?: string };
      const file = input.tool_input?.file_path;
      const run =
        typeof file === "string" && FILE_TOOLS.includes(String(input.tool_name))
          ? h.beforeFileTool(String(input.tool_name), file, input.cwd ?? "").catch((e: Error) => log(`autosave: ${e.message}`))
          : Promise.resolve();
      // Whatever the save did, the tool goes ahead.
      return run.then(() => ({ continue: true }));
    }
    if (req.subtype === "mcp_message") {
      const serve = h.mcp?.[String(req.server_name)];
      if (!serve) return Promise.reject(new Error(`no MCP server ${String(req.server_name)}`));
      // A notification has no reply; the SDK answers it with an empty result, and so does this.
      return serve((req.message ?? {}) as Record<string, unknown>).then((r) => ({ mcp_response: r ?? { jsonrpc: "2.0", result: {}, id: 0 } }));
    }
    return null;
  };
}
