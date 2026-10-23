// What the next message costs the account: its usage limit (decision 67),
// in Claude Code's own words and by its own rule — nothing while allowed,
// a warning from 70 % used, the limit hit, and "wrapping up" while the turn
// under way finishes past it.

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
