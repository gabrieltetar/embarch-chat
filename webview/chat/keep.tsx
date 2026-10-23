// Keep a reply on the work item: Claude Code's bookmarks (its changelog
// L180), the desk's way. A reply goes to the chat's work item as a note of
// kind finding or decision, through the desk's line route — the item is
// where knowledge gathers (decision 40), and the panel keeps no store of its
// own (12). A chat with no item yet has it held until it gets one. Keep
// is per text block: on a finished turn's last block it sits in the row of
// that turn's Copy (74), muted as Copy is; on an earlier block it shows
// under the pointer, at the block's top right. What became of it stays.

import { useEffect, useState } from "preact/hooks";
import type { HostToChat, KeepKind } from "../shared/protocol";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

type Kept = { kind: KeepKind; pending?: boolean; held?: boolean; error?: string };

/** What became of each reply kept from this page, by entry id: a redraw or another chat and back keeps it. */
const kept = new Map<string, Kept>();

/** `inRow`: in the turn's Copy row (history.tsx), inline; else over the block's top right, under the pointer. */
export function KeepReply({ id, inRow = false }: { id: string; inRow?: boolean }) {
  const [, redraw] = useState(0);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    const on = (ev: MessageEvent<HostToChat>) => {
      const m = ev.data;
      if (m.t !== "kept" || m.entryId !== id) return;
      kept.set(id, { kind: m.kind, ...(m.held ? { held: true } : {}), ...(m.error ? { error: m.error } : {}) });
      redraw((n) => n + 1);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [id]);
  const keep = (kind: KeepKind) => {
    kept.set(id, { kind, pending: true });
    setChoosing(false);
    post({ t: "keep", entryId: id, kind });
  };
  const k = kept.get(id);
  // In the row its lines sit inline; else each its own line under the block.
  const Line = inRow ? "span" : "div";
  if (k && !k.error) {
    return <Line class="kept-line">{k.pending ? "Keeping…" : k.held ? `Kept as a ${k.kind} — it lands on the work item once this chat has one` : `✓ Kept on the work item as a ${k.kind}`}</Line>;
  }
  return (
    <>
      {k?.error && <Line class="kept-line err">Not kept: {k.error}</Line>}
      <Line class={`keep ${inRow ? "in-row" : ""} ${choosing ? "open" : ""}`}>
        {choosing ? (
          <>
            <span>Keep as a</span>
            <button class="secondary" onClick={() => keep("finding")}>
              finding
            </button>
            <button class="secondary" onClick={() => keep("decision")}>
              decision
            </button>
            <button class="icon" title="Cancel" onClick={() => setChoosing(false)}>
              ×
            </button>
          </>
        ) : (
          <button class={`icon ${inRow ? "reply-copy" : ""}`} title="Keep this block of the reply on the work item, as a finding or a decision" onClick={() => setChoosing(true)}>
            Keep
          </button>
        )}
      </Line>
    </>
  );
}
