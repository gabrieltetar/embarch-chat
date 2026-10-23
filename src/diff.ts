// An Edit or Write shows as a diff and opens VS Code's diff editor on a
// click (decision 8). Before and after come from the tool call itself: the
// CLI's own `originalFile` once it ran, the file on disk while it waits for
// permission.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const DIFF_SCHEME = "embarch-chat-diff";

export function applyEdit(text: string, oldS: string, newS: string, all: boolean): string {
  if (!oldS) return text;
  if (all) return text.split(oldS).join(newS);
  const i = text.indexOf(oldS);
  return i < 0 ? text : text.slice(0, i) + newS + text.slice(i + oldS.length);
}

export interface DiffSides {
  file: string;
  before: string;
  after: string;
}

/** Before and after for an Edit, MultiEdit or Write call; null for any other tool. */
export function diffSides(name: string, input: Record<string, unknown>, structured: unknown, cwd: string): DiffSides | null {
  const file = String(input.file_path ?? input.notebook_path ?? "");
  if (!file || !["Edit", "MultiEdit", "Write"].includes(name)) return null;
  const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
  const s = (structured && typeof structured === "object" ? structured : {}) as { originalFile?: string | null };
  let before: string;
  if ("originalFile" in s) before = s.originalFile ?? "";
  else {
    try {
      before = fs.readFileSync(abs, "utf8");
    } catch {
      before = "";
    }
  }
  let after = before;
  if (name === "Write") after = String(input.content ?? "");
  else if (name === "Edit") after = applyEdit(before, String(input.old_string ?? ""), String(input.new_string ?? ""), Boolean(input.replace_all));
  else if (Array.isArray(input.edits)) {
    for (const e of input.edits as Array<Record<string, unknown>>) after = applyEdit(after, String(e.old_string ?? ""), String(e.new_string ?? ""), Boolean(e.replace_all));
  }
  return { file: abs, before, after };
}

export class DiffContent implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private n = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? "";
  }

  async open(d: DiffSides): Promise<void> {
    const key = ++this.n;
    const base = path.basename(d.file);
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/before/${base}` });
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/after/${base}` });
    this.docs.set(left.path, d.before);
    this.docs.set(right.path, d.after);
    // Keep the last few only; a diff tab re-reads its document on reopen.
    if (this.docs.size > 40) {
      const old = [...this.docs.keys()].slice(0, this.docs.size - 40);
      for (const k of old) this.docs.delete(k);
    }
    await vscode.commands.executeCommand("vscode.diff", left, right, `${base} — Claude's change`, { preview: true });
  }
}
