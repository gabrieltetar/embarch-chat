// A chat that hits the Claude plan's usage limit mid-turn waits for the
// limit's reset, then sends the owner's message ("continue"), as he would
// on coming back (decision 109). Per chat, from the rail's Limits menu:
// after the 5-hour limit on by default, after the weekly limit off; and the
// handoff's switch (103): on, an agent's handoff starts the fresh session at
// once; off, it shows the card. Pure, for the host and the page alike;
// wire/chat.ts keeps the wait and its timer.
//
// What a hit looks like [measured 2026-11-16 from a transcript of 2.1.322]:
// the CLI makes up the turn's reply, an assistant line from `<synthetic>`
// with `error: "rate_limit"`, `apiError: "usage_limit_reached"` and the text
// "You've hit your 5-hour limit · resets 11:30pm (Europe/Lisbon)". The
// `rate_limit_event` the stream carries with it is the one usage.ts reads
// for the icon (99): `status: "rejected"`, the limit it names
// (`rateLimitType`) and when it resets (`resetsAt`). Neither has been seen
// over the panel's own wire yet: the text and the event are each enough.

export interface LimitPrefs {
  /** Continue after the 5-hour session limit resets. */
  session: boolean;
  /** Continue after a weekly limit resets, all models' or one model's. */
  weekly: boolean;
  /** What goes at the reset. */
  text: string;
  /** An agent's handoff (103) starts the fresh session at once; off, it asks on a card. */
  handoff: boolean;
}

export type LimitWindow = "session" | "weekly";

/** A limit hit this chat waits on. */
export interface LimitWait {
  /** The limit as the CLI names it (`five_hour`, `seven_day` …), or null when only its words said. */
  limit: string | null;
  window: LimitWindow;
  /** When it resets, seconds since the epoch; null when nothing said. */
  resetsAt: number | null;
  /** When the turn ended on it (ms). */
  hitAt: number;
  /** The message goes at the reset: the window's switch is on and the continues have not stopped. */
  armed: boolean;
  /** Continued after a reset and still turned back with no step run, twice: it waits no more. */
  stopped?: boolean;
}

export const DEFAULT_CONTINUE_TEXT = "continue";
export const DEFAULT_LIMIT_PREFS: LimitPrefs = { session: true, weekly: false, text: DEFAULT_CONTINUE_TEXT, handoff: false };

/** After the reset, before the message goes: the server's clock and this machine's may disagree by this much. */
export const RESET_SLACK_MS = 60_000;
/** How often an armed wait looks at the clock: a machine asleep at the reset sends once it wakes. */
export const WAIT_TICK_MS = 60_000;
/** Continues in a row whose turn the limit still turned back before any step ran: then it stops. */
export const MAX_FRUITLESS = 2;

/** The CLI's own openings for a limit's made-up reply (its "You've hit your" list). */
const LIMIT_TEXT = /^You've (hit|reached) your\b/;

/** The text of an assistant line, its text blocks joined. */
function textOf(o: { message?: unknown }): string {
  const content = (o.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => !!b && (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("\n");
}

/** The CLI's made-up reply for a usage limit hit: its text, else null. */
export function limitReply(o: { type?: unknown; error?: unknown; apiError?: unknown; message?: unknown }): string | null {
  if (o.type !== "assistant") return null;
  const text = textOf(o).trim();
  if (o.apiError === "usage_limit_reached" || LIMIT_TEXT.test(text)) return text;
  // `error: "rate_limit"` alone is also a plain 429, which the CLI retries itself: only with the limit's words.
  return o.error === "rate_limit" && /\blimit\b.*\bresets\b/i.test(text) ? text : null;
}

/** Which switch a limit falls under: the 5-hour session's, or the week's (all models', or one model's). */
export function limitWindow(limit: string | null | undefined, text = ""): LimitWindow | null {
  if (limit === "five_hour") return "session";
  if (limit === "seven_day" || limit === "seven_day_opus" || limit === "seven_day_sonnet" || limit === "seven_day_overage_included") return "weekly";
  if (limit) return null;
  if (/\b5-hour\b|\bsession limit\b/i.test(text)) return "session";
  if (/\bweekly\b|\bweek\b/i.test(text)) return "weekly";
  return null;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The reset the CLI's words name — "resets 11:30pm", "resets Wed 6am",
 * "resets Nov 18, 6am", with "(Europe/Lisbon)" after it — as seconds since
 * the epoch, on this machine's clock; null when it names a zone other than
 * this machine's, or nothing to read. For when no `rate_limit_event` said.
 */
export function resetOfText(text: string, now = Date.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone): number | null {
  const m = /\bresets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(?:(\d{1,2}),?\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m) return null;
  const [, word, date, hh, mm, ampm, tz] = m;
  if (tz && tz.trim() !== zone) return null;
  const hour = (Number(hh) % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(hour, Number(mm ?? 0));
  const w = word?.toLowerCase();
  if (w && date && MONTHS.includes(w)) {
    at.setMonth(MONTHS.indexOf(w), Number(date));
    if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1);
  } else if (w && DAYS.includes(w)) {
    let ahead = (DAYS.indexOf(w) - at.getDay() + 7) % 7;
    if (ahead === 0 && at.getTime() <= now) ahead = 7;
    at.setDate(at.getDate() + ahead);
  } else if (w) {
    return null;
  } else if (at.getTime() <= now) {
    at.setDate(at.getDate() + 1);
  }
  return Math.floor(at.getTime() / 1000);
}

/** A `rate_limit_event`'s info, as a hit reads it. */
export interface RateLimitInfo {
  status: string;
  limit: string | null;
  resetsAt: number | null;
}

export function rateLimitOf(info: unknown): RateLimitInfo | null {
  if (!info || typeof info !== "object") return null;
  const i = info as Record<string, unknown>;
  if (typeof i.status !== "string") return null;
  return {
    status: i.status,
    limit: typeof i.rateLimitType === "string" ? i.rateLimitType : null,
    resetsAt: typeof i.resetsAt === "number" && Number.isFinite(i.resetsAt) ? i.resetsAt : null,
  };
}

/**
 * The limit a turn ended on, from its made-up reply and the newest
 * `rate_limit_event` of the chat's process: the event's limit and reset
 * when it says the limit is hit, else what the reply's words say. Null when
 * neither says which limit (an overage or credit limit: nothing resets).
 */
export function limitHitOf(reply: string, event: RateLimitInfo | null, now = Date.now()): Omit<LimitWait, "armed"> | null {
  const rejected = event && event.status === "rejected" ? event : null;
  const limit = rejected?.limit ?? null;
  const window = limitWindow(limit, reply);
  if (!window) return null;
  return { limit, window, resetsAt: rejected?.resetsAt ?? resetOfText(reply, now), hitAt: now };
}

/** The menu's word for a limit. */
export function limitName(w: Pick<LimitWait, "window" | "limit">): string {
  if (w.limit === "seven_day_opus") return "weekly Opus limit";
  if (w.limit === "seven_day_sonnet") return "weekly Sonnet limit";
  return w.window === "session" ? "5-hour limit" : "weekly limit";
}

/** When an armed wait sends (ms): its reset and the slack; null when the reset is not known. */
export function sendAt(w: LimitWait, slackMs = RESET_SLACK_MS): number | null {
  return w.resetsAt === null ? null : w.resetsAt * 1000 + slackMs;
}

/** The menu's text, trimmed; empty is the default. */
export function continueText(text: unknown): string {
  return typeof text === "string" && text.trim() ? text.trim() : DEFAULT_CONTINUE_TEXT;
}
