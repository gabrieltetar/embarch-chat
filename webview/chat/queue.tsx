// Messages that wait for Claude (port item 72, after Claude Code's panel
// and CLI): one sent while Claude works waits here, above the input and not
// among the steps, until Claude takes it in — at its next step, or after
// the turn, or after the owner's answer to a card (decision 55), or after a
// compaction (36) — and then joins the timeline where Claude took it. Until
// then it can be taken back (its text returns to the draft), or sent now.

import type { ChatState } from "../../src/wire/reducer";
import { anyMovable, movable, soonMovable } from "../../src/wire/tasks";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

/**
 * Send now, as the CLI's send-now key does since 2.1.281: a step running in
 * the foreground goes to the background and Claude reads the message at
 * once. With a step that cannot move (an MCP call, say) it stops the turn,
 * and says so on the button.
 */
function sendNowLabel(s: ChatState): { label: string; title: string } {
  if (anyMovable(s) || soonMovable(s)) return { label: "Send now", title: "The running step goes on in the background, and Claude reads this now" };
  const stuck = Object.values(s.entries).some((e) => e.kind === "tool" && e.status === "running" && !e.background && !movable(e));
  return stuck
    ? { label: "Stop and send", title: "The running step cannot move to the background: it stops, and Claude reads this now" }
    : { label: "Send now", title: "Claude stops what it is writing and reads this now" };
}

export function Queued({ state, readOnly }: { state: ChatState; readOnly: boolean }) {
  const ids = (state.queue ?? []).filter((id) => state.entries[id]?.kind === "user");
  if (!ids.length) return null;
  const card = state.pending.length > 0;
  // While a card waits, its answer is the way on: no Send now (55).
  const now = !readOnly && !card && (state.capabilities ?? []).includes("interrupt_send_now_v1") ? sendNowLabel(state) : null;
  return (
    <div class="queue" aria-label="Messages waiting for Claude">
      {ids.map((id) => {
        const e = state.entries[id];
        if (e.kind !== "user") return null;
        const when = e.held ? "after the compaction" : card ? "after your answer to the card above" : "Claude reads it at its next step";
        return (
          <div key={id} class="queued">
            <div class="queued-text">
              {e.images ? <span class="muted">[{e.images} image{e.images > 1 ? "s" : ""}] </span> : null}
              {e.text}
            </div>
            <div class="queued-bar">
              <span class="muted">Queued — {when}</span>
              <span class="spacer" />
              {now && !e.held && (
                <button title={now.title} onClick={() => post({ t: "sendNow", id })}>
                  {now.label}
                </button>
              )}
              {!readOnly && (
                <button title="Take it back before Claude reads it: its text returns to the draft" onClick={() => post({ t: "cancelQueued", id })}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
