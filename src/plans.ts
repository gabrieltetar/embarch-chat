// A pending plan as a Markdown tab the owner comments on, line by line
// (decision 77), as Claude Code's panel opens one (`open_plan`): a read-only
// document — a virtual one, so closing it asks nothing — and VS Code's own
// comments on it. Each comment goes to the plan's card at once, which lists
// it with × and sends them all with "keep planning"; the tab's title bar can
// send them too. Answered, here or on the card, the tab and its comments go.

import * as vscode from "vscode";
import type { Chat } from "./wire/chat";
import type { Pending } from "./wire/reducer";
import type { PlanComment } from "./wire/cards";

export const PLAN_SCHEME = "embarch-chat-plan";
const CONTROLLER = "embarch-chat-plan";

interface OpenPlan {
  sid: string;
  requestId: string;
  text: string;
  uri: vscode.Uri;
  comments: PlanComment[];
  threads: Map<string, vscode.CommentThread>;
}

/** What a plan answers through: the chat a session id names. */
export type ChatOf = (sid: string) => Chat | undefined;

export class PlanDocs implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private byPath = new Map<string, OpenPlan>();
  private controller: vscode.CommentController;
  private next = 0;

  constructor(private chatOf: ChatOf) {
    this.controller = vscode.comments.createCommentController(CONTROLLER, "Plan comments");
    // Any line of an open plan takes a comment.
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => (doc.uri.scheme === PLAN_SCHEME && this.byPath.has(doc.uri.path) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
    };
    this.controller.options = { prompt: "Comment on this part of the plan", placeHolder: "What to change here — sent when Claude keeps planning" };
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.byPath.get(uri.path)?.text ?? "";
  }

  /** Opens a pending plan's tab; the same plan opens the same tab again, its comments kept. */
  async open(sid: string, pending: Pending): Promise<void> {
    let p = [...this.byPath.values()].find((x) => x.requestId === pending.requestId);
    if (!p) {
      const uri = vscode.Uri.from({ scheme: PLAN_SCHEME, path: `/${pending.requestId}/Claude's plan.md` });
      p = { sid, requestId: pending.requestId, text: String(pending.input.plan ?? ""), uri, comments: [...(pending.comments ?? [])], threads: new Map() };
      this.byPath.set(uri.path, p);
    }
    const doc = await vscode.workspace.openTextDocument(p.uri);
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
  }

  /** The comment box's submit: one comment on the thread's lines, on the card at once. */
  add(reply: vscode.CommentReply): void {
    const p = this.byPath.get(reply.thread.uri.path);
    const text = reply.text.trim();
    if (!p || !text) return;
    const r = reply.thread.range ?? new vscode.Range(0, 0, 0, 0);
    const lines = p.text.split("\n");
    const id = `c${++this.next}`;
    const selectedText = lines.slice(r.start.line, r.end.line + 1).join("\n").trim();
    reply.thread.comments = [{ body: text, mode: vscode.CommentMode.Preview, author: { name: "You" }, contextValue: id }];
    reply.thread.canReply = false;
    reply.thread.contextValue = id;
    reply.thread.label = `Line ${r.start.line + 1}${r.end.line > r.start.line ? `–${r.end.line + 1}` : ""}`;
    p.threads.set(id, reply.thread);
    p.comments = [...p.comments, { id, start: r.start.line, end: r.end.line, selectedText, comment: text }];
    this.push(p);
  }

  /** A comment taken back, from its thread in the tab or its × on the card. */
  remove(requestId: string, id: string): void {
    const p = [...this.byPath.values()].find((x) => x.requestId === requestId);
    if (!p) return;
    p.threads.get(id)?.dispose();
    p.threads.delete(id);
    p.comments = p.comments.filter((c) => c.id !== id);
    this.push(p);
  }

  /** The thread's own remove: its comment goes. */
  removeThread(thread: vscode.CommentThread): void {
    const p = this.byPath.get(thread.uri.path);
    if (p && thread.contextValue) this.remove(p.requestId, thread.contextValue);
    else thread.dispose();
  }

  /** The tab's title bar: the comments go back as "keep planning", as the card's button sends them. */
  keepPlanning(uri?: vscode.Uri): void {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const p = target && this.byPath.get(target.path);
    if (!p) return;
    const chat = this.chatOf(p.sid);
    const pending = chat?.state.pending.find((x) => x.requestId === p.requestId);
    if (chat && pending) chat.keepPlanning(pending, "");
    else void vscode.window.showInformationMessage("This plan was already answered.");
    this.done(p.requestId);
  }

  private push(p: OpenPlan): void {
    this.chatOf(p.sid)?.planComments(p.requestId, p.comments);
  }

  /** The plan was answered, here or on its card: its comments and its tab go. */
  done(requestId: string): void {
    const p = [...this.byPath.values()].find((x) => x.requestId === requestId);
    if (!p) return;
    for (const t of p.threads.values()) t.dispose();
    this.byPath.delete(p.uri.path);
    const tabs = (vscode.window.tabGroups?.all ?? []).flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === p.uri.toString());
    if (tabs.length) void vscode.window.tabGroups.close(tabs);
  }

  dispose(): void {
    for (const p of this.byPath.values()) for (const t of p.threads.values()) t.dispose();
    this.byPath.clear();
    this.controller.dispose();
  }
}

export function registerPlans(context: vscode.ExtensionContext, chatOf: ChatOf): PlanDocs {
  const plans = new PlanDocs(chatOf);
  context.subscriptions.push(
    plans,
    vscode.workspace.registerTextDocumentContentProvider(PLAN_SCHEME, plans),
    vscode.commands.registerCommand("embarchChat.addPlanComment", (reply: vscode.CommentReply) => plans.add(reply)),
    vscode.commands.registerCommand("embarchChat.removePlanComment", (thread: vscode.CommentThread) => plans.removeThread(thread)),
    vscode.commands.registerCommand("embarchChat.keepPlanning", (uri?: vscode.Uri) => plans.keepPlanning(uri)),
  );
  return plans;
}
