// The chats this window has open: its own (each with a `claude` process
// while in use, decision 5) and read-only views of threads it does not run
// (decision 31). A chat belongs to the window that started it; one this
// window opens from a transcript becomes its own only when the owner sends a
// message to it here, which resumes it (a chat whose window has closed,
// desk decision 32).

import { EventEmitter } from "events";
import * as fs from "fs";
import { Chat } from "./wire/chat";
import type { HostHooks } from "./wire/host";
import { chatStatus } from "./wire/reducer";
import { FileMark, findTranscript, isSessionId, markFile, readLines, readTranscript, remark, sameFile, transcriptEvents } from "./wire/transcript";
import type { WireMessage } from "./wire/types";
import type { OwnChat } from "./desk/threads";
import type { AssignBody } from "./desk/client";

/**
 * What the desk still has to hear about a chat of this window's, kept while
 * the desk is down: its assign at start (decision 10), or — for a chat
 * resumed here, or one whose item is not known — only that this panel runs
 * it ("mark"), which never moves its work item.
 */
export type DeskDue = AssignBody | "mark";

export interface ChatRecord {
  chat: Chat;
  ours: boolean;
  /** Read-only: shown from its transcript. */
  viewer: boolean;
  /** A viewer that may become ours with the next message (nothing else runs it). */
  resumable: boolean;
  itemId: string | null;
  itemTitle: string | null;
  /** The owner picked Untracked for it (decision 10): the one case the desk is told `untracked`. */
  untracked: boolean;
  /** Not yet told to the desk, which was down. */
  deskDue: DeskDue | null;
  /** Text waiting to go into the draft of the page that shows it next. */
  draft?: string | null;
  createdMs: number;
  lastMs: number;
  /** A viewer's transcript: read up to `end`; `named` when it holds a custom title; `mark` says it is still that file. */
  transcript?: { file: string; mtimeMs: number; size: number; end: number; named: boolean; mark: FileMark | null };
}

export interface ChatSettings {
  claudePath: string;
  idleMs: number;
  log: (line: string) => void;
  /** What the panel does for the CLI (decisions 61, 65). */
  hooks?: () => HostHooks;
}

/**
 * Events: `changed` (a chat's list-visible state moved), `event` (sid, wire
 * event — for webviews showing it), `snapshot` (sid — a webview must reload
 * the whole state), `turn` (sid, result, turns so far) and `suggestion`
 * (sid, the CLI's guess at the next prompt) for the assistant, `draft` (sid:
 * text waits for its draft, `rec.draft`).
 */
export class ChatManager extends EventEmitter {
  readonly records = new Map<string, ChatRecord>();
  current: string | null = null;
  /**
   * Notes a read-only thread keeps for this window's life — a refused
   * message, to copy — though its view is dropped when another thread
   * opens and rebuilt from the transcript when it opens again.
   */
  private kept = new Map<string, WireMessage[]>();

  constructor(private settings: () => ChatSettings) {
    super();
  }

  private wire(sid: string, rec: ChatRecord): void {
    rec.chat.on("event", (e: WireMessage) => {
      rec.lastMs = Date.now();
      if (e.type === "_snapshot") this.emit("snapshot", sid);
      else this.emit("event", sid, e);
    });
    rec.chat.on("status", () => this.emit("changed"));
    rec.chat.on("closed", () => this.emit("changed"));
    rec.chat.on("turn", (o: WireMessage, n: number) => this.emit("turn", sid, o, n));
    rec.chat.on("suggestion", (text: string) => this.emit("suggestion", sid, text));
    rec.chat.on("unsent", (text: string) => this.setDraft(sid, text));
  }

  /**
   * Text for the owner's draft of a chat — a held message that was not sent,
   * a start the desk refused — handed to the page showing it (`draft`), or to
   * the next one that does.
   */
  setDraft(sid: string, text: string): void {
    const rec = this.records.get(sid);
    if (!rec || !text.trim()) return;
    rec.draft = rec.draft ? `${rec.draft}\n\n${text}` : text;
    this.emit("draft", sid);
  }

  /**
   * A new chat of this window's, already assigned on the desk (decision 10);
   * its process starts with the first message. A fork's (decision 73) copies
   * another session's conversation up to a point.
   */
  create(sessionId: string, cwd: string, itemId: string | null, itemTitle: string | null, opts: { untracked?: boolean; deskDue?: DeskDue | null; fork?: { from: string; at: string } } = {}): ChatRecord {
    const s = this.settings();
    const chat = new Chat({ sessionId, cwd, claudePath: s.claudePath, existing: false, idleMs: s.idleMs, log: s.log, hooks: s.hooks, fork: opts.fork });
    const rec: ChatRecord = {
      chat,
      ours: true,
      viewer: false,
      resumable: false,
      itemId,
      itemTitle,
      untracked: !!opts.untracked,
      deskDue: opts.deskDue ?? null,
      createdMs: Date.now(),
      lastMs: Date.now(),
    };
    this.records.set(sessionId, rec);
    this.wire(sessionId, rec);
    this.emit("changed");
    return rec;
  }

  /**
   * Opens a thread this window does not run, from its transcript. `resumable`
   * when nothing runs it and it worked in this window's folder.
   */
  openViewer(sessionId: string, cwd: string | null, itemId: string | null, itemTitle: string | null, resumable: boolean): ChatRecord | null {
    if (!isSessionId(sessionId)) return null;
    const existing = this.records.get(sessionId);
    if (existing) {
      if (existing.viewer) {
        existing.resumable = resumable;
        this.reloadViewer(sessionId);
      }
      return existing;
    }
    const file = findTranscript(sessionId, cwd ?? undefined);
    const s = this.settings();
    const chat = new Chat({ sessionId, cwd: cwd ?? "", claudePath: s.claudePath, existing: true, idleMs: s.idleMs, log: s.log, hooks: s.hooks });
    const rec: ChatRecord = { chat, ours: false, viewer: true, resumable, itemId, itemTitle, untracked: false, deskDue: null, createdMs: Date.now(), lastMs: Date.now() };
    this.records.set(sessionId, rec);
    this.wire(sessionId, rec);
    if (file) this.loadTranscript(rec, file);
    else chat.preload([{ type: "_note", text: "No transcript for this session on this machine (Claude Code keeps them 30 days).", tone: "info" }, ...(this.kept.get(sessionId) ?? [])]);
    return rec;
  }

  /** A note for a thread shown read-only here, kept with it while this window lives (`kept`). */
  keepNote(sessionId: string, note: WireMessage): void {
    this.kept.set(sessionId, [...(this.kept.get(sessionId) ?? []), note].slice(-5));
    this.records.get(sessionId)?.chat.preload([note]);
  }

  private loadTranscript(rec: ChatRecord, file: string): void {
    const { events, meta, end, mtimeMs } = readTranscript(file);
    rec.transcript = { file, mtimeMs, size: meta.size, end, named: meta.named, mark: markFile(file, end) };
    if (meta.cwd && !rec.chat.opts.cwd) (rec.chat.opts as { cwd: string }).cwd = meta.cwd;
    rec.chat.state = { ...rec.chat.state, timeline: [], entries: {}, seen: {}, finalized: {}, unconfirmed: [], cwd: meta.cwd ?? rec.chat.state.cwd };
    rec.chat.preload([...events, ...(this.kept.get(rec.chat.sessionId) ?? [])]);
  }

  /**
   * A live foreign thread: what its transcript gained since it was read,
   * folded and passed on as events — not the whole file again (a busy
   * session's runs to tens of MB, and this runs every few seconds).
   */
  reloadViewer(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (!rec || !rec.viewer) return;
    const file = rec.transcript?.file ?? findTranscript(sessionId, rec.chat.opts.cwd || undefined);
    if (!file) return;
    try {
      const st = fs.statSync(file);
      const t = rec.transcript;
      if (t && st.mtimeMs === t.mtimeMs && st.size === t.size) return;
      // Read on from the offset only while it is the same file: rewritten
      // (to any size) or replaced, it is read again from the start.
      if (t && t.file === file && st.size >= t.end && sameFile(file, t.mark)) {
        const r = readLines(file, t.end);
        const { events, meta } = transcriptEvents(r.text, t.named);
        rec.transcript = { file, mtimeMs: r.mtimeMs, size: r.size, end: r.end, named: meta.named, mark: remark(file, t.mark, r.end) };
        if (events.length) rec.chat.follow(events);
        return;
      }
      this.loadTranscript(rec, file);
    } catch {
      /* gone */
    }
  }

  /** The owner wrote to a resumable thread: it becomes this window's, resumed with --resume. */
  adopt(sessionId: string): ChatRecord | null {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    if (rec.ours) return rec;
    if (!rec.resumable) return null;
    rec.ours = true;
    rec.viewer = false;
    this.emit("changed");
    return rec;
  }

  get(sessionId: string): ChatRecord | undefined {
    return this.records.get(sessionId);
  }

  /** Drops a read-only view no webview shows any more. */
  release(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (rec && rec.viewer && this.current !== sessionId) {
      rec.chat.dispose();
      this.records.delete(sessionId);
    }
  }

  /** This window's chats, for the thread list. */
  own(): OwnChat[] {
    const out: OwnChat[] = [];
    for (const [sid, r] of this.records) {
      if (!r.ours) continue;
      const st = r.chat.state;
      const p = st.pending[0];
      out.push({
        sessionId: sid,
        title: st.title,
        status: chatStatus(st),
        itemId: r.itemId,
        itemTitle: r.itemTitle,
        lastMs: r.lastMs,
        cwd: r.chat.opts.cwd,
        waitingFor: p ? (p.form === "question" ? "your answer" : p.form === "plan" ? "plan approval" : `permission: ${p.toolName}`) : null,
      });
    }
    return out;
  }

  dispose(): void {
    for (const r of this.records.values()) r.chat.dispose();
    this.records.clear();
    this.kept.clear();
  }
}
