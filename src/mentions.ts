// @ completes a workspace path, with the selected lines, and the CLI inlines
// it (decision 8): the panel only has to put `@path` in the message.

import * as path from "path";
import * as vscode from "vscode";
import type { MentionItem } from "../webview/shared/protocol";

const EXCLUDE = "**/{node_modules,.git,target,build,dist,out,.venv,__pycache__}/**";
let cache: { at: number; files: vscode.Uri[] } | null = null;

async function files(): Promise<vscode.Uri[]> {
  if (cache && Date.now() - cache.at < 30000) return cache.files;
  const found = await vscode.workspace.findFiles("**/*", EXCLUDE, 20000);
  cache = { at: Date.now(), files: found };
  return found;
}

function rel(cwd: string, abs: string): string {
  const r = path.relative(cwd, abs);
  return r.startsWith("..") ? abs : r;
}

/** Ranked: the active selection first, then basename prefix, then path substring, then subsequence. */
export async function mentionItems(q: string, cwd: string): Promise<MentionItem[]> {
  const out: MentionItem[] = [];
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === "file") {
    const p = rel(cwd, ed.document.uri.fsPath);
    const sel = ed.selection;
    if (!sel.isEmpty && (!q || p.toLowerCase().includes(q.toLowerCase()))) {
      const a = sel.start.line + 1;
      const b = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      const insert = `${p}#L${a}${b > a ? `-${b}` : ""}`;
      out.push({ insert, label: insert, detail: "selected lines" });
    }
  }
  const needle = q.toLowerCase();
  const scored: Array<{ s: number; p: string }> = [];
  for (const u of await files()) {
    const p = rel(cwd, u.fsPath);
    const lp = p.toLowerCase();
    const base = path.basename(lp);
    let s = -1;
    if (!needle) s = 1;
    else if (base.startsWith(needle)) s = 4;
    else if (base.includes(needle)) s = 3;
    else if (lp.includes(needle)) s = 2;
    else {
      let i = 0;
      for (const ch of lp) if (ch === needle[i]) i++;
      if (i === needle.length) s = 1;
    }
    if (s > 0) scored.push({ s: s * 1000 - p.length, p });
  }
  scored.sort((a, b) => b.s - a.s);
  for (const { p } of scored.slice(0, 30)) out.push({ insert: p, label: path.basename(p), detail: path.dirname(p) === "." ? "" : path.dirname(p) });
  return out;
}
