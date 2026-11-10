// The Memory menu's periodic pass (decision 98): a stamp file whose first
// line is the `YYYY-MM-DD` of the last pass, an interval in days and a
// command to send. All three are machine settings; nothing here names a
// pass, so with them unset the menu shows nothing and the icon no marker.

export interface MemoryPassConfig {
  stampPath: string;
  intervalDays: number;
  command: string;
}

/** What the page draws: the last pass's date (null: none recorded) and whether the interval has passed. */
export interface MemoryPass {
  /** `YYYY-MM-DD`, or null when the stamp file is missing or its first line is no date. */
  last: string | null;
  /** Whole days since `last`; null with no date. */
  days: number | null;
  due: boolean;
}

/** The three settings as one config; null unless all are set (an interval of at least one day). */
export function memoryPassConfig(stampPath: unknown, intervalDays: unknown, command: unknown): MemoryPassConfig | null {
  const p = typeof stampPath === "string" ? stampPath.trim() : "";
  const c = typeof command === "string" ? command.trim() : "";
  const n = typeof intervalDays === "number" && Number.isFinite(intervalDays) ? Math.floor(intervalDays) : 0;
  return p && c && n >= 1 ? { stampPath: p, intervalDays: n, command: c } : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Today's calendar date in the machine's time zone, as the stamp writes it. */
export const localDate = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

/**
 * The state from the stamp file's text (null: unreadable). A stamp with no
 * date on its first line counts as no pass recorded, which is due.
 */
export function memoryPassState(stamp: string | null, intervalDays: number, today = localDate()): MemoryPass {
  const m = stamp === null ? null : /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(stamp.split(/\r?\n/, 1)[0]);
  if (!m) return { last: null, days: null, due: true };
  const last = `${m[1]}-${m[2]}-${m[3]}`;
  const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;
  const days = Math.round(day(today) - day(last));
  return { last, days, due: days >= intervalDays };
}
