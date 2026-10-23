// Where things show (decision 17): the thread list behind its own
// activity-bar icon, the chat in the secondary sidebar where Claude Code's
// panel is, and any chat also openable as an editor tab.

import * as vscode from "vscode";
import { ChatHost, HostCtx } from "./chatHost";
import { webviewHtml } from "./html";
import type { HostToList, ListToHost } from "../../webview/shared/protocol";

export const THREADS_VIEW = "embarchChat.threads";
export const CHAT_VIEW = "embarchChat.chat";

/** The chat in the secondary sidebar: whichever chat is current. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  host: ChatHost | undefined;
  view: vscode.WebviewView | undefined;

  constructor(
    private extensionUri: vscode.Uri,
    private ctx: HostCtx,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] };
    this.host?.dispose();
    this.host = new ChatHost(view.webview, this.ctx, this.ctx.chats.current, false);
    view.webview.html = webviewHtml(view.webview, this.extensionUri, "chat", "Chat");
    view.onDidDispose(() => {
      this.host?.dispose();
      this.host = undefined;
      this.view = undefined;
    });
  }

  show(sid: string | null): void {
    this.host?.show(sid);
  }
}

/** Chats opened as editor tabs, one per session. */
export class ChatPanels implements vscode.Disposable {
  private panels = new Map<string, { panel: vscode.WebviewPanel; host: ChatHost }>();

  constructor(
    private extensionUri: vscode.Uri,
    private ctx: HostCtx,
  ) {}

  open(sid: string, title: string): void {
    const have = this.panels.get(sid);
    if (have) {
      have.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("embarchChat.chatTab", title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "chat.svg");
    const host = new ChatHost(panel.webview, this.ctx, sid, true);
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, "chat", title);
    this.panels.set(sid, { panel, host });
    panel.onDidDispose(() => {
      host.dispose();
      this.panels.delete(sid);
      this.ctx.chats.release(sid);
    });
  }

  retitle(sid: string, title: string): void {
    const p = this.panels.get(sid);
    if (p && p.panel.title !== title) p.panel.title = title;
  }

  has(sid: string): boolean {
    return this.panels.has(sid);
  }

  dispose(): void {
    for (const p of this.panels.values()) p.panel.dispose();
  }
}

export interface ListCtx {
  open: (sid: string) => void;
  openInEditor: (sid: string) => void;
  jump: (sid: string) => void;
  newChat: (itemId?: string) => void;
  refresh: () => void;
  data: () => HostToList;
  setVisible: (v: boolean) => void;
}

/** The thread list behind the activity-bar icon. */
export class ThreadsViewProvider implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;
  private ready = false;

  constructor(
    private extensionUri: vscode.Uri,
    private ctx: ListCtx,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, "list", "Threads");
    view.webview.onDidReceiveMessage((m: ListToHost) => {
      switch (m.t) {
        case "ready":
          this.ready = true;
          this.push();
          return;
        case "open":
          return this.ctx.open(m.sid);
        case "openInEditor":
          return this.ctx.openInEditor(m.sid);
        case "jump":
          return this.ctx.jump(m.sid);
        case "newChat":
          return this.ctx.newChat(m.itemId);
        case "refresh":
          return this.ctx.refresh();
      }
    });
    this.ctx.setVisible(view.visible);
    view.onDidChangeVisibility(() => {
      this.ctx.setVisible(view.visible);
      if (view.visible) this.push();
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ctx.setVisible(false);
    });
  }

  push(): void {
    if (this.view && this.ready) void this.view.webview.postMessage(this.ctx.data());
  }

  /** The waiting count on the activity-bar icon (decision 35). */
  badge(n: number, tooltip: string): void {
    if (this.view) this.view.badge = n ? { value: n, tooltip } : undefined;
  }
}
