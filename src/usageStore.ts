// The window's newest usage reading, from any of its chats (decision 99).

import { EventEmitter } from "events";
import { Usage, usageOf } from "./usage";

/** The window's newest reading, from any of its chats. Events: `changed`. */
export class UsageStore extends EventEmitter {
  current: Usage | null = null;

  /** A chat's CLI sent a `rate_limit_event`. */
  take(info: unknown): void {
    const u = usageOf(info);
    if (!u) return;
    this.current = u;
    this.emit("changed");
  }
}
