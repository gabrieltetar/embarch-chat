// An Edit or Write shows as a diff and opens VS Code's diff editor on a
// click (decision 8). Before and after come from the tool call itself: the
// CLI's own `originalFile` once it ran, the file on disk while it waits for
// permission.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { Chat } from "./wire/chat";
import type { Pending } from "./wire/reducer";
import { Hunk, applyHunks, keptInput, lineHunks, perChange } from "./hunks";

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

// ------------------------------------------------------------ change by change (decision 64)

/**
 * A pending Edit or Write opens with a Reject on each of its changes, as
 * Claude Code's diff tab has its hunk bars; the tab's title bar answers the
 * prompt — Accept with only the kept changes, or Reject. The chat's pending
 * input follows each choice, so the card's own Allow sends the same.
 */
export const PROPOSAL_SCHEME = "embarch-chat-proposal";

interface Proposal {
  sid: string;
  requestId: string;
  name: string;
  /** The call as Claude proposed it. */
  input: Record<string, unknown>;
  before: string;
  hunks: Hunk[];
  keep: boolean[];
  /** The proposed side (`/<request>/<file>`) and the file before (`/<request>/before/<file>`). */
  uri: vscode.Uri;
  left: vscode.Uri;
}

/** What a proposal answers through: the chat a session id names. */
export type ChatOf = (sid: string) => Chat | undefined;

const REJECTED_ALL = "The user rejected every change of this edit.";

export class Proposals implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private byPath = new Map<string, Proposal>();
  private changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;

  constructor(private chatOf: ChatOf) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const p = this.byPath.get(uri.path);
    if (!p) return "";
    return uri.path === p.left.path ? p.before : applyHunks(p.before, p.hunks, p.keep).text;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const p = this.byPath.get(doc.uri.path);
    if (!p || doc.uri.path !== p.uri.path) return [];
    const { starts } = applyHunks(p.before, p.hunks, p.keep);
    return p.hunks.map((_, k) => {
      const at = new vscode.Position(Math.min(starts[k], Math.max(0, doc.lineCount - 1)), 0);
      const title = p.keep[k] ? "$(discard) Reject this change" : "$(check) Rejected — keep it after all";
      return new vscode.CodeLens(new vscode.Range(at, at), { title, command: "embarchChat.toggleChange", arguments: [p.uri.path, k] });
    });
  }

  /** Opens a pending Edit's or Write's diff change by change; false for a call that cannot be taken so (the plain diff opens instead). */
  async open(sid: string, pending: Pending, cwd: string): Promise<boolean> {
    let p = [...this.byPath.values()].find((x) => x.requestId === pending.requestId);
    if (!p) {
      const sides = diffSides(pending.toolName, pending.input, undefined, cwd);
      if (!sides || !perChange(pending.toolName, pending.input, sides.before)) return false;
      const hunks = lineHunks(sides.before, sides.after);
      if (!hunks.length) return false;
      const base = path.basename(sides.file);
      const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${pending.requestId}/${base}` });
      const left = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${pending.requestId}/before/${base}` });
      p = { sid, requestId: pending.requestId, name: pending.toolName, input: pending.input, before: sides.before, hunks, keep: hunks.map(() => true), uri, left };
      this.byPath.set(uri.path, p);
      this.byPath.set(left.path, p);
    }
    await vscode.commands.executeCommand("vscode.diff", p.left, p.uri, `${path.basename(p.uri.path)} — Claude's proposed change`, { preview: true });
    return true;
  }

  /** Rejects a kept change, or keeps a rejected one; the prompt's input follows. */
  toggle(at: string, k: number): void {
    const p = this.byPath.get(at);
    if (!p || k < 0 || k >= p.hunks.length) return;
    const keep = p.keep.slice();
    keep[k] = !keep[k];
    let input: Record<string, unknown> | null;
    try {
      input = keptInput(p.name, p.input, p.before, p.hunks, keep);
    } catch (e) {
      void vscode.window.showWarningMessage(`Not changed: ${(e as Error).message}.`);
      return;
    }
    p.keep = keep;
    this.changed.fire(p.uri);
    this.lensesChanged.fire();
    const kept = keep.filter(Boolean).length;
    const label = kept === keep.length ? null : kept ? `${kept} of ${keep.length} changes kept` : `all ${keep.length} changes rejected`;
    this.chatOf(p.sid)?.propose(p.requestId, input ?? p.input, label);
  }

  /** Every change rejected: Allow answers as Reject. */
  rejectsAll(requestId: string): boolean {
    const p = [...this.byPath.values()].find((x) => x.requestId === requestId);
    return !!p && !p.keep.some(Boolean);
  }

  /** The tab's Accept: the kept changes, or a reject when none is kept. */
  accept(uri?: vscode.Uri): void {
    this.answer(uri, (chat, pending, p) => (p.keep.some(Boolean) ? chat.allow(pending) : chat.deny(pending, REJECTED_ALL)));
  }

  /** The tab's Reject: none of it. */
  reject(uri?: vscode.Uri): void {
    this.answer(uri, (chat, pending) => chat.deny(pending));
  }

  private answer(uri: vscode.Uri | undefined, f: (chat: Chat, pending: Pending, p: Proposal) => void): void {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const p = target && this.byPath.get(target.path);
    if (!p) return;
    const chat = this.chatOf(p.sid);
    const pending = chat?.state.pending.find((x) => x.requestId === p.requestId);
    if (chat && pending) f(chat, pending, p);
    else void vscode.window.showInformationMessage("This change was already answered.");
    this.done(p.requestId);
  }

  /** The prompt was answered, here or on its card: its proposal and its tab go. */
  done(requestId: string): void {
    const p = [...this.byPath.values()].find((x) => x.requestId === requestId);
    if (!p) return;
    this.byPath.delete(p.uri.path);
    this.byPath.delete(p.left.path);
    const tabs = (vscode.window.tabGroups?.all ?? []).flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === p.uri.toString());
    if (tabs.length) void vscode.window.tabGroups.close(tabs);
  }
}

export function registerProposals(context: vscode.ExtensionContext, chatOf: ChatOf): Proposals {
  const p = new Proposals(chatOf);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, p),
    vscode.languages.registerCodeLensProvider({ scheme: PROPOSAL_SCHEME }, p),
    vscode.commands.registerCommand("embarchChat.toggleChange", (at: string, k: number) => p.toggle(at, k)),
    vscode.commands.registerCommand("embarchChat.acceptChanges", (uri?: vscode.Uri) => p.accept(uri)),
    vscode.commands.registerCommand("embarchChat.rejectChanges", (uri?: vscode.Uri) => p.reject(uri)),
  );
  return p;
}
