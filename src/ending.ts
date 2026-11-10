// An issue's status ends its chat (decision 104). The desk posts an `end`
// (Done or Canceled, every check passed) or an `unfinished` (a check failed:
// each blocker, and a Finish button) to the window of the issue's folder; this
// holds what each issue's chat shows, across a reload.
//
// An `end` waits for the turn that is running: the message and the closed
// input come when no chat of the issue is mid-turn. It is final — a later
// `end` or `unfinished` changes nothing, so a chat never resumes after it.
// An `unfinished` replaces an older one or an `end` still waiting.

import { EventEmitter } from "events";
import type { MailboxEntry } from "./desk/client";

export interface Blocker {
  repo: string;
  reason: string;
}

/** What an issue's chat shows on top: it ended (`message` is the exact line), or it is unfinished and live. */
export type ChatEnding = { kind: "ended"; outcome: "done" | "canceled"; message: string } | { kind: "unfinished"; blockers: Blocker[] };

export const ENDING_KEY = "embarchChat.endings";

/** The two kinds of mailbox entry the desk writes for this (embarch-desk decision 46); the others start or focus a chat. */
export const isEndingEntry = (m: MailboxEntry): boolean => m.kind === "end" || m.kind === "unfinished";

export const endedMessage = (outcome: "done" | "canceled"): string => `Chat has ended because the issue is ${outcome}`;

/** The entry as the chat shows it, or null for one that does not say what it must. */
export function endingOf(m: MailboxEntry): ChatEnding | null {
  if (m.kind === "end") {
    const o = (m as { outcome?: unknown }).outcome;
    return o === "done" || o === "canceled" ? { kind: "ended", outcome: o, message: endedMessage(o) } : null;
  }
  if (m.kind === "unfinished") {
    const b = (m as { blockers?: unknown }).blockers;
    if (!Array.isArray(b)) return null;
    const blockers = b
      .filter((x): x is Blocker => !!x && typeof (x as Blocker).repo === "string" && typeof (x as Blocker).reason === "string")
      .map((x) => ({ repo: x.repo, reason: x.reason }));
    return { kind: "unfinished", blockers };
  }
  return null;
}

/** The slice of VS Code's Memento this reads and writes. */
export interface Remember {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Events: `changed` (itemId — what an issue's chat shows moved). `idle`
 * answers whether no chat of an issue is mid-turn; asked on each `end` and
 * again by `settle`, which the window calls when a turn ends.
 */
export class Endings extends EventEmitter {
  private shown: Record<string, ChatEnding>;
  /** An `end` that waits for a turn to finish. */
  private held = new Map<string, ChatEnding>();

  constructor(
    private memory: Remember,
    private idle: (itemId: string) => boolean,
  ) {
    super();
    this.shown = { ...(memory.get<Record<string, ChatEnding>>(ENDING_KEY) ?? {}) };
  }

  /** What the issue's chat shows now, or null. */
  get(itemId: string | null | undefined): ChatEnding | null {
    return (itemId && this.shown[itemId]) || null;
  }

  /** Whether the issue's chat has ended: no input, no resume. */
  ended(itemId: string | null | undefined): boolean {
    return this.get(itemId)?.kind === "ended";
  }

  /** The issue has an `end` that waits for its turn. */
  waiting(itemId: string): boolean {
    return this.held.has(itemId);
  }

  /** A taken entry. True when it moved what an issue shows now. */
  receive(m: MailboxEntry): boolean {
    const itemId = typeof m.item_id === "string" ? m.item_id : "";
    const e = endingOf(m);
    if (!itemId || !e) return false;
    // Ended is final, shown or waiting.
    if (this.ended(itemId)) return false;
    if (e.kind === "unfinished") {
      this.held.delete(itemId);
      return this.show(itemId, e);
    }
    if (this.held.has(itemId)) return false;
    if (!this.idle(itemId)) {
      this.held.set(itemId, e);
      return false;
    }
    return this.show(itemId, e);
  }

  /** A turn ended: the `end`s that waited for it come now. */
  settle(): void {
    for (const [itemId, e] of [...this.held]) {
      if (!this.idle(itemId)) continue;
      this.held.delete(itemId);
      this.show(itemId, e);
    }
  }

  private show(itemId: string, e: ChatEnding): boolean {
    const was = this.shown[itemId];
    if (was && JSON.stringify(was) === JSON.stringify(e)) return false;
    this.shown = { ...this.shown, [itemId]: e };
    void this.memory.update(ENDING_KEY, this.shown);
    this.emit("changed", itemId);
    return true;
  }
}
