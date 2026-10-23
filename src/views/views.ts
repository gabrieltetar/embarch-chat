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
  /** Called when what is on screen may have changed (the count leaves out the chat in view, decision 35). */
  onShown: () => void = () => {};

  constructor(
    private extensionUri: vscode.Uri,
    private ctx: HostCtx,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] };
    this.host?.dispose();
    this.host = new ChatHost(view.webview, this.ctx, this.ctx.chats.current, false, () => void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`));
    view.webview.html = webviewHtml(view.webview, this.extensionUri, "chat", "Chat");
    view.onDidChangeVisibility(() => this.onShown());
    view.onDidDispose(() => {
      this.host?.dispose();
      this.host = undefined;
      this.view = undefined;
      this.onShown();
    });
  }

  show(sid: string | null): void {
    this.host?.show(sid);
  }
}

/**
 * What a chat's tab icon says, as Claude Code's does (its
 * claude-logo-pending/-done.svg): it waits on the owner, or a turn finished
 * unread; else the plain mark.
 */
export type TabState = "plain" | "pending" | "done";

/** Chats opened as editor tabs, one per session. */
export class ChatPanels implements vscode.Disposable {
  private panels = new Map<string, { panel: vscode.WebviewPanel; host: ChatHost; icon: TabState }>();
  /** Called when a tab shows or hides. */
  onShown: () => void = () => {};
  /** Called when the owner closed a tab: Ctrl+Shift+T can bring it back (59). */
  onClosed: () => void = () => {};
  /** Tabs the owner closed, the latest last (Claude Code keeps its own so). */
  private closed: string[] = [];
  /** The tab last focused, for a key that goes to the chat (59). */
  private lastActive: string | null = null;
  private disposing = false;

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
    // The mark in its two colours, a file per theme (decision 54).
    panel.iconPath = this.iconFor("plain");
    const host = new ChatHost(panel.webview, this.ctx, sid, true, () => panel.reveal(undefined, false));
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, "chat", title);
    this.panels.set(sid, { panel, host, icon: "plain" });
    panel.onDidChangeViewState?.(() => {
      if (panel.active) this.lastActive = sid;
      this.onShown();
    });
    panel.onDidDispose(() => {
      host.dispose();
      this.panels.delete(sid);
      this.ctx.chats.release(sid);
      this.onShown();
      if (this.disposing) return;
      this.closed = [...this.closed.filter((x) => x !== sid), sid].slice(-20);
      this.onClosed();
    });
  }

  /** The last closed tab's chat, taken off the list; null when none is left. */
  reopen(): string | null {
    return this.closed.pop() ?? null;
  }

  get canReopen(): boolean {
    return this.closed.length > 0;
  }

  /** The tab last focused, while it still shows. */
  shownHost(): ChatHost | undefined {
    const p = this.lastActive ? this.panels.get(this.lastActive) : undefined;
    return p?.panel.visible ? p.host : undefined;
  }

  /** The mark, with the state's dot in the corner unless plain. */
  private iconFor(state: TabState): { light: vscode.Uri; dark: vscode.Uri } {
    const name = (theme: string) => `embarch-tab-${state === "plain" ? "" : `${state}-`}${theme}.svg`;
    return {
      light: vscode.Uri.joinPath(this.extensionUri, "media", name("light")),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", name("dark")),
    };
  }

  /** The tab's icon for its chat's state, set only when it moved. */
  setState(sid: string, state: TabState): void {
    const p = this.panels.get(sid);
    if (!p || p.icon === state) return;
    p.icon = state;
    p.panel.iconPath = this.iconFor(state);
  }

  retitle(sid: string, title: string): void {
    const p = this.panels.get(sid);
    if (p && p.panel.title !== title) p.panel.title = title;
  }

  has(sid: string): boolean {
    return this.panels.has(sid);
  }

  /** The chats open as tabs. */
  sessions(): string[] {
    return [...this.panels.keys()];
  }

  /** The chat whose tab is the active editor, if one is. */
  active(): string | null {
    for (const [sid, p] of this.panels) if (p.panel.active) return sid;
    return null;
  }

  visible(sid: string): boolean {
    return !!this.panels.get(sid)?.panel.visible;
  }

  dispose(): void {
    this.disposing = true;
    for (const p of this.panels.values()) p.panel.dispose();
  }
}

export interface ListCtx {
  open: (sid: string) => void;
  openInEditor: (sid: string) => void;
  jump: (sid: string) => void;
  newChat: (itemId?: string) => void;
  refresh: () => void;
  rename: (sid: string) => void;
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
    view.badge = this.lastBadge;
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
        case "rename":
          return this.ctx.rename(m.sid);
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

  private lastBadge: vscode.ViewBadge | undefined;

  /**
   * The waiting count on the activity-bar icon (decision 35). VS Code
   * resolves a view only once it is first shown, so until then the count
   * shows in the status bar alone; the icon gets it as soon as the list
   * has been opened once.
   */
  badge(n: number, tooltip: string): void {
    this.lastBadge = n ? { value: n, tooltip } : undefined;
    if (this.view) this.view.badge = this.lastBadge;
  }
}
