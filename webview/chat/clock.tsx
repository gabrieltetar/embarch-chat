// Time on screen (decision 68): the time above a message, with a date line
// where the day changes; how long a step has run, counting, or took.

import { useEffect, useState } from "preact/hooks";
import { SHOW_TOOK_FROM, clockTime, dayLine, elapsedText, fullTime } from "./time";

/** The time now, the component drawn again every `ms` while `on`. */
export function useNow(ms: number, on = true): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return Date.now();
}

/** A message's time — the owner's at the right, over the bubble — and a date line first when the day changed. */
export function Stamp({ at, mine, day }: { at: number; mine: boolean; day: boolean }) {
  return (
    <>
      {day && <div class="day-line">{dayLine(at)}</div>}
      <time class={`stamp${mine ? " mine" : ""}`} dateTime={new Date(at).toISOString()} title={fullTime(at)}>
        {clockTime(at)}
      </time>
    </>
  );
}

/**
 * How long a step has run, counting each second while `live`; once done,
 * how long it took — when that was long enough to matter, or `always`.
 */
export function Elapsed({ from, to, live, always = false }: { from?: number; to?: number; live: boolean; always?: boolean }) {
  const counting = from !== undefined && to === undefined && live;
  const now = useNow(1000, counting);
  if (from === undefined) return null;
  if (counting) return <span class="elapsed" title="Running for">{elapsedText(now - from)}</span>;
  if (to === undefined || (!always && to - from < SHOW_TOOK_FROM) || to < from) return null;
  return (
    <span class="elapsed" title="Took">
      {elapsedText(to - from)}
    </span>
  );
}
