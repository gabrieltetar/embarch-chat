// The editor's open file and selection, which go with a message by default
// (decision 60), as Claude Code's panel sends them (its attachOpenFile and
// attachSelection settings): the selected lines with their text, else the
// file that is open. Followed as the owner moves — a selection 300 ms after
// it last changed, as Claude Code waits — and shown in each chat page as a
// chip with an ×.

import { EventEmitter } from "events";
import * as path from "path";
import * as vscode from "vscode";
import type { ContextItem } from "./wire/message";

export type EditorItem = Extract<ContextItem, { kind: "selection" | "file" }>;

export interface AttachSettings {
  attachOpenFile: boolean;
  attachSelection: boolean;
}

/** What goes with a message from this editor, by the two settings: off, a selection still goes; both off, nothing. */
export function editorItem(ed: vscode.TextEditor, s: AttachSettings): EditorItem | null {
  const file = ed.document.uri.fsPath;
  const sel = ed.selection;
  if (!sel.isEmpty && s.attachSelection) {
    const a = sel.start.line + 1;
    // A selection ending at a line's start holds none of that line.
    const b = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return { kind: "selection", path: file, startLine: a, endLine: b, text: ed.document.getText(sel) };
  }
  return s.attachOpenFile ? { kind: "file", path: file } : null;
}

/** The chip's words: the path from the chat's folder, and the lines. */
export function editorLabel(item: EditorItem, cwd: string): string {
  const r = cwd ? path.relative(cwd, item.path) : item.path;
  const p = !r || r.startsWith("..") || path.isAbsolute(r) ? item.path : r;
  return item.kind === "selection" ? `${p}#L${item.startLine}${item.endLine > item.startLine ? `-${item.endLine}` : ""}` : p;
}

const same = (a: EditorItem | null, b: EditorItem | null) => JSON.stringify(a) === JSON.stringify(b);

/** Events: `changed` (the item, or null). */
export class EditorContext extends EventEmitter implements vscode.Disposable {
  current: EditorItem | null = null;
  private editor: vscode.TextEditor | undefined;
  private timer: NodeJS.Timeout | undefined;
  private subs: vscode.Disposable[] = [];

  constructor(private settings: () => AttachSettings) {
    super();
    const w = vscode.window;
    this.subs.push(
      w.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor !== w.activeTextEditor) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.follow(e.textEditor), 300);
      }),
      w.onDidChangeActiveTextEditor((ed) => {
        // Focus in a webview (a chat's own tab) leaves no active text
        // editor: the last one counts while an editor still shows, as in
        // Claude Code.
        if (ed) this.follow(ed);
        else if (!w.visibleTextEditors.length) this.set(null, undefined);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (this.editor?.document === d) this.set(null, undefined);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("embarchChat.attachOpenFile") || e.affectsConfiguration("embarchChat.attachSelection")) this.follow(this.editor);
      }),
    );
    this.follow(w.activeTextEditor);
  }

  /** Now, not after the selection's pause: a key that acts on the selection reads it at once (59). */
  refresh(ed: vscode.TextEditor): void {
    this.follow(ed);
  }

  /** An editor on something other than a file on disk (a diff side, an output pane) leaves the last one as it was. */
  private follow(ed: vscode.TextEditor | undefined): void {
    clearTimeout(this.timer);
    if (!ed) return this.set(null, undefined);
    if (ed.document.uri.scheme !== "file") return;
    this.set(editorItem(ed, this.settings()), ed);
  }

  private set(item: EditorItem | null, ed: vscode.TextEditor | undefined): void {
    this.editor = ed;
    if (same(item, this.current)) return;
    this.current = item;
    this.emit("changed", item);
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
    this.removeAllListeners();
  }
}
