// @ completes a workspace path, with the selected lines, and the CLI inlines
// it (decision 8): the panel only has to put `@path` in the message. The
// window's terminals are offered too: one picked goes with the message as
// its output (decision 58), not as text.

import * as path from "path";
import * as vscode from "vscode";
import type { MentionItem } from "../webview/shared/protocol";
import { terminalRefs } from "./terminals";

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

/** An editor's file as an @-mention from `cwd`, with its selected lines: `src/main.c#L10-24`. */
export function mentionOf(ed: vscode.TextEditor, cwd: string): string {
  const p = rel(cwd, ed.document.uri.fsPath);
  const sel = ed.selection;
  if (sel.isEmpty) return p;
  const a = sel.start.line + 1;
  const b = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return `${p}#L${a}${b > a ? `-${b}` : ""}`;
}

/** Ranked: the active selection first, then basename prefix, then path substring, then subsequence. */
export async function mentionItems(q: string, cwd: string): Promise<MentionItem[]> {
  const out: MentionItem[] = [];
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === "file" && !ed.selection.isEmpty) {
    const insert = mentionOf(ed, cwd);
    if (!q || rel(cwd, ed.document.uri.fsPath).toLowerCase().includes(q.toLowerCase())) out.push({ insert, label: insert, detail: "selected lines" });
  }
  const needle = q.toLowerCase();
  // Each terminal, two of one name told apart by their process (58).
  const terms = await terminalRefs();
  for (const t of terms) {
    const name = t.name;
    if (needle && !name.toLowerCase().includes(needle) && !"terminal".startsWith(needle)) continue;
    const twin = terms.filter((x) => x.name === name).length > 1;
    const which = twin ? (t.pid !== undefined ? ` · pid ${t.pid}` : ` · #${t.index + 1}`) : "";
    out.push({ insert: name, label: name, detail: `terminal output${which}`, terminal: t });
  }
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
