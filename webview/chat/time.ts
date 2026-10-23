// Time on screen (decision 68), as text: a message's time to the second
// with a date line where the day changes, how long a step has run or took,
// and when a turn has gone quiet for too long — no line from the CLI for a
// minute while no tool runs: a stuck CLI, not a long flash.

import type { ChatState, Entry } from "../../src/wire/reducer";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A message's time, 24-hour to the second, as a serial log or a trace has it. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The whole time, to the millisecond, for the hover. */
export function fullTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockTime(ms)}.${pad(d.getMilliseconds(), 3)}`;
}

/** The local day a time falls on. */
export const dayKey = (ms: number): string => fullTime(ms).slice(0, 10);

/** A date line, as Claude Code's panel writes it: "Thu, Oct 23", the year only when it is not this one. */
export function dayLine(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }) });
}

/** How long, as "8s", "3m 04s", "1h 02m". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** A finished step shows how long it took from this long: a build, a flash, a study; a Read does not. */
export const SHOW_TOOK_FROM = 10_000;

/** No line from the CLI this long, and no tool running: "Not responding" (Claude Code's 60 s). */
export const NOT_RESPONDING_MS = 60_000;

/** A tool of the turn under way that runs: a step started since the owner's last message, or under it, nested. */
function toolRunning(s: ChatState): boolean {
  const running = (e: Entry | undefined, depth = 0): boolean => {
    if (!e || e.kind !== "tool" || depth > 32) return false;
    if (e.status === "running" && !e.background) return true;
    return e.children.some((c) => running(s.entries[c], depth + 1));
  };
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    const e = s.entries[s.timeline[i]];
    if (e?.kind === "user") break;
    if (running(e)) return true;
  }
  return false;
}

/** The turn has gone quiet: running, nothing waits on the owner, no tool runs, and the CLI has written nothing for a minute. */
export function stalled(s: ChatState, now = Date.now()): boolean {
  if (!s.busy || s.compacting || s.pending.length || s.lastLineAt === null) return false;
  if (s.process !== "running" && s.process !== "starting") return false;
  return now - s.lastLineAt >= NOT_RESPONDING_MS && !toolRunning(s);
}
