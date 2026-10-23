// Claude reads the Problems panel (decision 65): Claude Code's IDE tool
// `getDiagnostics`, served by the panel's own MCP server (mcpServer.ts)
// over the chat's stdio. Off by default — the owner's own instructions tell
// Claude to ignore IDE diagnostics unless asked — and machine-scoped. This
// file is the tool as Claude sees it and the answer's shape; hostHooks.ts
// reads VS Code's diagnostics into it.

import type { McpTool } from "./mcpServer";

/** The server's name: the tool reaches Claude as `mcp__embarch-chat__getDiagnostics`. */
export const PANEL_MCP_SERVER = "embarch-chat";

/** Claude Code's own (2.1.309), so Claude uses it as it would there. */
export const DIAGNOSTICS_TOOL: Omit<McpTool, "call"> = {
  name: "getDiagnostics",
  description:
    "Get the errors, warnings and other diagnostics VS Code currently shows in its Problems panel, including those for unsaved changes in open editors. Returns a JSON array with one entry per file. Pass `uri` to check one file, or omit it to get every file VS Code currently has diagnostics for. Many language extensions only analyze open files, so a missing file or an empty list can mean the file has not been checked, not that it is clean.",
  inputSchema: {
    type: "object",
    properties: { uri: { type: "string", description: "file:// URI of the one file to check. Omit to get every file VS Code currently has diagnostics for." } },
    additionalProperties: false,
  },
  annotations: { title: "Get diagnostics", readOnlyHint: true },
};

/** One file's diagnostics, as VS Code holds them (severity 0 = Error … 3 = Hint, lines from 0). */
export interface FileDiagnostics {
  uri: string;
  diagnostics: Array<{
    message: string;
    severity: number;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    source?: string;
    code?: string | number | { value: string | number };
  }>;
}

const SEVERITY = ["Error", "Warning", "Information", "Hint"];
/** A Problems panel can hold thousands of entries: files past this many characters are left out, and the answer says how many. */
const MAX_CHARS = 100_000;

/** The tool's answer: Claude Code's shape (one entry per file), files without diagnostics left out unless asked for by name. */
export function formatDiagnostics(files: FileDiagnostics[], asked: boolean): string {
  const out: unknown[] = [];
  let size = 2;
  let left = 0;
  for (const f of files) {
    if (!f.diagnostics.length && !asked) continue;
    const entry = {
      uri: f.uri,
      diagnostics: f.diagnostics.map((d) => ({
        message: d.message,
        severity: SEVERITY[d.severity] ?? String(d.severity),
        range: d.range,
        ...(d.source ? { source: d.source } : {}),
        ...(d.code !== undefined ? { code: String(typeof d.code === "object" ? d.code.value : d.code) } : {}),
      })),
    };
    const n = JSON.stringify(entry, null, 2).length + 2;
    if (size + n > MAX_CHARS) {
      left++;
      continue;
    }
    size += n;
    out.push(entry);
  }
  if (left) out.push({ note: `${left} more file(s) left out (the answer is capped at ${MAX_CHARS} characters); pass uri to check one file.` });
  return JSON.stringify(out, null, 2);
}
