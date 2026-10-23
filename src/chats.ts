// The chats this window has open: its own (each with a `claude` process
// while in use, decision 5) and read-only views of threads it does not run
// (decision 31). A chat belongs to the window that started it; one this
// window opens from a transcript becomes its own only when the owner sends a
// message to it here, which resumes it (a chat whose window has closed,
// desk decision 32).

import { EventEmitter } from "events";
import * as fs from "fs";
import { Chat } from "./wire/chat";
import { chatStatus } from "./wire/reducer";
import { findTranscript, readTranscript } from "./wire/transcript";
import type { WireMessage } from "./wire/types";
import type { OwnChat } from "./desk/threads";

export interface ChatRecord {
  chat: Chat;
  ours: boolean;
  /** Read-only: shown from its transcript. */
  viewer: boolean;
  /** A viewer that may become ours with the next message (nothing else runs it). */
  resumable: boolean;
  itemId: string | null;
  itemTitle: string | null;
  createdMs: number;
  lastMs: number;
  transcript?: { file: string; mtimeMs: number; size: number };
}

export interface ChatSettings {
  claudePath: string;
  idleMs: number;
  log: (line: string) => void;
}

/**
 * Events: `changed` (a chat's list-visible state moved), `event` (sid, wire
 * event — for webviews showing it), `snapshot` (sid — a webview must reload
 * the whole state).
 */
export class ChatManager extends EventEmitter {
  readonly records = new Map<string, ChatRecord>();
  current: string | null = null;

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
  }

  /** A new chat of this window's, already assigned on the desk (decision 10); its process starts with the first message. */
  create(sessionId: string, cwd: string, itemId: string | null, itemTitle: string | null): ChatRecord {
    const s = this.settings();
    const chat = new Chat({ sessionId, cwd, claudePath: s.claudePath, existing: false, idleMs: s.idleMs, log: s.log });
    const rec: ChatRecord = { chat, ours: true, viewer: false, resumable: false, itemId, itemTitle, createdMs: Date.now(), lastMs: Date.now() };
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
    const chat = new Chat({ sessionId, cwd: cwd ?? "", claudePath: s.claudePath, existing: true, idleMs: s.idleMs, log: s.log });
    const rec: ChatRecord = { chat, ours: false, viewer: true, resumable, itemId, itemTitle, createdMs: Date.now(), lastMs: Date.now() };
    this.records.set(sessionId, rec);
    this.wire(sessionId, rec);
    if (file) this.loadTranscript(rec, file);
    else chat.preload([{ type: "_note", text: "No transcript for this session on this machine (Claude Code keeps them 30 days).", tone: "info" }]);
    return rec;
  }

  private loadTranscript(rec: ChatRecord, file: string): void {
    const { events, meta } = readTranscript(file);
    const st = fs.statSync(file);
    rec.transcript = { file, mtimeMs: st.mtimeMs, size: st.size };
    if (meta.cwd && !rec.chat.opts.cwd) (rec.chat.opts as { cwd: string }).cwd = meta.cwd;
    rec.chat.state = { ...rec.chat.state, timeline: [], entries: {}, seen: {}, finalized: {}, cwd: meta.cwd ?? rec.chat.state.cwd };
    rec.chat.preload(events);
  }

  /** A live foreign thread: re-read its transcript when it grew. */
  reloadViewer(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (!rec || !rec.viewer) return;
    const file = rec.transcript?.file ?? findTranscript(sessionId, rec.chat.opts.cwd || undefined);
    if (!file) return;
    try {
      const st = fs.statSync(file);
      if (rec.transcript && st.mtimeMs === rec.transcript.mtimeMs && st.size === rec.transcript.size) return;
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
  }
}
