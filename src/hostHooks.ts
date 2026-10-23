// What this window does for its chats' CLIs (src/wire/host.ts), by the
// owner's settings, read as each process starts. Every one of them is
// machine-scoped: what runs on Claude's tool calls is not a workspace's to
// change (decision 48).

import * as vscode from "vscode";
import type { HostHooks } from "./wire/host";
import { saveIfDirty } from "./autosave";
import { DIAGNOSTICS_TOOL, FileDiagnostics, PANEL_MCP_SERVER, formatDiagnostics } from "./diagnostics";
import { mcpServer } from "./mcpServer";

export function hostHooks(log: (s: string) => void): HostHooks {
  const c = vscode.workspace.getConfiguration("embarchChat");
  const h: HostHooks = {};
  if (c.get<boolean>("autosave", true)) h.beforeFileTool = (tool, file, cwd) => saveIfDirty(tool, file, cwd, log);
  if (c.get<boolean>("diagnosticsTool", false)) {
    h.mcp = { [PANEL_MCP_SERVER]: mcpServer({ name: PANEL_MCP_SERVER, version: "0.1.0" }, [{ ...DIAGNOSTICS_TOOL, call: getDiagnostics }]) };
  }
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
