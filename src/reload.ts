// After a window reload the chats this window had on screen — the
// sidebar's and its tabs — come back, and one stopped mid-turn goes on
// (decision 63, which amends decision 5 for a reload only): Claude Code's
// `continueAfterReload`. `reinstall.sh` and VS Code server updates reload
// the window, and a reload kills a running flash or study turn. The
// window's other chats stay in the list as past chats, as after a close.
//
// VS Code cannot tell a reload from a close, so a reload is a window that
// comes back within a minute and a half of the last time it wrote its
// chats down — on every change, and every 15 s while it has any. After a
// real close, a later window brings nothing back (decision 5).
//
// A chat that was mid-turn — Claude working, or waiting on the owner —
// resumes at once with the CLI's own CLAUDE_CODE_RESUME_INTERRUPTED_TURN,
// which reruns the step the reload cut off (Chat.continueInterrupted). As
// in Claude Code, at most twice before a turn finishes, never for a step
// past an hour old, and not with the setting off: then the chat says no
// reply follows. Something still running it keeps it read-only (31).

import * as fs from "fs";
import * as vscode from "vscode";
import type { ChatManager } from "./chats";
import { agentPid } from "./jump";
import { NO_REPLY_NOTE, RERUN_MAX_AGE_MS } from "./wire/chat";
import { findTranscript } from "./wire/transcript";
import { historyUpTo } from "./wire/history";

const KEY = "embarchChat.openChats";
/** A window back within this long of its last note is a reload. */
export const RELOAD_WINDOW_MS = 90_000;
const HEARTBEAT_MS = 15_000;
/** Claude Code's own bound: two reruns without a finished turn. */
const MAX_RERUNS = 2;
/** How long a process the reload left behind may take to go before the chat stays read-only. */
const RELEASE_WAIT_MS = 10_000;

interface SavedChat {
  sid: string;
  cwd: string;
  itemId: string | null;
  itemTitle: string | null;
  untracked: boolean;
  /** Mid-turn when written: Claude working, or waiting on the owner. */
  running: boolean;
  tab: boolean;
  reruns: number;
  /** A name the owner gave before the chat's first message, not yet sent (decision 75). */
  title?: string;
  /** A fork no message was sent to yet: where it starts from (decision 73). */
  fork?: { from: string; at: string };
  /** A turn finished unseen: it comes back unread, as Claude Code keeps its marks. */
  unread?: boolean;
  /** The chat's own effort and Ultracode: a step continued after the reload runs at them too. */
  effort?: string;
  ultracode?: boolean;
}

interface Saved {
  at: number;
  current: string | null;
  chats: SavedChat[];
}

/** Writes this window's own chats down as they change, for the window that comes back after a reload. */
export class ReloadMemory implements vscode.Disposable {
  private reruns = new Map<string, number>();
  private timer: NodeJS.Timeout;

  constructor(
    private state: vscode.Memento,
    private manager: ChatManager,
    private tabs: () => string[],
  ) {
    manager.on("changed", this.onChanged);
    manager.on("turn", this.onTurn);
    this.timer = setInterval(() => void this.save(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private onChanged = () => void this.save();
  /** A finished turn: its chat may be rerun twice again. */
  private onTurn = (sid: string) => {
    this.reruns.delete(sid);
    void this.save();
  };

  rerunsOf(sid: string): number {
    return this.reruns.get(sid) ?? 0;
  }

  noteRerun(sid: string, n: number): void {
    this.reruns.set(sid, n);
  }

  save(): Thenable<void> {
    const tabs = new Set(this.tabs());
    const chats: SavedChat[] = [];
    for (const [sid, r] of this.manager.records) {
      if (!r.ours) continue;
      const st = r.chat.state;
      chats.push({
        sid,
        cwd: r.chat.opts.cwd,
        itemId: r.itemId,
        itemTitle: r.itemTitle,
        untracked: r.untracked,
        running: r.chat.running && (st.busy || st.compacting || st.pending.length > 0),
        tab: tabs.has(sid),
        reruns: this.rerunsOf(sid),
        ...(r.chat.pendingName ? { title: r.chat.pendingName } : {}),
        ...(r.chat.pendingFork ? { fork: r.chat.pendingFork } : {}),
        ...(r.unread ? { unread: true } : {}),
        ...(st.effort ? { effort: st.effort } : {}),
        ...(st.ultracode ? { ultracode: true } : {}),
      });
    }
    const saved: Saved | undefined = chats.length ? { at: Date.now(), current: this.manager.current, chats } : undefined;
    return this.state.update(KEY, saved);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.manager.off("changed", this.onChanged);
    this.manager.off("turn", this.onTurn);
  }
}

export interface RestoreCtx {
  state: vscode.Memento;
  manager: ChatManager;
  memory: ReloadMemory;
  claudePath: () => string;
  /** `embarchChat.continueAfterReload`. */
  enabled: () => boolean;
  log: (s: string) => void;
  /** The chat the sidebar showed, shown there again without taking focus. */
  show: (sid: string) => void;
  openTab: (sid: string) => void;
}

/** Brings back what the window had open before a reload; nothing after a close. */
export async function restoreAfterReload(o: RestoreCtx): Promise<void> {
  const saved = o.state.get<Saved>(KEY);
  if (!saved?.chats?.length) return;
  const age = Date.now() - saved.at;
  if (age > RELOAD_WINDOW_MS) {
    o.log(`${saved.chats.length} chat(s) of the last window not brought back: it closed ${Math.round(age / 1000)} s ago, not a reload (decision 5)`);
    await o.state.update(KEY, undefined);
    return;
  }
  // On screen or mid-turn: each one's transcript is read now, so not every chat the window ever had.
  const back = saved.chats.filter((c) => c.running || c.tab || c.sid === saved.current);
  o.log(`window reloaded: ${back.length} chat(s) back`);
  for (const c of back) {
    // A chat no message was sent to has no transcript to resume: it comes
    // back new, with a name the owner gave it (decision 75) — a fork still
    // a fork, showing what it starts from (73). Any other is read-only
    // until nothing else runs it (31); a reload's own process is gone by then.
    const fresh = !findTranscript(c.sid, c.cwd || undefined);
    const rec = fresh ? o.manager.create(c.sid, c.cwd, c.itemId, c.itemTitle, { untracked: c.untracked, fork: c.fork }) : o.manager.openViewer(c.sid, c.cwd, c.itemId, c.itemTitle, true);
    if (!rec) continue;
    const parent = fresh && c.fork ? findTranscript(c.fork.from, c.cwd || undefined) : null;
    if (parent) rec.chat.preload(historyUpTo(parent, c.fork!.at));
    if (fresh && c.title) void rec.chat.renameByHand(c.title);
    rec.untracked = c.untracked;
    if (c.unread) rec.unread = true;
    // No process runs it yet: the next one starts with them.
    if (c.effort || c.ultracode) void rec.chat.setEffort(c.effort ?? null, !!c.ultracode);
    o.memory.noteRerun(c.sid, c.reruns);
    if (c.tab) o.openTab(c.sid);
    void bringBack(o, c);
  }
  if (saved.current && o.manager.get(saved.current)) o.show(saved.current);
}

async function bringBack(o: RestoreCtx, c: SavedChat): Promise<void> {
  const tag = `[${c.sid.slice(0, 8)}]`;
  const t0 = Date.now();
  for (;;) {
    const pid = await agentPid(o.claudePath(), c.sid);
    if (!pid) break;
    if (Date.now() - t0 > RELEASE_WAIT_MS) {
      o.log(`${tag} still runs elsewhere (pid ${pid}) after the reload: read-only here`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const rec = o.manager.adopt(c.sid);
  if (!rec) return;
  rec.itemId = c.itemId ?? rec.itemId;
  rec.itemTitle = c.itemTitle ?? rec.itemTitle;
  if (!c.running) return;
  const file = findTranscript(c.sid, c.cwd || undefined);
  const stepAge = file ? Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) : Infinity;
  const why = !o.enabled() ? "continueAfterReload is off" : c.reruns >= MAX_RERUNS ? `rerun ${c.reruns} times already` : stepAge >= RERUN_MAX_AGE_MS ? "the step is over an hour old" : null;
  if (why) {
    o.log(`${tag} the interrupted step is not continued: ${why}`);
    rec.chat.note(NO_REPLY_NOTE);
    return;
  }
  o.log(`${tag} continuing the step the reload interrupted (rerun ${c.reruns + 1})`);
  o.memory.noteRerun(c.sid, c.reruns + 1);
  void o.memory.save();
  rec.chat.continueInterrupted();
}
