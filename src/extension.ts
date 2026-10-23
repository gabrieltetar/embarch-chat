// EmbArch Chat: the owner's own Claude Code chat, beside the code
// (embarch-chat-proposal.md decisions 1, 2). This file wires the pieces:
// the chats this window runs (chats.ts), the desk (deskService.ts), the two
// views and editor tabs (views/), and the embarch-ui launcher that moved in
// (launcher/, decision 29).

import * as crypto from "crypto";
import * as vscode from "vscode";
import { ChatManager, ChatRecord } from "./chats";
import { AssignBody, DeskClient, DeskError, MailboxEntry, expandHome } from "./desk/client";
import { DeskService } from "./deskService";
import { DIFF_SCHEME, DiffContent } from "./diff";
import { jump } from "./jump";
import { activateLauncher, deactivateLauncher, serverUrl } from "./launcher/launcher";
import { noAssistant } from "./seams";
import { HostCtx } from "./views/chatHost";
import { CHAT_VIEW, ChatPanels, ChatViewProvider, THREADS_VIEW, ThreadsViewProvider } from "./views/views";
import { claudeVersion, versionWarning } from "./wire/version";

let chats: ChatManager | undefined;
let deskService: DeskService | undefined;

function cfg() {
  const c = vscode.workspace.getConfiguration("embarchChat");
  return {
    claudePath: c.get<string>("claudePath", "claude"),
    idleMs: Math.max(1, c.get<number>("idleMinutes", 5)) * 60_000,
    deskUrl: c.get<string>("deskUrl", "http://127.0.0.1:4891"),
    deskTokenPath: c.get<string>("deskTokenPath", "~/.config/embarch-desk/desk-token"),
  };
}

function folders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("EmbArch Chat");
  const log = (s: string) => output.appendLine(`${new Date().toISOString().slice(11, 19)} ${s}`);
  context.subscriptions.push(output);

  // The launcher, unless the old standalone launcher is still installed:
  // two extensions registering the same commands would fail activation.
  if (vscode.extensions.getExtension("embarch.embarch-ui-launcher")) {
    log("embarch-ui-launcher is installed; its commands stay with it (uninstall it: this extension carries them now).");
  } else {
    try {
      activateLauncher(context);
    } catch (e) {
      log(`launcher: ${(e as Error).message}`);
    }
  }

  let client = new DeskClient({ baseUrl: cfg().deskUrl, tokenPath: expandHome(cfg().deskTokenPath) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("embarchChat.deskUrl") || e.affectsConfiguration("embarchChat.deskTokenPath")) {
        client = new DeskClient({ baseUrl: cfg().deskUrl, tokenPath: expandHome(cfg().deskTokenPath) });
      }
    }),
  );

  chats = new ChatManager(() => ({ claudePath: cfg().claudePath, idleMs: cfg().idleMs, log }));
  const manager = chats;
  deskService = new DeskService(() => client, manager, folders, log);
  const desk = deskService;
  const diff = new DiffContent();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diff));

  // Decision 30: the CLI on PATH, a one-line warning outside the tested range.
  let warning: string | null = null;
  claudeVersion(cfg().claudePath).then(
    (v) => {
      warning = versionWarning(v);
      log(`claude ${v}${warning ? ` — ${warning}` : ""}`);
      chatView.host?.snapshot();
    },
    (e) => {
      warning = `claude not found (${cfg().claudePath}): set embarchChat.claudePath. ${(e as Error).message}`;
      log(warning);
      chatView.host?.snapshot();
    },
  );

  const deskUrl = (itemId: string | null) => `${serverUrl()}#desk${itemId ? `?item=${encodeURIComponent(itemId)}` : ""}`;

  const titleOf = (rec: ChatRecord | undefined) => rec?.chat.state.title ?? rec?.itemTitle ?? "Chat";

  const ctx: HostCtx = {
    chats: manager,
    desk,
    diff,
    log,
    claudePath: () => cfg().claudePath,
    deskUrl,
    uiUrl: () => serverUrl(),
    warning: () => warning,
    openInEditor: (sid) => openInEditor(sid),
    newChat: (itemId) => void newChat(itemId),
  };

  const chatView = new ChatViewProvider(context.extensionUri, ctx);
  const panels = new ChatPanels(context.extensionUri, ctx);
  context.subscriptions.push(panels, vscode.window.registerWebviewViewProvider(CHAT_VIEW, chatView, { webviewOptions: { retainContextWhenHidden: true } }));

  const threads = new ThreadsViewProvider(context.extensionUri, {
    open: (sid) => void open(sid),
    openInEditor: (sid) => openInEditor(sid),
    jump: (sid) => void jumpTo(sid),
    newChat: (itemId) => void newChat(itemId),
    refresh: () => void desk.refresh(),
    data: () => ({ t: "groups", groups: desk.groups, desk: desk.desk?.name ?? null, error: desk.error, selected: manager.current, now: Date.now() }),
    setVisible: (v) => desk.setVisible(v),
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(THREADS_VIEW, threads));

  // ------------------------------------------------------------ the count

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.command = "embarchChat.openWaiting";
  context.subscriptions.push(status);
  const refreshCount = () => {
    const w = desk.waiting();
    const tip = w.map((t) => `• ${t.title}${t.waitingFor ? ` — ${t.waitingFor}` : ""}`).join("\n");
    threads.badge(w.length, `${w.length} waiting on you`);
    if (w.length) {
      status.text = `$(comment-discussion) ${w.length} waiting`;
      status.tooltip = `Chats waiting on you — click opens the oldest\n${tip}`;
      status.show();
    } else status.hide();
  };

  desk.on("changed", () => {
    threads.push();
    refreshCount();
    for (const [sid, rec] of manager.records) panels.retitle(sid, titleOf(rec));
  });

  // ------------------------------------------------------------ opening

  const reveal = async () => {
    try {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    } catch {
      /* older VS Code: the view still shows on its own container */
    }
  };

  const show = async (sid: string) => {
    manager.current = sid;
    chatView.show(sid);
    threads.push();
    await reveal();
  };

  /** Opens a thread: this window's own, or any other read-only from its transcript (decision 31). */
  async function open(sid: string): Promise<void> {
    const rec = manager.get(sid);
    if (!rec) {
      const found = desk.thread(sid);
      const t = found?.thread;
      const item = found?.group.item ?? null;
      const resumable = !!t && !t.live && desk.isWindowFolder(t.cwd);
      const prev = manager.current;
      manager.openViewer(sid, t?.cwd ?? null, item?.id ?? null, item ? (item.issueKey ? `${item.issueKey} ${item.title}` : item.title) : null, resumable);
      if (prev && prev !== sid) manager.release(prev);
    } else if (rec.viewer) manager.reloadViewer(sid);
    await show(sid);
  }

  function openInEditor(sid: string): void {
    if (!manager.get(sid)) {
      const t = desk.thread(sid);
      manager.openViewer(sid, t?.thread.cwd ?? null, t?.group.item?.id ?? null, t?.group.item?.title ?? null, !!t && !t.thread.live && desk.isWindowFolder(t.thread.cwd));
    }
    panels.open(sid, titleOf(manager.get(sid)));
  }

  async function jumpTo(sid: string): Promise<void> {
    const t = desk.thread(sid)?.thread;
    if (t) await jump(t, desk.isWindowFolder(t.cwd), client, cfg().claudePath, log);
  }

  // Live foreign threads on screen follow their transcripts.
  const follow = setInterval(() => {
    for (const [sid, rec] of manager.records) if (rec.viewer && (sid === manager.current || panels.has(sid))) manager.reloadViewer(sid);
  }, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(follow) });

  // ------------------------------------------------------------ new chats

  /**
   * A chat is on its work item before it starts (decision 10): the session
   * id is chosen here, assigned on the desk, and `claude --session-id` starts
   * with the first message.
   */
  async function startChat(body: AssignBody, cwd: string, label: string | null): Promise<ChatRecord | null> {
    const sid = crypto.randomUUID();
    let itemId: string | null = null;
    let itemTitle = label;
    try {
      const r = await client.assign(sid, body);
      itemId = r.item_id ?? null;
      itemTitle = r.title ?? itemTitle;
    } catch (e) {
      if (e instanceof DeskError && e.unreachable) {
        void vscode.window.showWarningMessage("The desk is not running: this chat starts untracked, and the desk asks for its work item when it sees it.");
      } else {
        void vscode.window.showErrorMessage(`Chat not started: ${(e as Error).message}`);
        return null;
      }
    }
    log(`new chat ${sid} on ${itemId ?? "untracked"} in ${cwd}`);
    const rec = manager.create(sid, cwd, itemId, itemTitle);
    rec.chat.on("turn", () => void noAssistant.afterTurn(rec.chat, manager.current === sid));
    desk.rebuild();
    await show(sid);
    return rec;
  }

  function windowCwd(prefer?: string | null): string | null {
    const fs = folders();
    if (prefer && fs.includes(prefer)) return prefer;
    return fs[0] ?? null;
  }

  /** The + on a group starts on that item; the top + picks one (decision 10). */
  async function newChat(itemId?: string): Promise<void> {
    const cwd = windowCwd();
    if (!cwd) {
      void vscode.window.showErrorMessage("Open a folder first: a chat runs in the window's folder.");
      return;
    }
    if (itemId) {
      const g = desk.groups.find((x) => x.item?.id === itemId);
      await startChat({ item_id: itemId }, cwd, g?.item ? (g.item.issueKey ? `${g.item.issueKey} ${g.item.title}` : g.item.title) : null);
      return;
    }
    type Pick = vscode.QuickPickItem & { run: () => Promise<unknown> };
    const picks: Pick[] = [];
    const seen = new Set<string>();
    for (const c of desk.view?.cards ?? []) {
      if (!desk.groups.some((g) => g.item?.id === c.id)) continue;
      seen.add(c.id);
      picks.push({
        label: `$(issues) ${c.issue ? `${c.issue.key} ` : ""}${c.issue?.title ?? c.title}`,
        description: c.issue?.state_name,
        run: () => startChat({ item_id: c.id }, cwd, c.issue ? `${c.issue.key} ${c.issue.title}` : c.title),
      });
    }
    for (const g of desk.groups) {
      if (!g.item || seen.has(g.item.id)) continue;
      const item = g.item;
      picks.push({ label: `$(issues) ${item.title}`, run: () => startChat({ item_id: item.id }, cwd, item.title) });
    }
    if (picks.length) picks.push({ label: "", kind: vscode.QuickPickItemKind.Separator, run: async () => null });
    picks.push(
      {
        label: "$(key) Issue key…",
        description: "a Linear issue, made into a work item if the desk has none",
        run: async () => {
          const key = await vscode.window.showInputBox({ prompt: "Issue key", placeHolder: "ABC-123" });
          if (key?.trim()) await startChat({ issue_key: key.trim() }, cwd, key.trim().toUpperCase());
        },
      },
      {
        label: "$(add) New work item…",
        description: desk.desk ? `on ${desk.desk.name}` : undefined,
        run: async () => {
          const title = await vscode.window.showInputBox({ prompt: "Title of the new work item" });
          if (title?.trim()) await startChat({ new_title: title.trim(), desk: desk.desk?.id ?? "none" }, cwd, title.trim());
        },
      },
      { label: "$(circle-slash) Untracked", description: "no work item", run: () => startChat({ untracked: true }, cwd, null) },
    );
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Start a chat on…", matchOnDescription: true });
    if (pick) await pick.run();
  }

  // ------------------------------------------------------------ the mailbox

  /** Start work and Open chat from the Desk land here (desk decisions 11, 32, 33). */
  desk.on("mail", async (m: MailboxEntry) => {
    try {
      if (m.kind === "start" && m.item_id) {
        const cwd = windowCwd(m.folder) ?? m.folder;
        const card = desk.card(m.item_id);
        const rec = await startChat({ item_id: m.item_id }, cwd, card ? (card.issue ? `${card.issue.key} ${card.issue.title}` : card.title) : null);
        if (rec && m.prompt) rec.chat.send(m.prompt);
      } else if (m.kind === "focus" && m.session_id) {
        await open(m.session_id);
      }
    } catch (e) {
      log(`mailbox ${m.id}: ${(e as Error).message}`);
    }
  });

  // ------------------------------------------------------------ commands

  context.subscriptions.push(
    vscode.commands.registerCommand("embarchChat.newChat", () => newChat()),
    vscode.commands.registerCommand("embarchChat.openInEditor", () => {
      if (manager.current) openInEditor(manager.current);
    }),
    vscode.commands.registerCommand("embarchChat.openWaiting", async () => {
      const w = desk.waiting();
      if (w.length) await open(w[0].sessionId);
    }),
    vscode.commands.registerCommand("embarchChat.refresh", () => desk.refresh()),
    vscode.commands.registerCommand("embarchChat.showLog", () => output.show()),
  );

  desk.start();
}

/** Chats die with their window (decision 5). */
export function deactivate(): void {
  deskService?.dispose();
  chats?.dispose();
  deactivateLauncher();
}
