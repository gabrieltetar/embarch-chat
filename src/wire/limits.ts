// What the next message costs the account: its usage limit (decision 67),
// in Claude Code's own words and by its own rule — nothing while allowed,
// a warning from 70 % used, the limit hit, and "wrapping up" while the turn
// under way finishes past it; and whether the prompt cache still holds the
// conversation (decision 69).

import type { CacheWindow } from "./reducer";
import type { RateLimitInfo } from "./types";

/** The limit by name, as Claude Code's panel calls each. */
const LIMIT_NAMES: Record<string, string> = {
  five_hour: "session limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  overage: "usage credit limit",
};

/** Under this much used, an `allowed_warning` shows nothing (Claude Code's 0.7). */
export const LIMIT_WARN_FROM = 0.7;

/** A reset time as "in 12m", "in 3h", "in 2d", or "soon". */
export function resetsIn(resetsAtSec: number, now = Date.now()): string {
  const min = Math.floor((resetsAtSec * 1000 - now) / 60000);
  if (min < 1) return "soon";
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `in ${h}h` : `in ${Math.floor(h / 24)}d`;
}

export interface LimitBanner {
  text: string;
  tone: "warn" | "err";
  /** Dismissed once, it stays hidden until the limit's status, kind or reset changes. */
  key: string;
}

/** The banner for the account's latest limit, or null. `busy`: a turn is running. */
export function limitBanner(i: RateLimitInfo | null, busy: boolean, now = Date.now()): LimitBanner | null {
  if (!i || i.status === "allowed") return null;
  const name = (i.rateLimitType && LIMIT_NAMES[i.rateLimitType]) || "usage limit";
  const resets = i.resetsAt ? ` · resets ${resetsIn(i.resetsAt, now)}` : "";
  const key = `${i.status}:${i.rateLimitType ?? ""}:${i.resetsAt ?? ""}`;
  if (i.rateLimitGraceActive) {
    if (busy) return { text: "Usage limit reached · wrapping up", tone: "err", key };
    if (i.resetsAt && i.resetsAt * 1000 <= now) return null;
    return { text: `Usage limit reached${i.resetsAt ? ` · ${name} resets ${resetsIn(i.resetsAt, now)}` : ""}`, tone: "err", key };
  }
  if (i.status === "rejected") return { text: `You've hit your ${name}${resets}`, tone: "err", key };
  if (i.utilization !== undefined && i.utilization < LIMIT_WARN_FROM) return null;
  const pct = i.utilization !== undefined ? Math.floor(Math.min(100, Math.round(i.utilization * 1000) / 10)) : 0;
  return { text: pct ? `You've used ${pct}% of your ${name}${resets}` : `Approaching ${name}${resets}`, tone: "warn", key };
}

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
