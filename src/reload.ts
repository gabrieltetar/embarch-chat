// After a window reload the chats this window had on screen — the
// sidebar's and its tabs — come back, and one stopped mid-turn can go on
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
// comes back in the mode it ran in, with the step the reload cut off and a
// "Continue the interrupted step" button: the step is never rerun by
// itself, since a close and a reopen within the minute and a half look the
// same as a reload, and a close may have been meant to stop it (a flash, a
// study). The button resumes it with the CLI's own
// CLAUDE_CODE_RESUME_INTERRUPTED_TURN, which reruns that step
// (Chat.continueInterrupted). As in Claude Code, at most twice before a
// turn finishes, never for a step past an hour old, and not with the
// setting off: then the chat says no reply follows. Something still
// running it keeps it read-only (31).
//
// The owner's words never go with the window: a draft typed and not sent
// comes back into the draft (an editor tab's page keeps no state across a
// reload, the sidebar's does); what the CLI had not taken —
// messages waiting above the input, a /compact's held rest, one written
// while the process closed, a new chat's first message the CLI had not
// written down — comes back waiting above the input again when Continue
// is offered (Continue takes it, or the owner's next message does), and
// otherwise back into the draft with a line that says so, as after a crash
// (Chat.releaseUntaken: no process starts again unasked, 41; a held rest
// goes back as for a stopped compaction, 36).

import * as fs from "fs";
import * as vscode from "vscode";
import type { ChatManager, ChatRecord } from "./chats";
import { agentPid } from "./jump";
import { NO_REPLY_NOTE, RERUN_MAX_AGE_MS, Untaken } from "./wire/chat";
import { MODES, findTranscript, holdsMessage, transcriptMode } from "./wire/transcript";
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
  /** Mid-turn when written: Claude working, or waiting on the owner — or still offering to continue a step a reload cut off. */
  running: boolean;
  tab: boolean;
  reruns: number;
  /** The chat's permission mode: a step continued after the reload, and the next message, run in it — never a new chat's auto (22). */
  mode?: string;
  /** A name the owner gave before the chat's first message, not yet sent (decision 75). */
  title?: string;
  /** A fork no message was sent to yet: where it starts from (decision 73). */
  fork?: { from: string; at: string };
  /** A turn finished unseen: it comes back unread, as Claude Code keeps its marks. */
  unread?: boolean;
  /** The model the owner picked for the chat: a step continued after the reload, and the next message, run on it (review r4 N1). */
  model?: string;
  /** The chat's own effort and Ultracode: a step continued after the reload runs at them too. */
  effort?: string;
  ultracode?: boolean;
  /** The owner's messages the CLI had not taken: they come back. */
  untaken?: Untaken[];
  /** Text that waited for the chat's draft. */
  draft?: string;
  /** The owner's own draft, typed and not sent, as the page last told it. */
  typed?: string;
}

interface Saved {
  at: number;
  current: string | null;
  chats: SavedChat[];
}

/** Writes this window's own chats down as they change, for the window that comes back after a reload. */
export class ReloadMemory implements vscode.Disposable {
  private reruns = new Map<string, number>();
  /** Chats being brought back: written down as they were until they are (a second reload meanwhile keeps them). */
  private restoring = new Map<string, SavedChat>();
  private timer: NodeJS.Timeout;
  /** Gone with its window: a bring-back still waiting must not write over the next window's note. */
  private disposed = false;

  constructor(
    private state: vscode.Memento,
    private manager: ChatManager,
    private tabs: () => string[],
    private log: (s: string) => void = () => {},
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

  bringingBack(c: SavedChat): void {
    this.restoring.set(c.sid, c);
  }

  /** Brought back, or left read-only: the chat's own record says the rest from now on. */
  settled(sid: string): void {
    this.restoring.delete(sid);
    void this.save();
  }

  /**
   * "Continue the interrupted step" (63): the owner's click, never the
   * reload's own. The chat runs in the mode it was in, and what waited above
   * the input goes after the step. Claude Code's limits are checked again at
   * the click (review r5 N4): an offer left past the hour, or past two
   * reruns, would start a CLI that reruns nothing — it says no reply follows
   * instead, and the waiting messages go back to the draft.
   */
  continueStep(sid: string): void {
    const rec = this.manager.get(sid);
    if (!rec?.ours || !rec.chat.state.rerunOffer || rec.chat.running) return;
    const age = stepAge(sid, rec.chat.opts.cwd);
    const why = this.rerunsOf(sid) >= MAX_RERUNS ? `rerun ${this.rerunsOf(sid)} times already` : age >= RERUN_MAX_AGE_MS ? "the step is over an hour old" : null;
    if (why) {
      this.log(`[${sid.slice(0, 8)}] the interrupted step is not continued: ${why}, by the owner's click`);
      const n = rec.chat.withdrawRerun();
      if (n) rec.chat.note(`${n === 1 ? "A message" : `${n} messages`} Claude had not taken when the window reloaded ${n === 1 ? "is" : "are"} back in the draft.`);
      void this.save();
      return;
    }
    const n = this.rerunsOf(sid) + 1;
    this.log(`[${sid.slice(0, 8)}] continuing the step the reload interrupted, on the owner's word (rerun ${n})`);
    this.noteRerun(sid, n);
    rec.chat.continueInterrupted();
    void this.save();
  }

  save(): Thenable<void> {
    if (this.disposed) return Promise.resolve();
    const tabs = new Set(this.tabs());
    const chats: SavedChat[] = [...this.restoring.values()].map((c) => ({ ...c, tab: tabs.has(c.sid) || c.tab }));
    for (const [sid, r] of this.manager.records) {
      if (!r.ours || this.restoring.has(sid)) continue;
      const st = r.chat.state;
      const untaken = r.chat.untaken();
      chats.push({
        sid,
        cwd: r.chat.opts.cwd,
        itemId: r.itemId,
        itemTitle: r.itemTitle,
        untracked: r.untracked,
        running: (r.chat.running && (st.busy || st.compacting || st.pending.length > 0)) || !!st.rerunOffer,
        tab: tabs.has(sid),
        reruns: this.rerunsOf(sid),
        mode: st.mode,
        ...(r.chat.pendingName ? { title: r.chat.pendingName } : {}),
        ...(r.chat.pendingFork ? { fork: r.chat.pendingFork } : {}),
        ...(r.unread ? { unread: true } : {}),
        ...(r.chat.pickedModel ? { model: r.chat.pickedModel } : {}),
        ...(st.effort ? { effort: st.effort } : {}),
        ...(st.ultracode ? { ultracode: true } : {}),
        ...(untaken.length ? { untaken } : {}),
        ...(r.draft ? { draft: r.draft } : {}),
        ...(r.typed?.trim() ? { typed: r.typed } : {}),
      });
    }
    const saved: Saved | undefined = chats.length ? { at: Date.now(), current: this.manager.current, chats } : undefined;
    return this.state.update(KEY, saved);
  }

  dispose(): void {
    this.disposed = true;
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
  /** `embarchChat.continueAfterReload`: offer to continue an interrupted step. */
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
  // On screen, mid-turn, or holding the owner's words: each one's transcript is read now, so not every chat the window ever had.
  const back = saved.chats.filter((c) => c.running || c.tab || c.sid === saved.current || c.untaken?.length || c.draft);
  o.log(`window reloaded: ${back.length} chat(s) back`);
  // Written down as they were until each is back: the first record made rewrites the key.
  for (const c of back) o.memory.bringingBack(c);
  for (const c of back) {
    // A chat with no conversation on record — no message sent to it, or a
    // first one the CLI had not written down — has nothing to resume: it
    // comes back new, with a name the owner gave it (decision 75) — a fork
    // still a fork, showing what it starts from (73). Any other is
    // read-only until nothing else runs it (31); a reload's own process is
    // gone by then. Either way in its own mode, never a new chat's auto.
    const file = findTranscript(c.sid, c.cwd || undefined);
    const fresh = !file || !holdsMessage(file);
    const mode = c.mode && MODES.includes(c.mode) ? c.mode : ((file && transcriptMode(file)) ?? "default");
    const rec = fresh
      ? o.manager.create(c.sid, c.cwd, c.itemId, c.itemTitle, { untracked: c.untracked, fork: c.fork, mode, settle: !!file })
      : o.manager.openViewer(c.sid, c.cwd, c.itemId, c.itemTitle, true, mode);
    if (!rec) {
      o.memory.settled(c.sid);
      continue;
    }
    const parent = fresh && c.fork ? findTranscript(c.fork.from, c.cwd || undefined) : null;
    if (parent) rec.chat.preload(historyUpTo(parent, c.fork!.at));
    if (fresh && c.title) void rec.chat.renameByHand(c.title);
    rec.untracked = c.untracked;
    if (c.unread) rec.unread = true;
    // The owner's unsent draft, for the page that shows it — before its tab opens; kept again by a second reload.
    if (c.typed) rec.typed = rec.typedBack = c.typed;
    // No process runs it yet: the next one starts with them.
    if (c.model) void rec.chat.setModel(c.model);
    if (c.effort || c.ultracode) void rec.chat.setEffort(c.effort ?? null, !!c.ultracode);
    o.memory.noteRerun(c.sid, c.reruns);
    if (c.tab) o.openTab(c.sid);
    void bringBack(o, c, fresh).finally(() => o.memory.settled(c.sid));
  }
  if (saved.current && o.manager.get(saved.current)) o.show(saved.current);
}

async function bringBack(o: RestoreCtx, c: SavedChat, fresh: boolean): Promise<void> {
  const tag = `[${c.sid.slice(0, 8)}]`;
  const t0 = Date.now();
  for (;;) {
    const pid = await agentPid(o.claudePath(), c.sid);
    if (!pid) break;
    if (Date.now() - t0 > RELEASE_WAIT_MS) {
      o.log(`${tag} still runs elsewhere (pid ${pid}) after the reload: read-only here`);
      keepWords(o, c, untakenOf(o.manager.get(c.sid), c));
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const rec = o.manager.adopt(c.sid);
  if (!rec) {
    keepWords(o, c, untakenOf(o.manager.get(c.sid), c));
    return;
  }
  rec.itemId = c.itemId ?? rec.itemId;
  rec.itemTitle = c.itemTitle ?? rec.itemTitle;
  if (c.draft) o.manager.setDraft(c.sid, c.draft);
  const words = untakenOf(rec, c);
  // Nothing on record to continue: a new chat's words go back to the draft, and nothing runs.
  if (!c.running || fresh) return toDraft(o, rec, words);
  const why = !o.enabled() ? "continueAfterReload is off" : c.reruns >= MAX_RERUNS ? `rerun ${c.reruns} times already` : stepAge(c.sid, c.cwd) >= RERUN_MAX_AGE_MS ? "the step is over an hour old" : null;
  if (why) {
    o.log(`${tag} the interrupted step is not continued: ${why}`);
    rec.chat.note(NO_REPLY_NOTE);
    return toDraft(o, rec, words);
  }
  o.log(`${tag} the step the reload interrupted waits for the owner's word`);
  rec.chat.offerRerun();
  // The CLI takes them after the step it reruns: they wait for Continue, as they waited for the step.
  // A held rest's compaction will not come now, and images were not written down: those go to the draft.
  if (words.some((w) => w.held || w.images)) toDraft(o, rec, words);
  else if (words.length) rec.chat.restoreQueued(words);
}

/** How long ago the chat's transcript was last written — the step a reload cut off, as Claude Code dates it. */
function stepAge(sid: string, cwd: string): number {
  const file = findTranscript(sid, cwd || undefined);
  return file ? Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) : Infinity;
}

/** The saved messages the CLI did not take after all: none whose uuid is on record in the transcript. */
function untakenOf(rec: ChatRecord | undefined, c: SavedChat): Untaken[] {
  const list = c.untaken ?? [];
  if (!list.length || !rec) return list;
  const onRecord = new Set<string>();
  for (const e of Object.values(rec.chat.state.entries)) if (e.kind === "user" && e.uuid && !e.id.startsWith("s:")) onRecord.add(e.uuid);
  return list.filter((w) => !w.uuid || !onRecord.has(w.uuid));
}

/** Back into the draft, with a line that says so, as after a crash. */
function toDraft(o: RestoreCtx, rec: ChatRecord, words: Untaken[]): void {
  if (!words.length) return;
  o.manager.setDraft(rec.chat.sessionId, words.map((w) => w.text).join("\n\n"));
  const n = words.length;
  const images = words.some((w) => w.images) ? "; paste the images again" : "";
  rec.chat.note(`${n === 1 ? "A message" : `${n} messages`} Claude had not taken when the window reloaded ${n === 1 ? "is" : "are"} back in the draft${images}.`);
  o.log(`[${rec.chat.sessionId.slice(0, 8)}] ${n} message(s) not taken before the reload: back in the draft`);
}

/** A chat that stays read-only here: the words stay with it, to copy (as a refused resume keeps them). */
function keepWords(o: RestoreCtx, c: SavedChat, words: Untaken[]): void {
  const text = [c.draft ?? "", ...words.map((w) => w.text)].filter((t) => t.trim()).join("\n\n");
  if (!text) return;
  o.manager.keepNote(c.sid, { type: "_note", text: "The window reloaded before Claude took your message, and this chat runs elsewhere now. Not sent:", tone: "error", kept: text });
}
