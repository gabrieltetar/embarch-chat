// A long chat stays fast (decision 85): a hardware session leaves hundreds
// of rows, and every streamed delta renders the page again. A turn, and
// within it a row, whose entries and context are the same objects as last
// time is not drawn again — the reducer replaces an entry whenever it
// changes and never edits one, so sameness is the identity of what is
// read. Every row stays in the page, so the webview's Ctrl+F finds it.

import { memo } from "preact/compat";
import type { ComponentChildren } from "preact";
import type { Entry } from "../../src/wire/reducer";
import type { Fold } from "./runs";

interface Props {
  /** Everything it reads: it is drawn again when any of them is a different object. */
  deps: readonly unknown[];
  render: () => ComponentChildren;
}

function SettledInner({ render }: Props) {
  return <>{render()}</>;
}

/** Draws `render()` again only when one of `deps` changed. */
export const Settled = memo(SettledInner, (a: Props, b: Props) => a.deps.length === b.deps.length && a.deps.every((d, i) => d === b.deps[i]));

/** A turn's rows: the owner's message and what came after it (decision 51). */
export interface Turn {
  /** Its first row's. */
  key: string;
  rows: Fold[];
  /** The entries its rows draw, and each tool's steps two deep, as ToolView's memo follows them. */
  deps: unknown[];
}

/**
 * The timeline's rows in turns, for drawing a turn again only when one of
 * its entries changed: the one running, an old one when a late result or a
 * background task lands in it.
 */
export function turns(rows: readonly Fold[], get: (id: string) => Entry | undefined, entries: Record<string, Entry>): Turn[] {
  const out: Turn[] = [];
  for (const r of rows) {
    if (!out.length || (!r.run && get(r.ids[0])?.kind === "user")) out.push({ key: r.key, rows: [], deps: [] });
    const t = out[out.length - 1];
    t.rows.push(r);
    for (const id of r.ids) {
      const e = get(id);
      t.deps.push(e);
      if (e?.kind !== "tool") continue;
      for (const c of e.children) {
        const s = entries[c];
        t.deps.push(s);
        if (s?.kind === "tool") for (const g of s.children) t.deps.push(entries[g]);
      }
    }
  }
  return out;
}
