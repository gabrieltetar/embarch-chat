// The Claude plan's usage, for the rail's Usage icon (decision 99): the
// 5-hour session's and the week's share used, with their reset times, from
// the one place the chat hears it — the `rate_limit_event` a chat's CLI
// sends on a turn when the account's limit changes, and on a process's first
// turn at least (what decision 67's banner read; it is retired for this
// icon). Claude Code 2.1.287 carries both windows there, as `unifiedWindows.five_hour` and `.seven_day`
// (`{utilization 0..1, resetsAt}`, an `@internal` field) [measured
// 2026-10-30 from its bundle; the recorded sessions carry it]. The reading is
// the account's, so the window keeps the newest any of its chats heard, each
// window as last heard, with its own age (usageStore.ts, review F15). Pure,
// for the host and the page alike.

/** A reset time as "in 12m", "in 3h", "in 2d", or "soon". */
export function resetsIn(resetsAtSec: number, now = Date.now()): string {
  const min = Math.floor((resetsAtSec * 1000 - now) / 60000);
  if (min < 1) return "soon";
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `in ${h}h` : `in ${Math.floor(h / 24)}d`;
}

/** One window: the share used, 0..1, when it resets (seconds since the epoch), when said, and when it was heard (ms). */
export interface UsageWindow {
  used: number;
  resetsAt: number | null;
  at: number;
}

/**
 * The per-model weekly limits: a line each on the card, never the Weekly
 * window and never the icon's colour (review F16). Only the event's own
 * share says them: `unifiedWindows` carries none [measured 2026-10-30 from
 * Claude Code 2.1.287's bundle].
 */
export const MODEL_LIMITS = ["seven_day_opus", "seven_day_sonnet"] as const;
export type ModelLimit = (typeof MODEL_LIMITS)[number];
export const isModelLimit = (l: string | null | undefined): l is ModelLimit => !!l && (MODEL_LIMITS as readonly string[]).includes(l);

export interface Usage {
  /** The 5-hour session window. */
  session: UsageWindow | null;
  /** The weekly window, all models. */
  weekly: UsageWindow | null;
  /** A per-model weekly limit's share, when an event named it. */
  models: Partial<Record<ModelLimit, UsageWindow>>;
  /** `allowed`, `allowed_warning` or `rejected`, as the CLI says. */
  status: string;
  /** The limit the event names, when it names one (`five_hour`, `seven_day`, `seven_day_opus` …). */
  limit: string | null;
  /** When that limit resets (seconds since the epoch), when said: a limit hit holds until then (review F14). */
  resetsAt: number | null;
  /** The limit is reached and a turn under way is finishing past it. */
  grace: boolean;
  /** When this window heard the newest event (ms); each window keeps its own `at`. */
  at: number;
}

/** From 70 % used the icon is amber (where Claude Code starts to warn, 0.7), from 90 % red. */
export const USAGE_AMBER = 0.7;
export const USAGE_RED = 0.9;

/** A limit by name, as Claude Code's panel calls each. */
export const LIMIT_NAMES: Record<string, string> = {
  five_hour: "session limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  seven_day_overage_included: "weekly limit",
  overage: "usage credit limit",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function windowOf(v: unknown, at: number): UsageWindow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const used = num(o.utilization);
  if (used === null) return null;
  return { used: Math.max(0, Math.min(1, used)), resetsAt: num(o.resetsAt), at };
}

/** A `rate_limit_event`'s `rate_limit_info` as the icon reads it, or null when it is not one. */
export function usageOf(info: unknown, now = Date.now()): Usage | null {
  if (!info || typeof info !== "object") return null;
  const i = info as Record<string, unknown>;
  if (typeof i.status !== "string") return null;
  const w = (i.unifiedWindows && typeof i.unifiedWindows === "object" ? i.unifiedWindows : {}) as Record<string, unknown>;
  let session = windowOf(w.five_hour, now);
  let weekly = windowOf(w.seven_day, now) ?? windowOf(w.seven_day_overage_included, now);
  // Without the windows, the one limit the event names still says its own share.
  const limit = typeof i.rateLimitType === "string" ? i.rateLimitType : null;
  const own = num(i.utilization);
  const models: Usage["models"] = {};
  if (own !== null) {
    const one = { used: Math.max(0, Math.min(1, own)), resetsAt: num(i.resetsAt), at: now };
    if (limit === "five_hour" && !session) session = one;
    // The week of every model; a per-model limit is a line of its own (review F16).
    if ((limit === "seven_day" || limit === "seven_day_overage_included") && !weekly) weekly = one;
    if (isModelLimit(limit)) models[limit] = one;
  }
  return { session, weekly, models, status: i.status, limit, resetsAt: num(i.resetsAt), grace: i.rateLimitGraceActive === true, at: now };
}

/**
 * A newer reading over the one kept: the event's status and limit, and each
 * window it carries; a window it leaves out stays as last heard, with its
 * own age (review F15).
 */
export function mergeUsage(prev: Usage | null, next: Usage): Usage {
  if (!prev) return next;
  return { ...next, session: next.session ?? prev.session, weekly: next.weekly ?? prev.weekly, models: { ...prev.models, ...next.models } };
}

/** Past `resetsAt` (seconds), at `now` (ms): what was read before it no longer holds. */
const past = (resetsAt: number | null, now: number) => resetsAt !== null && resetsAt * 1000 <= now;

/**
 * A window past its reset counts as reset (review F14): its reading no longer
 * holds, so it shows as reset, grey, and lights nothing — as decision 67's
 * banner expired at its reset.
 */
export function expired(w: UsageWindow | null, now = Date.now()): boolean {
  return !!w && past(w.resetsAt, now);
}

/** The limit the event names is hit, or a turn finishes past it, and it has not reset since. */
export function limitHit(u: Usage, now = Date.now()): boolean {
  return (u.status === "rejected" || u.grace) && !past(u.resetsAt, now);
}

/** A limit hit that turns the icon red: the session's or the week's, never a per-model one (review F16). */
export function iconHit(u: Usage, now = Date.now()): boolean {
  return limitHit(u, now) && !isModelLimit(u.limit);
}

/**
 * How the icon shows: no reading, fine, amber from 70 %, red from 90 % or
 * when a limit is hit. A window past its reset counts for nothing; with
 * none left, the icon is grey again, as before a reading (P17, review F14).
 */
export function usageLevel(u: Usage | null, now = Date.now()): "none" | "ok" | "amber" | "red" {
  if (!u) return "none";
  if (iconHit(u, now)) return "red";
  const live = [u.session, u.weekly].filter((w): w is UsageWindow => !!w && !expired(w, now));
  if (!live.length) return "none";
  const top = Math.max(...live.map((w) => w.used));
  if (top >= USAGE_RED) return "red";
  if (top >= USAGE_AMBER) return "amber";
  return "ok";
}

/** When the reading next shows differently by itself (ms): the first reset still ahead, or null. */
export function nextReset(u: Usage | null, now = Date.now()): number | null {
  if (!u) return null;
  const at = [u.session?.resetsAt, u.weekly?.resetsAt, iconHit(u, now) ? u.resetsAt : null]
    .filter((x): x is number => typeof x === "number" && x * 1000 > now)
    .map((x) => x * 1000);
  return at.length ? Math.min(...at) : null;
}
