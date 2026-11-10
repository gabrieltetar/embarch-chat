// What this window does for its chats' CLIs (src/wire/host.ts), by the
// owner's settings, read as each process starts. Every one of them is
// machine-scoped: what runs on Claude's tool calls is not a workspace's to
// change (decision 48).

import * as vscode from "vscode";
import type { HostHooks } from "./wire/host";
import { saveIfDirty } from "./autosave";
import { DIAGNOSTICS_TOOL, FileDiagnostics, PANEL_MCP_SERVER, formatDiagnostics } from "./diagnostics";
import { HANDOFF_TOOL, HandoffPort, handoffSetting } from "./handoff";
import { McpTool, mcpServer } from "./mcpServer";

/** For one chat's process: `cwd` is the folder the chat runs in, the only one besides the window's whose files autosave touches (61). */
export function hostHooks(log: (s: string) => void, cwd: string, chat: HandoffPort): HostHooks {
  const c = vscode.workspace.getConfiguration("embarchChat");
  const h: HostHooks = {};
  if (c.get<boolean>("autosave", true)) h.beforeFileTool = (tool, file, hookCwd) => saveIfDirty(tool, file, hookCwd, cwd, log);
  // The panel's one MCP server carries whichever tools are on; with none, it is not declared (65, 103).
  const tools: McpTool[] = [];
  if (c.get<boolean>("diagnosticsTool", false)) tools.push({ ...DIAGNOSTICS_TOOL, call: getDiagnostics });
  const how = handoffSetting(c.get<string>("handoff", "card"));
  if (how !== "off") tools.push({ ...HANDOFF_TOOL, call: (args) => chat.handoff(typeof args.prompt === "string" ? args.prompt : "", how) });
  if (tools.length) h.mcp = { [PANEL_MCP_SERVER]: mcpServer({ name: PANEL_MCP_SERVER, version: "0.1.0" }, tools) };
  return h;
}

/** The Problems panel, all of it or one file's (decision 65). */
async function getDiagnostics(args: Record<string, unknown>): Promise<string> {
  const asked = typeof args.uri === "string" && args.uri ? args.uri : null;
  // A file:// URI as the tool asks, or a bare path as Claude may pass one.
  const one = asked ? (/^[a-z][a-z0-9+.-]+:/i.test(asked) ? vscode.Uri.parse(asked) : vscode.Uri.file(asked)) : null;
  const all: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = one ? [[one, vscode.languages.getDiagnostics(one)]] : vscode.languages.getDiagnostics();
  const files: FileDiagnostics[] = all.map(([u, ds]) => ({
    uri: u.toString(true),
    diagnostics: ds.map((d) => ({
      message: d.message,
      severity: d.severity,
      range: { start: { line: d.range.start.line, character: d.range.start.character }, end: { line: d.range.end.line, character: d.range.end.character } },
      source: d.source,
      code: d.code as FileDiagnostics["diagnostics"][number]["code"],
    })),
  }));
  return formatDiagnostics(files, !!one);
}
