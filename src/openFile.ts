// Opening what a reply's file link names (decision 93), as a tab of its own
// in the chat's editor group (92): the file as written, else the one the
// chat's own steps read or edited, else from a folder above the chat's,
// else the chat's folder's one file of that name — a choice when several
// match, a message when none does. A folder shows in the Explorer.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { FileTarget } from "./fileLinks";
import { globLiteral, parseFileLink, resolveFileLink, touchedMatches } from "./fileLinks";

/** Never searched: what a build, a package manager or git keeps. */
const EXCLUDE = "**/{node_modules,.git,build,target,dist,out}/**";

const isFile = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isFile();

export async function openFileLink(raw: string, line: number | undefined, cwd: string, inputs: unknown[], column: vscode.ViewColumn): Promise<void> {
  const t = parseFileLink(raw, line);
  if (!t) return;
  const found = await locate(t.path, cwd, inputs);
  if (found) return openAt(found, t, column);
  void vscode.window.showInformationMessage(`No file ${t.path} under ${cwd || "this window's folder"}, or above it.`);
}

async function locate(p: string, cwd: string, inputs: unknown[]): Promise<string | undefined> {
  const home = os.homedir();
  const exact = resolveFileLink(p, cwd, home);
  if (exact) return exact;
  const touched = touchedMatches(p, inputs, cwd).filter(isFile);
  if (touched.length === 1) return touched[0];
  if (!touched.length) {
    const up = resolveFileLink(p, cwd, home, { up: true });
    if (up) return up;
  }
  const rel = p.replace(/^(\.\/)+/, "");
  let hits: string[] = [];
  if (cwd && !path.isAbsolute(rel) && !rel.startsWith("~") && !rel.split("/").includes("..")) {
    const uris = await Promise.resolve(vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(cwd), `**/${globLiteral(rel)}`), EXCLUDE, 50)).catch(() => []);
    hits = uris.map((u) => u.fsPath).sort();
  }
  const all = [...touched, ...hits.filter((h) => !touched.includes(h))];
  if (all.length <= 1) return all[0];
  const pick = await vscode.window.showQuickPick(
    all.map((f) => ({ label: path.relative(cwd, f), description: touched.includes(f) ? "read or edited in this chat" : undefined, f })),
    { placeHolder: `More than one ${path.basename(rel)}: which one?` },
  );
  return pick?.f;
}

/** A file in `column`, at its lines when the link names them; a folder in the Explorer. */
export async function openAt(file: string, t: Pick<FileTarget, "line" | "endLine" | "column">, column: vscode.ViewColumn): Promise<void> {
  const uri = vscode.Uri.file(file);
  if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) {
    await vscode.commands.executeCommand("revealInExplorer", uri);
    return;
  }
  const opts: vscode.TextDocumentShowOptions = { viewColumn: column, preview: false };
  if (t.line) {
    const start = new vscode.Position(t.line - 1, Math.max(0, (t.column ?? 1) - 1));
    // A range takes its last line whole: up to the start of the next.
    opts.selection = new vscode.Range(start, t.endLine ? new vscode.Position(t.endLine, 0) : start);
  }
  // `vscode.open`, not a text document: an image or a PDF opens in its own editor.
  await vscode.commands.executeCommand("vscode.open", uri, opts);
}
