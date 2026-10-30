// Whether the prompt cache still holds the conversation (decision 69). The
// account's usage limit it also turned into a banner (decision 67) is the
// rail's Usage icon now (99, src/usage.ts).

import type { CacheWindow } from "./reducer";

/** Idle time as Claude Code's cache clock writes it: "4m", "1h 5m", "2d 3h". */
export function idleText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface CacheClock {
  kind: "warm" | "cold" | "compacted";
  /** Claude Code's words for it. */
  text: string;
  /** The longer reading, for the hover. */
  detail: string;
}

/**
 * Whether a message now would read the conversation from the prompt cache,
 * by Claude Code's rule: warm for the reply's cache lifetime (an hour or
 * five minutes) after it, likely expired after that, and not covering a
 * conversation compacted since. Null until a reply says.
 */
export function cacheClock(c: CacheWindow | null, now = Date.now()): CacheClock | null {
  if (!c) return null;
  if (c.compactedAt !== undefined) {
    return { kind: "compacted", text: "Prompt cache does not cover the compacted conversation", detail: "The conversation was compacted, so your next message will re-cache it." };
  }
  if (c.ttl === null) return null;
  const left = Math.min(c.ttl, c.at + c.ttl - now);
  const life = c.ttl >= 3_600_000 ? "an hour" : "five minutes";
  if (left > 0) {
    return { kind: "warm", text: `Prompt cache warm, about ${Math.ceil(left / 60000)} min left`, detail: `Claude's last reply cached the conversation for ${life}; a message before then reads it from the cache.` };
  }
  const idle = idleText(now - c.at);
  return { kind: "cold", text: `Prompt cache likely expired (idle ${idle})`, detail: `Idle ${idle}. The prompt cache has likely expired, so your next message will re-cache the conversation.` };
}
