// A tool's whole input or output in an editor tab (decision 62), as Claude
// Code's panel opens one (`open_content`): read-only — a virtual document,
// so closing it asks nothing — in a language that suits it, so a serial or
// build log past 100K characters gets Ctrl+F, the minimap and log colours
// instead of the row's 4K preview.

import * as vscode from "vscode";
import type { ToolEntry } from "./wire/reducer";

export const CONTENT_SCHEME = "embarch-chat-content";

/** What a tool's input or output opens as: its text, the tab's name and a language; null when there is none. */
export function toolContent(t: Pick<ToolEntry, "name" | "input" | "result">, part: "input" | "output"): { text: string; name: string; language: string } | null {
  const label = t.name.replace(/^mcp__.+?__/, "");
  if (part === "input") {
    if (t.name === "Bash") return { text: String(t.input.command ?? ""), name: `${label} command.sh`, language: "shellscript" };
    return { text: JSON.stringify(t.input, null, 2), name: `${label} input.json`, language: "json" };
  }
  if (!t.result) return null;
  // An MCP tool's answer is often JSON; anything else reads as a log.
  let json = false;
  try {
    json = typeof JSON.parse(t.result) === "object";
  } catch {
    /* text */
  }
  return json ? { text: t.result, name: `${label} output.json`, language: "json" } : { text: t.result, name: `${label} output.log`, language: "log" };
}

export class ContentDocs implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? "";
  }

  /** Opens it as a preview tab; the same tool's same part opens the same tab again. */
  async open(t: Pick<ToolEntry, "id" | "name" | "input" | "result">, part: "input" | "output"): Promise<void> {
    const c = toolContent(t, part);
    if (!c) return;
    const uri = vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${t.id}/${c.name}` });
    this.docs.set(uri.path, c.text);
    // Keep the last few only, as the diffs do.
    if (this.docs.size > 40) for (const k of [...this.docs.keys()].slice(0, this.docs.size - 40)) this.docs.delete(k);
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== c.language) doc = await vscode.languages.setTextDocumentLanguage(doc, c.language).then((d) => d, () => doc);
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
  }
}
