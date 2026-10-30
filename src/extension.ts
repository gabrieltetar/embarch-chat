// EmbArch Chat: the owner's own Claude Code chat, beside the code
// (decisions 1, 2). This file wires the pieces:
// the chats this window runs (chats.ts), the desk (deskService.ts), the two
// views and editor tabs (views/), and the embarch-ui launcher that moved in
// (launcher/, decision 29).

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { HaikuAssistant } from "./assistant/assistant";
import { PromptHistory } from "./assistant/history";
import { LibraryEntry } from "./library/entries";
import { readLibrary } from "./library/files";
import { ChatManager, ChatRecord, DeskDue } from "./chats";
import { AssignBody, DeskClient, DeskError, MailboxEntry, expandHome } from "./desk/client";
import { DeskService } from "./deskService";
import { CONTENT_SCHEME, ContentDocs } from "./content";
import { registerPlans } from "./plans";
import { DIFF_SCHEME, DiffContent, registerProposals } from "./diff";
import { hostHooks } from "./hostHooks";
import { EditorContext } from "./editorContext";
import { agentPid, jump } from "./jump";
import { activateLauncher, deactivateLauncher, serverUrl } from "./launcher/launcher";
import { ReloadMemory, restoreAfterReload } from "./reload";
import { HostCtx, assistInput, beginPromptu } from "./views/chatHost";
import { PromptuCli, findBinary } from "./promptu/cli";
import { PromptuRuns } from "./promptu/runs";
import { PromptuService, embarchApiPresent } from "./promptu/service";
import { startRough } from "./promptu/text";
import { UsageStore } from "./usageStore";
import { CHAT_VIEW, ChatPanels, ChatViewProvider, THREADS_VIEW, ThreadsViewProvider } from "./views/views";
import { claudeVersion, versionWarning } from "./wire/version";
import { findTranscript, isSessionId } from "./wire/transcript";
import { appendTitle, forkPoint, historyUpTo } from "./wire/history";
import type { WireMessage } from "./wire/types";

let chats: ChatManager | undefined;
let deskService: DeskService | undefined;
let assistant: HaikuAssistant | undefined;
let reloadMemory: ReloadMemory | undefined;
let promptuRuns: PromptuRuns | undefined;

function cfg() {
  const c = vscode.workspace.getConfiguration("embarchChat");
  return {
    claudePath: c.get<string>("claudePath", "claude"),
    idleMs: Math.max(1, c.get<number>("idleMinutes", 5)) * 60_000,
    deskUrl: c.get<string>("deskUrl", "http://127.0.0.1:4891"),
    deskTokenPath: c.get<string>("deskTokenPath", "~/.config/embarch-desk/desk-token"),
    assistant: c.get<boolean>("assistant", true),
    attachOpenFile: c.get<boolean>("attachOpenFile", true),
    attachSelection: c.get<boolean>("attachSelection", true),
    // Where a chat opens (decision 92): an editor tab, unless the owner keeps the sidebar.
    inTabs: c.get<string>("chatLocation", "editor") !== "sidebar",
    // Promptu's CLI (decision 95): on PATH unless a path is set.
    promptuPath: c.get<string>("promptuPath", "promptu") || "promptu",
  };
}

const MIN = 60_000;
/** A transcript written this recently may belong to a running session, when `claude agents` cannot say. */
const RECENT_MS = 5 * MIN;

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

  // The desk is this machine's, and its URL and token path come from user or
  // remote settings only (machine scope): a repo's .vscode/settings.json
  // cannot point the window, or its token, anywhere else.
  const makeClient = () => {
    const c = new DeskClient({ baseUrl: cfg().deskUrl, tokenPath: expandHome(cfg().deskTokenPath) });
    if (c.refusal) log(`desk: ${c.refusal}`);
    return c;
  };
  let client = makeClient();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("embarchChat.deskUrl") || e.affectsConfiguration("embarchChat.deskTokenPath")) client = makeClient();
    }),
  );

  chats = new ChatManager(() => ({ claudePath: cfg().claudePath, idleMs: cfg().idleMs, log, hooks: (cwd) => hostHooks(log, cwd), hold: (sid) => promptuRuns?.holdReason(sid) ?? null }));
  const manager = chats;
  deskService = new DeskService(() => client, manager, folders, log);
  const desk = deskService;
  const diff = new DiffContent();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diff));
  const proposals = registerProposals(context, (sid) => manager.get(sid)?.chat);
  const plans = registerPlans(context, (sid) => manager.get(sid)?.chat);
  const content = new ContentDocs();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, content));

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

  // ------------------------------------------------------------ the assistant and the library

  // The owner's own prompts of the last 30 days, read in the background (decision 26).
  const history = new PromptHistory();
  const refreshHistory = () => void history.refresh().catch((e) => log(`prompt history: ${(e as Error).message}`));
  const historyStart = setTimeout(refreshHistory, 2000);
  const historyTimer = setInterval(refreshHistory, 10 * MIN);
  context.subscriptions.push({ dispose: () => (clearTimeout(historyStart), clearInterval(historyTimer)) });

  // The library: this repo's own plugin, shipped inside the extension, and ~/.claude/commands (decisions 13, 38).
  const pluginDir = path.join(context.extensionUri.fsPath, "plugin");
  let libraryCache: { at: number; entries: LibraryEntry[] } = { at: 0, entries: [] };
  const library = () => {
    if (Date.now() - libraryCache.at > 30_000) libraryCache = { at: Date.now(), entries: readLibrary(pluginDir) };
    return libraryCache.entries;
  };

  assistant = new HaikuAssistant(() => ({ claudePath: cfg().claudePath, enabled: cfg().assistant, log }));
  const haiku = assistant;

  // The open file and the selection go with a message by default (decision 60).
  const editor = new EditorContext(() => ({ attachOpenFile: cfg().attachOpenFile, attachSelection: cfg().attachSelection }));
  context.subscriptions.push(editor);

  // Promptu (decisions 94–98): the CLI, the card's switches, one run per chat.
  const promptuCli = new PromptuCli(() => ({ bin: cfg().promptuPath, log }));
  const promptu = new PromptuService(promptuCli, context.globalState, log);
  promptuRuns = new PromptuRuns(promptuCli, log);
  const runs = promptuRuns;
  // A run goes with its chat (96): an idle close (held while a run or its prompt waits on the owner), a crash, a dropped view.
  manager.on("closed", (sid: string) => runs.forget(sid));
  manager.on("released", (sid: string) => runs.forget(sid));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("embarchChat.promptuPath")) promptu.emit("state");
    }),
  );
  // The plan's usage for the rail's icon (99): the newest rate_limit_event any of this window's chats heard.
  const usage = new UsageStore();
  manager.on("event", (_sid: string, e: WireMessage) => {
    if (e.type === "rate_limit_event") usage.take(e.rate_limit_info);
  });
  /** The EmbArch parts a chat has (`--have`): the desk when it answers, the bench tools when its CLI lists them or the binary is here. */
  const promptuHave = (rec: ChatRecord) => [
    ...(desk.error === null && desk.view ? ["desk"] : []),
    ...(embarchApiPresent(rec.chat.state.mcp, () => !!findBinary("embarch-api")) ? ["embarch-api"] : []),
  ];

  const ctx: HostCtx = {
    chats: manager,
    desk,
    diff,
    proposals,
    content,
    plans,
    remembered: context.globalState,
    log,
    claudePath: () => cfg().claudePath,
    deskUrl,
    uiUrl: () => serverUrl(),
    warning: () => warning,
    openInEditor: (sid) => openInEditor(sid),
    newChat: (itemId) => void newChat(itemId),
    assistant: haiku,
    assistantOn: () => cfg().assistant,
    history,
    library,
    freshChat: (sid) => void freshChat(sid),
    resume: (sid, text) => resume(sid, text),
    fork: (sid, uuid) => forkChat(sid, uuid),
    continueStep: (sid) => reloadMemory?.continueStep(sid),
    rename: (sid) => renameChat(sid),
    editor,
    promptu,
    runs,
    promptuHave,
    usage,
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
    rename: (sid) => void renameChat(sid),
    data: () => ({ t: "groups", groups: desk.groups, desk: desk.desk?.name ?? null, error: desk.error, notice: desk.notice, selected: manager.current, now: Date.now() }),
    setVisible: (v) => desk.setVisible(v),
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(THREADS_VIEW, threads));

  // A reload brings this window's chats back, and a step it cut off goes on at the owner's word (decision 63).
  reloadMemory = new ReloadMemory(context.workspaceState, manager, () => panels.sessions(), log);
  context.subscriptions.push(reloadMemory);
  void restoreAfterReload({
    state: context.workspaceState,
    manager,
    memory: reloadMemory,
    claudePath: () => cfg().claudePath,
    enabled: () => vscode.workspace.getConfiguration("embarchChat").get<boolean>("continueAfterReload", true),
    log,
    show: (sid) => {
      manager.current = sid;
      if (!cfg().inTabs) chatView.show(sid);
      threads.push();
    },
    openTab: (sid) => panels.open(sid, titleOf(manager.get(sid))),
  }).catch((e) => log(`reload: ${(e as Error).message}`));

  // ------------------------------------------------------------ the count

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.command = "embarchChat.openWaiting";
  context.subscriptions.push(status);
  /** On screen: the sidebar's chat while the sidebar shows, or a visible editor tab (decision 34). */
  const onScreen = (sid: string) => (manager.current === sid && !!chatView.view?.visible) || panels.visible(sid);
  /** The chats waiting on the owner off screen, oldest first: the count, and what a click opens (decision 35). */
  const waitingOff = () => desk.waiting().filter((t) => !onScreen(t.sessionId));
  const refreshCount = () => {
    const w = waitingOff();
    const tip = w.map((t) => `• ${t.title}${t.waitingFor ? ` — ${t.waitingFor}` : ""}`).join("\n");
    threads.badge(w.length, `${w.length} waiting on you`);
    if (w.length) {
      status.text = `$(comment-discussion) ${w.length} waiting`;
      status.tooltip = `Chats waiting on you — click opens the oldest\n${tip}`;
      status.show();
    } else status.hide();
  };

  // ------------------------------------------------------------ unread

  // A turn that ends while its chat is off screen leaves it unread until the
  // owner looks at it, as Claude Code marks one (its changelog L6933): a dot
  // in the list and on the chat's tab. It joins no count: the badge and the
  // status bar count what waits on the owner (decision 35), as Claude Code's
  // badge counts only sessions waiting for input; nothing pops up.
  manager.on("turn", (sid: string) => {
    if (manager.get(sid)?.ours && !onScreen(sid)) manager.setUnread(sid, true);
  });
  /** What shows now has been seen. */
  const seen = () => {
    for (const [sid, rec] of manager.records) if (rec.unread && onScreen(sid)) manager.setUnread(sid, false);
  };
  /** Each chat tab's icon (Claude Code's pending and done marks): waiting on the owner, a turn finished unread, or the plain mark. */
  const refreshTabs = () => {
    for (const sid of panels.sessions()) {
      const rec = manager.get(sid);
      const st = rec?.chat.state;
      const waiting = !!st?.pending.length || desk.thread(sid)?.thread.state === "waiting";
      panels.setState(sid, waiting ? "pending" : rec?.unread && !st?.busy && !st?.compacting ? "done" : "plain");
    }
  };

  desk.on("changed", () => {
    threads.push();
    refreshCount();
    refreshTabs();
    for (const [sid, rec] of manager.records) panels.retitle(sid, titleOf(rec));
    // The desk is back: what it missed while it was down (decision 10).
    if (!desk.error) for (const rec of manager.records.values()) if (rec.ours && rec.deskDue) void tellDesk(rec);
  });

  // ------------------------------------------------------------ the entry

  // EmbArch Chat's own "new chat" at the right of the status bar, where
  // Claude Code and Copilot keep theirs, in the mark rather than a codicon
  // (decision 54): always shown, and a click is the top +.
  const entry = vscode.window.createStatusBarItem("embarchChat.entry", vscode.StatusBarAlignment.Right);
  entry.name = "EmbArch Chat";
  entry.text = "$(embarch-mark) EmbArch";
  entry.tooltip = "New EmbArch chat";
  entry.command = "embarchChat.newChat";
  entry.show();
  context.subscriptions.push(entry);

  // ------------------------------------------------------------ opening

  const reveal = async () => {
    try {
      await vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    } catch {
      /* older VS Code: the view still shows on its own container */
    }
  };

  /** A chat on screen: its own editor tab, or the sidebar's chat when the owner keeps the sidebar (decision 92). */
  const show = async (sid: string) => {
    manager.current = sid;
    threads.push();
    if (cfg().inTabs) openInEditor(sid);
    else {
      chatView.show(sid);
      await reveal();
    }
    seen();
    refreshCount();
  };
  chatView.onShown = panels.onShown = () => {
    seen();
    refreshCount();
  };
  // With chats in tabs, the list marks the one in front, and a closed tab's
  // chat is no longer current, so a read-only view of it can go.
  panels.onActive = (sid) => {
    if (!cfg().inTabs || manager.current === sid) return;
    manager.current = sid;
    threads.push();
  };
  panels.onGone = (sid) => {
    if (!cfg().inTabs || manager.current !== sid) return;
    manager.current = null;
    threads.push();
  };

  /**
   * Whether a thread may be taken over here (decisions 5, 31): nothing runs
   * it now. The desk's "ended", or a transcript with no desk at all, is not
   * enough — a terminal may run it while the desk is down or restarting —
   * so `claude agents` is asked; when it cannot say, a transcript written in
   * the last few minutes while the desk is down counts as running.
   */
  async function freeToResume(rec: ChatRecord): Promise<boolean> {
    const sid = rec.chat.sessionId;
    const pid = await agentPid(cfg().claudePath, sid);
    if (pid !== undefined) {
      if (pid !== null) log(`[${sid.slice(0, 8)}] runs elsewhere (pid ${pid}): read-only here`);
      return pid === null;
    }
    const file = rec.transcript?.file;
    const recent = !!file && Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < RECENT_MS;
    return !(desk.error && recent);
  }

  /** A viewer offered as resumable stays so only when nothing runs it (checked in the background). */
  function checkResumable(sid: string): void {
    const rec = manager.get(sid);
    if (!rec?.viewer || !rec.resumable) return;
    void freeToResume(rec).then((free) => {
      if (!free && rec.viewer && rec.resumable) {
        rec.resumable = false;
        manager.emit("snapshot", sid);
      }
    });
  }

  const viewerOf = (sid: string) => {
    const found = desk.thread(sid);
    const t = found?.thread;
    const item = found?.group.item ?? null;
    return {
      cwd: t?.cwd ?? null,
      itemId: item?.id ?? null,
      itemTitle: item ? (item.issueKey ? `${item.issueKey} ${item.title}` : item.title) : null,
      resumable: !!t && !t.live && desk.isWindowFolder(t.cwd),
    };
  };

  /** Opens a thread: this window's own, or any other read-only from its transcript (decision 31). */
  async function open(sid: string): Promise<void> {
    if (!isSessionId(sid)) return;
    const rec = manager.get(sid);
    if (!rec) {
      const v = viewerOf(sid);
      manager.openViewer(sid, v.cwd, v.itemId, v.itemTitle, v.resumable);
      checkResumable(sid);
    } else if (rec.viewer) manager.reloadViewer(sid);
    const prev = manager.current;
    await show(sid);
    // A read-only view nothing shows any more is dropped; the transcript stays.
    if (prev && prev !== sid && !panels.has(prev)) manager.release(prev);
  }

  function openInEditor(sid: string): void {
    if (!isSessionId(sid)) return;
    if (!manager.get(sid)) {
      const v = viewerOf(sid);
      manager.openViewer(sid, v.cwd, v.itemId, v.itemTitle, v.resumable);
      checkResumable(sid);
    }
    panels.open(sid, titleOf(manager.get(sid)));
    refreshTabs();
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
   * Tells the desk what a chat of this window's is: its assign, or only
   * that this panel runs it ("mark", which never moves its item — a resumed
   * chat's item and spans stay as they are). Kept for later while the desk
   * is down; a refusal is logged and dropped.
   */
  const telling = new Set<string>();
  /** Whether the desk kept an assign's `client`: an older desk drops it, and the list says to update it. */
  function checkMark(sid: string): void {
    client.isMarked(sid).then(
      (kept) => desk.noteMark(kept),
      () => {},
    );
  }
  async function tellDesk(rec: ChatRecord): Promise<void> {
    const sid = rec.chat.sessionId;
    const due = rec.deskDue;
    if (!due || telling.has(sid)) return;
    telling.add(sid);
    try {
      if (due === "mark") {
        const s = await client.session(sid).catch((e) => {
          if (e instanceof DeskError && e.status === 404) return null;
          throw e;
        });
        if (s?.work_item) {
          rec.itemId = s.work_item.id;
          rec.itemTitle = s.work_item.title;
          desk.noteItem(sid, { id: s.work_item.id, title: s.work_item.title });
        }
        const kept = await client.markClient(sid);
        desk.noteMark(kept);
        if (!kept) log(`desk: ${sid.slice(0, 8)} not marked as this panel's: the desk keeps no client (update it)`);
      } else {
        const r = await client.assign(sid, due);
        rec.itemId = r.item_id ?? null;
        rec.itemTitle = r.title ?? rec.itemTitle;
        checkMark(sid);
      }
      rec.deskDue = null;
      log(`desk: ${sid.slice(0, 8)} ${due === "mark" ? "marked as this panel's" : `on ${rec.itemId ?? "untracked"}`}`);
      desk.rebuild();
    } catch (e) {
      if (!(e instanceof DeskError && e.unreachable)) {
        rec.deskDue = null;
        log(`desk: ${sid.slice(0, 8)}: ${(e as Error).message}`);
      }
    } finally {
      telling.delete(sid);
    }
  }

  /**
   * A chat is on its work item before it starts (decision 10): the session
   * id is chosen here, assigned on the desk, and `claude --session-id` starts
   * with the first message. `body` null: no item to give (a fresh chat from
   * one whose item is not known) — the desk only hears this panel runs it,
   * and asks for its item when it sees it.
   */
  async function startChat(
    body: AssignBody | null,
    cwd: string,
    label: string | null,
    opts: { onRefusal?: (why: string) => void; fork?: { from: string; at: string; events: WireMessage[] }; mode?: string } = {},
  ): Promise<ChatRecord | null> {
    const sid = crypto.randomUUID();
    let itemId: string | null = null;
    let itemTitle = label;
    let due: DeskDue | null = null;
    let refused: string | null = null;
    try {
      if (body) {
        const r = await client.assign(sid, body);
        itemId = r.item_id ?? null;
        itemTitle = r.title ?? itemTitle;
        checkMark(sid);
      } else {
        desk.noteMark(await client.markClient(sid));
      }
    } catch (e) {
      if (e instanceof DeskError && e.unreachable) {
        due = body ?? "mark";
        void vscode.window.showWarningMessage("The desk is not running: this chat starts without its work item, and the desk is told when it is back.");
      } else if (opts.onRefusal) {
        // Started all the same, off its item; the caller keeps what it carried.
        refused = (e as Error).message;
        due = "mark";
        itemTitle = null;
      } else {
        void vscode.window.showErrorMessage(`Chat not started: ${(e as Error).message}`);
        return null;
      }
    }
    log(`new chat ${sid} on ${itemId ?? (body && "untracked" in body ? "untracked" : "no item yet")} in ${cwd}`);
    const fork = opts.fork;
    const rec = manager.create(sid, cwd, itemId, itemTitle, { untracked: !!body && "untracked" in body, deskDue: due, fork: fork && { from: fork.from, at: fork.at }, mode: opts.mode });
    // A fork shows the conversation it starts from (decision 73).
    if (fork) rec.chat.preload(fork.events);
    if (refused !== null) opts.onRefusal!(refused);
    desk.rebuild();
    await show(sid);
    if (due === "mark") void tellDesk(rec);
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

  /**
   * The owner wrote to a resumable thread (decision 32): it becomes this
   * window's, and the desk hears only that this panel runs it now — never an
   * assign, which could move it off its item or untrack it and clear its
   * spans, whatever the window had resolved.
   */
  /**
   * Makes a past chat this window's for the owner's message `text`. Refused
   * — something else runs it now, or it is read-only here — the message is
   * not sent and stays on screen in the refusal's note, to copy.
   */
  async function resume(sid: string, text: string): Promise<boolean> {
    const rec = manager.get(sid);
    if (!rec) return false;
    if (rec.ours) return true;
    const refuse = (why: string) => {
      rec.resumable = false;
      // Kept past this view: opening another thread drops it, and the transcript alone would rebuild it without the message.
      manager.keepNote(sid, { type: "_note", text: `${why} Your message was not sent:`, tone: "error", kept: text });
      return false;
    };
    if (!rec.resumable) return refuse("This chat is read-only here.");
    // Asked again at the moment it would start: two writers on one session is what this prevents.
    if (!(await freeToResume(rec))) return refuse("Something else runs this chat now — it stays read-only here; Jump goes to it.");
    if (!manager.adopt(sid)) return refuse("This chat is read-only here.");
    rec.deskDue = "mark";
    void tellDesk(rec);
    return true;
  }

  // ------------------------------------------------------------ chips and names

  // After each turn: chips for the chat on screen (25), a name after a new chat's first turn (12).
  manager.on("turn", (sid: string, _result: unknown, n: number) => {
    const rec = manager.get(sid);
    if (!rec?.ours) return;
    void haiku.turnEnded(sid, () => assistInput(ctx, rec, ""), {
      onScreen: onScreen(sid),
      // A name the owner gave, or a fork's, is not Haiku's to replace (decision 75).
      firstTurn: n === 1 && !rec.chat.opts.existing && !rec.chat.handNamed,
      rename: async (name) => {
        if (rec.chat.handNamed) return;
        log(`[${sid.slice(0, 8)}] named "${name}"`);
        await rec.chat.rename(name);
      },
    });
  });
  manager.on("suggestion", (sid: string, text: string) => haiku.suggestion(sid, text));

  /** "Fresh chat with this handoff" (36): a new chat on the same work item that starts with it; the old one stays readable. */
  async function freshChat(sid: string): Promise<void> {
    const text = haiku.handoffFor(sid);
    const rec = manager.get(sid);
    if (!text || !rec) return;
    const cwd = windowCwd(rec.chat.opts.cwd) ?? rec.chat.opts.cwd;
    // The same item as the desk has it; untracked only when the owner chose that.
    const item = desk.itemFor(sid)?.id ?? rec.itemId;
    const fresh = await startChat(item ? { item_id: item } : rec.untracked ? { untracked: true } : null, cwd, rec.itemTitle);
    if (!fresh) return;
    haiku.handoffTaken(sid);
    haiku.sent(fresh.chat.sessionId);
    fresh.chat.send(text);
  }

  // ------------------------------------------------------------ forks

  /**
   * "Fork conversation from here" (decision 73), as Claude Code's panel forks: a
   * new chat on the same work item that starts as this one's conversation
   * up to the owner's message `uuid` — the CLI's own `--fork-session`, from
   * the transcript — with that message back in its draft, to edit and send.
   * From the first message there is nothing to copy: a new chat with it in
   * the draft. A fork is named as Claude Code names one, this chat's name
   * and "(fork)"; the desk hears of it as of any new chat (decision 10).
   */
  async function forkChat(sid: string, uuid: string): Promise<void> {
    const rec = manager.get(sid);
    if (!rec || !isSessionId(uuid)) return;
    const entry = Object.values(rec.chat.state.entries).find((e) => e.kind === "user" && e.uuid === uuid);
    // One of this chat's own messages, never another chat's (review r4 UI M3).
    if (entry?.kind !== "user") {
      log(`[${sid.slice(0, 8)}] not forked: ${uuid.slice(0, 8)} is not a message of this chat's`);
      return;
    }
    const text = entry.text;
    // `--resume` finds the session by its folder, and a chat runs in the window's (decisions 5, 10).
    const cwd = rec.chat.opts.cwd || rec.chat.state.cwd || "";
    if (!desk.isWindowFolder(cwd)) {
      void vscode.window.showErrorMessage("Not forked: this chat worked in a folder that is not this window's.");
      return;
    }
    const file = findTranscript(sid, cwd);
    const point = file ? forkPoint(file, uuid) : undefined;
    if (!file || !point) {
      void vscode.window.showErrorMessage("Not forked: the message is not in this chat's transcript yet.");
      return;
    }
    // The same item as the desk has it; untracked only when the owner chose that.
    const item = desk.itemFor(sid)?.id ?? rec.itemId;
    const body: AssignBody | null = item ? { item_id: item } : rec.untracked ? { untracked: true } : null;
    const fork = point.at ? { from: sid, at: point.at, events: historyUpTo(file, point.at) } : undefined;
    // In this chat's mode, never a new chat's auto (22): a fork of a chat in Ask or Plan must not act unasked.
    const fresh = await startChat(body, cwd, rec.itemTitle, { fork, mode: rec.chat.state.mode });
    if (!fresh) return;
    log(`[${sid.slice(0, 8)}] forked before ${uuid.slice(0, 8)}: ${fresh.chat.sessionId}`);
    // The fork runs on this chat's model, at its effort and Ultracode (82; review r4 N1): its process starts with them.
    if (rec.chat.pickedModel) await fresh.chat.setModel(rec.chat.pickedModel);
    const { effort, ultracode } = rec.chat.state;
    if (effort || ultracode) await fresh.chat.setEffort(effort, ultracode);
    if (fork) {
      const name = rec.chat.state.title ?? "Chat";
      fresh.chat.note(`Forked from “${name}”. Your message from there is in the draft.`);
      await fresh.chat.renameByHand(`${name} (fork)`);
      panels.retitle(fresh.chat.sessionId, titleOf(fresh));
      desk.rebuild();
    }
    if (text) manager.setDraft(fresh.chat.sessionId, text);
  }

  // ------------------------------------------------------------ names

  /**
   * The owner names a chat (decision 75), from the list, the chat's header or
   * its tab. A chat of this window's takes it as its own (renameByHand); a
   * past one nothing runs gets Claude Code's custom-title line in its
   * transcript. Either way it is Claude's own record of the name (decision
   * 12), so a reload keeps it. A thread something else runs is read-only
   * here (decision 31).
   */
  async function renameChat(sid: string): Promise<void> {
    if (!isSessionId(sid)) return;
    const rec = manager.get(sid);
    const t = desk.thread(sid)?.thread;
    if (!rec?.ours && t?.live) {
      void vscode.window.showInformationMessage("Something else runs this chat: rename it where it runs.");
      return;
    }
    const current = rec?.chat.state.title ?? t?.title ?? "";
    const title = (
      await vscode.window.showInputBox({ prompt: "Rename the chat", value: current, valueSelection: [0, current.length], validateInput: (v) => (v.trim() ? null : "A name, please") })
    )?.trim();
    if (!title || title === current) return;
    if (rec?.ours) await rec.chat.renameByHand(title);
    else {
      // Asked again at the moment it writes: two writers on one transcript is what this prevents.
      const pid = await agentPid(cfg().claudePath, sid);
      const file = findTranscript(sid, rec?.chat.opts.cwd || t?.cwd || undefined);
      if (typeof pid === "number" || !file) {
        void vscode.window.showErrorMessage(`Not renamed: ${file ? "something else runs this chat now" : "no transcript for this chat on this machine"}.`);
        return;
      }
      appendTitle(file, sid, title);
      rec?.chat.noteTitle(title);
    }
    log(`[${sid.slice(0, 8)}] named "${title}" by hand`);
    panels.retitle(sid, title);
    desk.rebuild();
    void desk.refresh();
  }

  // ------------------------------------------------------------ the mailbox

  /** Start work and Open chat from the Desk land here (desk decisions 11, 32, 33). */
  desk.on("mail", async (m: MailboxEntry) => {
    try {
      if (m.kind === "start" && m.item_id) {
        const cwd = windowCwd(m.folder) ?? m.folder;
        const card = desk.card(m.item_id);
        // The entry is taken already: if the desk refuses the assign (the
        // item archived since), the chat starts off its item and Start
        // work's prompt waits in its draft rather than being lost.
        let refused = false;
        const rec = await startChat({ item_id: m.item_id }, cwd, card ? (card.issue ? `${card.issue.key} ${card.issue.title}` : card.title) : null, {
          onRefusal: (why) => {
            refused = true;
            void vscode.window.showErrorMessage(`Start work's chat is not on its work item (${why}); its prompt waits in the draft.`);
          },
        });
        if (rec && !refused && promptu.ready()) {
          // Promptu's pass on the issue instead of the read-and-summarize
          // starter (decision 96, reversing 11 at the owner's word): the
          // dialog opens over the empty chat, the prompt lands in the draft,
          // nothing is sent. A pass that fails or is skipped sends the desk's
          // starter, as 11 did (the owner's P2).
          const rough = startRough(card?.issue?.key, card?.issue?.title ?? card?.title, rec.itemTitle ?? m.item_id);
          void beginPromptu(ctx, rec, { rough, origin: "start", start: true, fallback: m.prompt || undefined, sendFallback: (t) => rec.chat.send(t) }).catch((e) => log(`[${rec.chat.sessionId.slice(0, 8)}] promptu: ${(e as Error).message}`));
        } else if (rec && m.prompt) {
          // Promptu off or not installed: the starter waits in the draft, unsent (11 reversed; the owner's P1).
          manager.setDraft(rec.chat.sessionId, m.prompt);
        }
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
      const w = waitingOff();
      if (w.length) await open(w[0].sessionId);
    }),
    vscode.commands.registerCommand("embarchChat.refresh", () => desk.refresh()),
    // The chat's tab or the sidebar's, from their context menu or the palette (Claude Code's renameSessionTab).
    vscode.commands.registerCommand("embarchChat.renameChat", (sid?: unknown) => {
      // From a chat page's right-click the page names its chat (data-vscode-context), as for Mark as Unread.
      const named = typeof sid === "string" ? sid : typeof (sid as { sid?: unknown } | undefined)?.sid === "string" ? (sid as { sid: string }).sid : null;
      const target = named ?? panels.active() ?? manager.current;
      if (target) return renameChat(target);
    }),
    vscode.commands.registerCommand("embarchChat.showLog", () => output.show()),
    // Claude Code's Mark as Unread: a row of the list or a chat page names its
    // chat (their data-vscode-context); from the palette, the active chat tab,
    // else the sidebar's chat. It stays unread until the owner looks again.
    vscode.commands.registerCommand("embarchChat.markUnread", (arg?: { sid?: unknown }) => {
      const sid = typeof arg?.sid === "string" ? arg.sid : (panels.active() ?? (chatView.view?.visible ? manager.current : null));
      const rec = sid ? manager.get(sid) : undefined;
      if (!rec?.ours) {
        void vscode.window.showInformationMessage("No chat of this window's to mark as unread.");
        return;
      }
      manager.setUnread(rec.chat.sessionId, true);
    }),
  );

  // ------------------------------------------------------------ keys (decision 59)

  // Claude Code's own keys, on chords of their own where both extensions
  // would answer: its Ctrl+Esc and Alt+K are bound wherever an editor has
  // focus, so the chat's are Ctrl+Alt+Esc and Alt+Shift+K; Ctrl+Shift+T
  // stays, each extension's context key being set only when its own tab
  // was the last one closed.
  /**
   * Where a key goes: the chat tab last focused while it shows, else the
   * sidebar's chat — or, with chats in tabs (92), that tab or the current
   * chat brought forward, and with none a new chat.
   */
  const keyTarget = async () => {
    const tab = panels.shownHost();
    if (tab) return tab;
    if (cfg().inTabs) {
      const sid = panels.last() ?? (manager.current && manager.get(manager.current) ? manager.current : null);
      if (!sid) {
        void newChat();
        return undefined;
      }
      openInEditor(sid);
      return panels.host(sid);
    }
    await reveal();
    return chatView.host;
  };
  const lastClosed = (v: boolean) => void vscode.commands.executeCommand("setContext", "embarchChat.lastClosedWasChat", v);
  panels.onClosed = () => lastClosed(true);
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.closed.some((t) => !(t.input instanceof vscode.TabInputWebview && t.input.viewType.includes("embarchChat.chatTab")))) lastClosed(false);
    }),
    vscode.commands.registerCommand("embarchChat.focus", async () => {
      // As Claude Code's: selected lines come along as an @-mention — but
      // not twice: when the editor chip (60) carries the same lines, the
      // chip wins. The chip is brought up to date first, not after the
      // selection's 300 ms pause, and the page then skips the mention.
      const ed = vscode.window.activeTextEditor;
      const host = await keyTarget();
      if (ed && !ed.selection.isEmpty && ed.document.uri.scheme === "file") {
        editor.refresh(ed);
        host?.insertMention(ed, { unlessChip: true });
      }
      host?.focusInput();
    }),
    vscode.commands.registerCommand("embarchChat.blur", () => vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup")),
    vscode.commands.registerCommand("embarchChat.insertAtMention", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.uri.scheme !== "file") return;
      (await keyTarget())?.insertMention(ed);
    }),
    vscode.commands.registerCommand("embarchChat.reopenClosedChat", async () => {
      const sid = panels.reopen();
      // Nothing of ours to reopen: VS Code's own Reopen Closed Editor, as Claude Code falls through to it.
      if (!sid) return vscode.commands.executeCommand("workbench.action.reopenClosedEditor");
      openInEditor(sid);
      lastClosed(panels.canReopen);
    }),
  );

  desk.start();
}

/** Chats die with their window (decision 5) — written down first, for a reload to bring back (63). */
export function deactivate(): Thenable<void> | undefined {
  const saved = reloadMemory?.save();
  reloadMemory?.dispose();
  promptuRuns?.dispose();
  assistant?.dispose();
  deskService?.dispose();
  chats?.dispose();
  deactivateLauncher();
  return saved;
}
