// Before Claude reads, edits or writes a file, the editor's unsaved changes
// to it are saved (decision 61), as Claude Code's own panel does with its
// `claudeCode.autosave` PreToolUse hook: the owner edits an overlay or a
// Kconfig fragment and asks Claude to build, and Claude reads what is on
// screen, not the disk copy — and its Edit neither fails on the unsaved
// change nor writes over it.

import * as path from "path";
import * as vscode from "vscode";

/** How long a save may hold the tool call; past it the tool goes ahead with the file as it is on disk. */
const SAVE_WAIT_MS = 5000;

/** Saves `file` if the window has it open with unsaved changes; a file not open, or open unchanged, is left alone. */
export async function saveIfDirty(tool: string, file: string, cwd: string, log: (s: string) => void): Promise<void> {
  // A path only: a URI is never a file of this window's (one letter is a Windows drive).
  if (/^[a-z][a-z0-9+.-]+:/i.test(file)) return;
  const abs = path.resolve(cwd || "/", file);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === abs);
  if (!doc?.isDirty) return;
  const saved = await Promise.race([
    Promise.resolve(doc.save()),
    new Promise<"late">((r) => setTimeout(() => r("late"), SAVE_WAIT_MS).unref()),
  ]);
  if (saved === "late") log(`autosave: ${abs} still saving after ${SAVE_WAIT_MS / 1000} s; ${tool} goes ahead with the disk copy`);
  else log(`autosave: ${abs} ${saved ? "saved" : "not saved"} before ${tool}`);
}
