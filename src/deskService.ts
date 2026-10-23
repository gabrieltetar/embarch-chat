// The list's live state comes from the desk alone (decision 20): GET /view
// every 3 s while the list is visible — slower while it is hidden, for the
// waiting count every window shows (35) — joined with this window's own chats
// from their streams and past chats from transcripts. The mailbox (desk
// decision 33) is polled for each of the window's folders.

import * as cp from "child_process";
import { EventEmitter } from "events";
import { DeskClient, DeskError, DeskView, MailboxEntry, ViewDesk } from "./desk/client";
import { ThreadGroup, buildThreads, isUnder, resolveDesk, waitingThreads } from "./desk/threads";
import { TranscriptIndex, TranscriptMeta } from "./wire/transcript";
import type { ChatManager } from "./chats";

const VISIBLE_MS = 3000;
const HIDDEN_MS = 15000;
const MAIL_MS = 3000;
const MAIL_BACKOFF_MS = 60000;
const TRANSCRIPT_MS = 30000;
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

  private async pollOnce(): Promise<void> {
    try {
      this.view = await this.client.view();
      this.error = null;
    } catch (e) {
      this.error = e instanceof DeskError && e.unreachable ? "The desk is not running — showing this window's chats only." : `Desk: ${(e as Error).message}`;
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

  rebuild(): void {
    // Claude names every session itself (an ai-title in the transcript); own
    // chats show it until the assistant names them (decision 12).
    for (const p of this.past) {
      const rec = this.chats.get(p.sessionId);
      if (rec?.ours && p.title && p.title !== rec.chat.state.title) rec.chat.noteTitle(p.title);
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
    });
    this.emit("changed");
  }

  waiting() {
    return waitingThreads(this.groups);
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
        // No desk, or a desk without the mailbox yet: ask again in a minute.
        if (e instanceof DeskError && (e.unreachable || e.status === 404 || e.status === 405)) this.mailBackoffUntil = Date.now() + MAIL_BACKOFF_MS;
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
