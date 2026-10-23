// The account's usage limit as a banner above the status line (decision
// 67): the percent used and when it resets, from 70 %; the limit hit; and
// "wrapping up" while the turn under way finishes past it. × hides it until
// the limit changes. A turn that hits the limit mid-flash leaves the board
// in an unknown state: the banner shows it before a long one starts.

import { useEffect, useState } from "preact/hooks";
import type { RateLimitInfo } from "../../src/wire/types";
import { limitBanner } from "../../src/wire/limits";

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

/** Banners the owner closed, by limit, for the page's life. */
const dismissed = new Set<string>();

export function LimitBannerView({ info, busy }: { info: RateLimitInfo | null; busy: boolean }) {
  const now = useNow(30_000, !!info && info.status !== "allowed");
  const [, redraw] = useState(0);
  const b = limitBanner(info, busy, now);
  if (!b || dismissed.has(b.key)) return null;
  return (
    <div class={`limit-banner ${b.tone}`} role="status">
      <span>{b.text}</span>
      <button
        class="icon"
        title="Hide until the limit changes"
        onClick={() => {
          dismissed.add(b.key);
          redraw((n) => n + 1);
        }}
      >
        ×
      </button>
    </div>
  );
}
