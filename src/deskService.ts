// The list's live state comes from the desk alone (decision 20): GET /view
// every 3 s while the list is visible — slower while it is hidden, for the
// waiting count every window shows (35) — joined with this window's own chats
// from their streams and past chats from transcripts. The mailbox (desk
// decision 33) is polled for each of the window's folders.

import * as cp from "child_process";
import { EventEmitter } from "events";
import { DeskClient, DeskError, DeskView, MailboxEntry, ViewDesk, refusesDesk } from "./desk/client";
import { ThreadGroup, buildThreads, isUnder, ownDesk, resolveDesk, waitingThreads } from "./desk/threads";
import { TranscriptIndex, TranscriptMeta } from "./wire/transcript";
import type { ChatManager } from "./chats";

const VISIBLE_MS = 3000;
const HIDDEN_MS = 15000;
const MAIL_MS = 3000;
const MAIL_BACKOFF_MS = 60000;
const TRANSCRIPT_MS = 30000;
/**
 * How often a desk found too old is asked again: an update clears the notice
 * without a reload. Most updates are seen sooner — a kept mark, or a view
 * whose fields moved — this is for the one that changes neither.
 */
const RECHECK_MS = 60_000;
const DAY = 86_400_000;

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile("git", ["-C", dir, ...args], { timeout: 5000 }, (err, out) => resolve(err ? "" : out.trim()));
  });
}

/** The main clone a folder belongs to: itself, or the repo a worktree hangs off. */
async function mainRepo(folder: string): Promise<string> {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.endsWith("/.git") ? common.slice(0, -5) : folder;
}

async function worktrees(repo: string): Promise<string[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
}

/** Events: `changed` (groups moved), `mail` (an entry this window took). */
export class DeskService extends EventEmitter {
  view: DeskView | null = null;
  desk: ViewDesk | null = null;
  groups: ThreadGroup[] = [];
  error: string | null = null;
  visible = false;
  private repos: string[] = [];
  private reposAt = 0;
  private mains: string[] = [];
  private past: TranscriptMeta[] = [];
  private pastAt = 0;
  private itemOf: Record<string, { id: string; title: string } | null> = {};
  /** The desk whose repo holds the window's folder, once known: its cards are asked for by name. */
  private ownDeskId: string | null = null;
  /** The desk the current view's cards belong to, when asked for one. */
  private scopedTo: string | null = null;
  /** Whether the desk reads `/view?desk=` (null: not asked yet), and when it was asked. */
  private deskParam: boolean | null = null;
  private deskParamAt = 0;
  /** Whether the desk kept the last `client` mark read back (null: none read yet). */
  private marks: boolean | null = null;
  /** The view's top-level fields at the last poll: another set is another build of the desk. */
  private shape: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private mailTimer: NodeJS.Timeout | undefined;
  private mailBackoffUntil = 0;
  private current: Promise<void> | null = null;
  private disposed = false;
  private index = new TranscriptIndex();

  constructor(
    private desk_: () => DeskClient,
    private chats: ChatManager,
    private folders: () => string[],
    private log: (line: string) => void,
  ) {
    super();
    chats.on("changed", () => this.rebuild());
  }

  get client(): DeskClient {
    return this.desk_();
  }

  start(): void {
    void this.init();
  }

  private async init(): Promise<void> {
    this.mains = await Promise.all(this.folders().map(mainRepo));
    await this.poll();
    this.schedule();
    this.scheduleMail(0);
  }

  setVisible(v: boolean): void {
    const was = this.visible;
    this.visible = v;
    if (v && !was) {
      void this.poll();
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      async () => {
        await this.poll();
        this.schedule();
      },
      this.visible ? VISIBLE_MS : HIDDEN_MS,
    );
  }

  async refresh(): Promise<void> {
    this.pastAt = 0;
    this.reposAt = 0;
    await this.poll();
  }

  /** One poll at a time; a caller arriving mid-poll waits for it and then polls afresh. */
  async poll(): Promise<void> {
    while (this.current) await this.current;
    if (this.disposed) return;
    this.current = this.pollOnce().finally(() => (this.current = null));
    return this.current;
  }

  /**
   * One line for the list when the running desk predates this panel's side
   * of it (embarch-desk b722b3b): it ignores `/view?desk=`, or it does not
   * keep which chats run here (`client`). Without it, a window on another
   * desk than the open one would show the open desk's cards as its own.
   */
  get notice(): string | null {
    if (this.deskParam !== false && this.marks !== false) return null;
    const foreign = this.deskParam === false && !!this.desk && this.desk.id !== this.view?.open_desk?.id;
    return `Update embarch-desk: the running one predates this panel${foreign ? " — only chats in this window's repos show" : ""}.`;
  }

  /**
   * What a read-back of a session's `client` said (after an assign or a
   * mark). A desk that keeps it is new enough to be asked about `?desk=`
   * again: on the next poll, not at the next recheck.
   */
  noteMark(kept: boolean): void {
    const recheck = kept && this.deskParam === false;
    if (this.marks === kept && !recheck) return;
    this.marks = kept;
    if (recheck) {
      this.log("the desk keeps this panel's mark now: asked again whether it reads ?desk=");
      this.deskParam = null;
    }
    this.emit("changed");
  }

  /**
   * A desk restarted as another build between two polls — an update, so no
   * poll saw it down — answers with other top-level fields: what was asked
   * of the old one is asked again. True when that happened.
   */
  private reshaped(v: DeskView): boolean {
    const shape = Object.keys(v ?? {}).sort().join(",");
    const moved = this.shape !== null && shape !== this.shape;
    this.shape = shape;
    if (!moved || (this.deskParam === null && this.marks === null)) return false;
    this.log("the desk's view has other fields (another build?): asked again whether it reads ?desk=");
    this.deskParam = null;
    this.marks = null;
    return true;
  }

  /** Whether `/view?desk=` may be used: asked once, again after an outage or an update, and every minute while it may not. */
  private async scopedViews(): Promise<boolean> {
    if (this.deskParam === null || (!this.deskParam && Date.now() - this.deskParamAt > RECHECK_MS)) {
      const was = this.deskParam;
      this.deskParam = await this.client.readsDeskParam();
      this.deskParamAt = Date.now();
      if (was === false && this.deskParam) {
        this.log("the desk reads ?desk= now: updated");
        this.marks = null;
      }
      if (!this.deskParam) this.log("the desk ignores ?desk=: it predates this panel; the open desk's view, by repo");
    }
    return this.deskParam;
  }

  /**
   * The view for this window (decision 9): its own desk's cards
   * (`/view?desk=`) when its folder is in a desk's repo, else the open
   * desk's. A desk deleted since answers 404 (any 4xx but the token's
   * counts: the Interface does not pin it): the plain view, and the
   * window's desk is found again from it. A desk that ignores `?desk=`
   * (one older than this panel) gets the plain view too: its cards are
   * the open desk's, and buildThreads keeps only those in this window's
   * repos.
   */
  private async fetchView(again = false): Promise<DeskView> {
    if (this.ownDeskId && (await this.scopedViews())) {
      try {
        const v = await this.client.view(this.ownDeskId);
        this.scopedTo = this.ownDeskId;
        // Another build since it was asked: its answer to `?desk=` may have changed too.
        if (this.reshaped(v) && !again) return this.fetchView(true);
        return v;
      } catch (e) {
        if (!refusesDesk(e)) throw e;
        this.log(`desk ${this.ownDeskId} is gone: the open desk's view`);
        this.ownDeskId = null;
      }
    }
    this.scopedTo = null;
    let v = await this.client.view();
    if (this.reshaped(v) && !again) return this.fetchView(true);
    const own = ownDesk([...this.folders(), ...this.mains], v.desks ?? []);
    this.ownDeskId = own?.id ?? null;
    if (own && own.id !== v.open_desk?.id && (await this.scopedViews())) {
      // Another desk than the open one: its cards now, not after a poll.
      try {
        v = await this.client.view(own.id);
        this.scopedTo = own.id;
      } catch (e) {
        if (!refusesDesk(e)) throw e;
        this.ownDeskId = null;
      }
    }
    return v;
  }

  private async pollOnce(): Promise<void> {
    const wasDown = this.error !== null;
    try {
      this.view = await this.fetchView();
      this.error = null;
      // Back after an outage: the mailbox is asked now, not after its backoff.
      if (wasDown || this.mailBackoffUntil) {
        this.mailBackoffUntil = 0;
        this.scheduleMail(0);
      }
    } catch (e) {
      this.error = e instanceof DeskError && e.unreachable ? "The desk is not running — showing this window's chats only." : `Desk: ${(e as Error).message}`;
      // It may come back as another build: asked again then.
      if (e instanceof DeskError && e.unreachable) {
        this.deskParam = null;
        this.marks = null;
      }
    }
    const folders = this.folders();
    this.desk = this.view ? resolveDesk([...folders, ...this.mains], this.view.desks ?? [], this.view.open_desk ?? null) : null;
    await this.refreshRepos();
    await this.refreshPast();
    this.rebuild();
  }

  private async refreshRepos(): Promise<void> {
    if (Date.now() - this.reposAt < 60000 && this.repos.length) return;
    const base = new Set<string>([...this.folders(), ...this.mains, ...(this.desk?.firmware_repos ?? [])]);
    for (const r of [...(this.desk?.firmware_repos ?? []), ...this.mains]) {
      for (const w of await worktrees(r)) base.add(w);
    }
    this.repos = [...base];
    this.reposAt = Date.now();
  }

  private async refreshPast(): Promise<void> {
    if (Date.now() - this.pastAt < TRANSCRIPT_MS) return;
    this.pastAt = Date.now();
    this.past = this.index.list(this.repos, Date.now() - 30 * DAY);
    // A past chat's work item, asked of the desk once per session.
    if (!this.view) return;
    const known = new Set<string>();
    for (const c of this.view.cards ?? []) for (const s of c.live_sessions ?? []) known.add(s.session_id);
    const ask = this.past.filter((p) => !(p.sessionId in this.itemOf) && !known.has(p.sessionId) && !this.chats.get(p.sessionId)?.ours).slice(0, 25);
    for (const p of ask) {
      try {
        const s = await this.client.session(p.sessionId);
        this.itemOf[p.sessionId] = s.work_item ? { id: s.work_item.id, title: s.work_item.title } : null;
      } catch (e) {
        if (e instanceof DeskError && e.status === 404) this.itemOf[p.sessionId] = null;
        else break;
      }
    }
  }

  /** The work item the desk has a session on, when its view or a lookup says; null when it has none or does not know. */
  itemFor(sid: string): { id: string; title: string } | null {
    const row = this.view?.sessions?.find((s) => s.session_id === sid);
    if (row?.item_id) {
      const card = this.card(row.item_id);
      return { id: row.item_id, title: card ? (card.issue ? `${card.issue.key} ${card.issue.title}` : card.title) : (this.itemOf[sid]?.title ?? row.item_id) };
    }
    for (const c of this.view?.cards ?? []) {
      if (c.live_sessions?.some((x) => x.session_id === sid)) return { id: c.id, title: c.issue ? `${c.issue.key} ${c.issue.title}` : c.title };
    }
    return this.itemOf[sid] ?? null;
  }

  /** Learns what the desk knows of a session's item (a past chat's, asked once). */
  noteItem(sid: string, item: { id: string; title: string } | null): void {
    this.itemOf[sid] = item;
  }

  rebuild(): void {
    // Session → item is the desk's (decision 12): a chat's record follows
    // what the desk says, once it says it — a chat opened or started while
    // the desk was down or had not been asked carries no item until then.
    for (const [sid, rec] of this.chats.records) {
      const it = this.itemFor(sid);
      if (it && it.id !== rec.itemId) {
        rec.itemId = it.id;
        rec.itemTitle = it.title;
      }
    }
    // Claude names every session itself (an ai-title in the transcript); own
    // chats show it until the assistant names them (decision 12) — a name
    // given here is not taken back by a transcript read before it.
    for (const p of this.past) {
      const rec = this.chats.get(p.sessionId);
      if (rec?.ours && !rec.chat.renamed && p.title && p.title !== rec.chat.state.title) rec.chat.noteTitle(p.title);
    }
    // Session ids the desk's view places on an item, for live sessions it lists without a title.
    for (const s of this.view?.sessions ?? []) {
      if (s.item_id && !this.itemOf[s.session_id]) {
        const card = this.view?.cards.find((c) => c.id === s.item_id);
        if (card) this.itemOf[s.session_id] = { id: card.id, title: card.issue ? `${card.issue.key} ${card.issue.title}` : card.title };
      }
    }
    this.groups = buildThreads({
      view: this.view,
      desk: this.desk,
      repos: this.repos,
      own: this.chats.own(),
      past: this.past.map((p) => ({ sessionId: p.sessionId, title: p.title, firstPrompt: p.firstPrompt, cwd: p.cwd, lastMs: p.lastMs })),
      itemOf: this.itemOf,
      now: Date.now(),
      scopedTo: this.scopedTo,
    });
    this.emit("changed");
  }

  waiting() {
    return waitingThreads(this.groups);
  }

  /**
   * Keeps a reply on the chat's work item as a note of its kind (decision
   * 40: the item is where knowledge gathers; decision 12: no store of the
   * panel's own). `held` when the chat has no item yet: the desk keeps it
   * until it gets one.
   */
  async keep(sid: string, text: string, kind: "finding" | "decision"): Promise<{ held: boolean }> {
    const r = await this.client.addLine(sid, text, kind);
    this.log(`desk: a ${kind} kept from ${sid.slice(0, 8)}${r.held ? " (held: no work item yet)" : ` on ${r.tile ?? "its item"}`}`);
    return { held: !!r.held };
  }

  /** The card for a work item, when the view carries it. */
  card(itemId: string | null) {
    if (!itemId) return null;
    return this.view?.cards.find((c) => c.id === itemId) ?? null;
  }

  thread(sid: string) {
    for (const g of this.groups) {
      const t = g.threads.find((x) => x.sessionId === sid);
      if (t) return { group: g, thread: t };
    }
    return null;
  }

  isWindowFolder(cwd: string | null | undefined): boolean {
    return this.folders().some((f) => isUnder(cwd, f));
  }

  // -------------------------------------------------------------- mailbox

  private scheduleMail(ms = MAIL_MS): void {
    if (this.disposed) return;
    if (this.mailTimer) clearTimeout(this.mailTimer);
    this.mailTimer = setTimeout(() => void this.pollMail(), ms);
  }

  private async pollMail(): Promise<void> {
    if (Date.now() < this.mailBackoffUntil) return this.scheduleMail();
    for (const folder of this.folders()) {
      let entries: MailboxEntry[];
      try {
        entries = await this.client.mailbox(folder);
      } catch (e) {
        // No desk, a desk without the mailbox yet, or a URL refused: ask again in a minute.
        if (e instanceof DeskError && (e.unreachable || e.refused || e.status === 404 || e.status === 405)) this.mailBackoffUntil = Date.now() + MAIL_BACKOFF_MS;
        else this.log(`mailbox: ${(e as Error).message}`);
        break;
      }
      for (const m of entries) {
        if (m.taken_ms) continue;
        try {
          const got = await this.client.take(m.id);
          if (got) {
            this.log(`mailbox: took ${got.kind} ${got.id}`);
            this.emit("mail", got);
          }
        } catch (e) {
          this.log(`mailbox take ${m.id}: ${(e as Error).message}`);
        }
      }
    }
    this.scheduleMail();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.mailTimer) clearTimeout(this.mailTimer);
    this.removeAllListeners();
  }
}
