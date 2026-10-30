// The window's newest usage reading, from any of its chats (decision 99),
// merged window by window (review F15).

import { EventEmitter } from "events";
import { Usage, mergeUsage, usageOf } from "./usage";

/** The window's newest reading, from any of its chats, each window as last heard. Events: `changed`. */
export class UsageStore extends EventEmitter {
  current: Usage | null = null;

  /** A chat's CLI sent a `rate_limit_event`: what it carries replaces what was kept; a window it leaves out stays. */
  take(info: unknown): void {
    const u = usageOf(info);
    if (!u) return;
    this.current = mergeUsage(this.current, u);
    this.emit("changed");
  }
}
