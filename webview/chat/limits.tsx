// The rail's Limits menu (decision 109): what this chat does when the
// Claude plan's usage limit cuts a turn off — continue on its own once the
// 5-hour limit resets (on by default), once a weekly limit resets (off by
// default), and the message it sends — and the handoff's switch (103): on,
// an agent's handoff starts the fresh session at once; off, it asks on a
// card. Below them, the limit the chat waits on, when it sends, and Cancel.
// The icon lights while a continue is armed.

import { useEffect, useState } from "preact/hooks";
import type { ChatState } from "../../src/wire/reducer";
import { DEFAULT_CONTINUE_TEXT, DEFAULT_LIMIT_PREFS, LimitPrefs, LimitWait, RESET_SLACK_MS, limitName, sendAt } from "../../src/afterLimit";
import { resetsIn } from "../../src/usage";
import { vscodeApi } from "../shared/vscode";
import { useNow } from "./clock";
import { RailPop } from "./rail";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** A clock time, with the day when it is more than a day from now. */
function clock(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return Math.abs(ms - now) > 86_400_000 ? `${d.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
}

/** What the wait says, in a line: the limit, and when the message goes or why it will not. */
export function waitLine(w: LimitWait, prefs: LimitPrefs, now: number): string {
  const name = limitName(w);
  const at = sendAt(w, RESET_SLACK_MS);
  if (w.stopped) return `The ${name} still turned Claude back after the continues: nothing more goes on its own.`;
  if (at === null) return `The ${name} cut the last turn off; its reset time was not reported, so nothing goes on its own.`;
  if (!w.armed) return `The ${name} cut the last turn off; it resets ${resetsIn(at / 1000, now)} (${clock(at, now)}). Continue after it is off.`;
  return `The ${name} cut the last turn off. "${prefs.text}" goes ${resetsIn(at / 1000, now)} (${clock(at, now)}).`;
}

/** The rail entry's look: lit while a continue is armed, its words the wait's. */
export function limitsLook(state: ChatState, now: number): { cls: string; lit: boolean; title: string } {
  const w = state.limitWait;
  const prefs = state.limitPrefs ?? DEFAULT_LIMIT_PREFS;
  const lit = !!w?.armed;
  const on = [prefs.session ? "after the 5-hour limit" : "", prefs.weekly ? "after the weekly limit" : ""].filter(Boolean);
  const base = on.length ? `Limits: continues ${on.join(" and ")}` : "Limits: continues after no limit";
  return {
    cls: `limits ${w ? (w.armed ? "armed" : "hit") : ""}`,
    lit,
    title: w ? waitLine(w, prefs, now) : `${base}${prefs.handoff ? " · automatic handoff" : ""}`,
  };
}

function Switch(p: { on: boolean; label: string; title: string; disabled?: boolean; set: (on: boolean) => void }) {
  return (
    <label class={`set-switch ${p.disabled ? "off" : ""}`} title={p.title}>
      <input type="checkbox" checked={p.on} disabled={p.disabled} onChange={() => p.set(!p.on)} />
      {p.label}
    </label>
  );
}

/** The menu beside the rail: the switches, the message, and the wait with its Cancel. */
export function LimitsPanel(p: { state: ChatState; ours: boolean; focusIn: boolean; onClose: () => void }) {
  const s = p.state;
  const prefs = s.limitPrefs ?? DEFAULT_LIMIT_PREFS;
  const w = s.limitWait ?? null;
  const now = useNow(30_000, !!w);
  const [text, setText] = useState(prefs.text);
  useEffect(() => setText(prefs.text), [prefs.text]);
  const set = (x: Partial<LimitPrefs>) => post({ t: "limits", prefs: x });
  /** The field's own value, not the render's: a blur right after typing must not save what was there before. */
  const saveText = (typed: string) => {
    const t = typed.trim() || DEFAULT_CONTINUE_TEXT;
    if (t !== prefs.text) set({ text: t });
    else setText(prefs.text);
  };
  return (
    <RailPop cls="settings-pop limits-pop" label="Limits" focusIn={p.focusIn} onClose={p.onClose}>
      <div class="mem-head">
        <b>Limits</b>
        <span class="muted"> · this chat</span>
      </div>
      {!p.ours && <div class="pop-note">This chat runs elsewhere: its switches are that window's.</div>}
      <section class="set-sec" aria-label="Usage limit">
        <div class="pop-head">When the usage limit cuts a turn off</div>
        <Switch
          on={prefs.session}
          disabled={!p.ours}
          label="Continue after the 5-hour limit"
          title="Once the Claude plan's 5-hour limit resets, this chat sends the message below on its own"
          set={(on) => set({ session: on })}
        />
        <Switch
          on={prefs.weekly}
          disabled={!p.ours}
          label="Continue after the weekly limit"
          title="Once a weekly limit resets — all models' or one model's — this chat sends the message below on its own: it spends the next week's allowance unattended"
          set={(on) => set({ weekly: on })}
        />
        <label class="limit-text">
          <span class="muted">Message</span>
          <input
            type="text"
            value={text}
            disabled={!p.ours}
            placeholder={DEFAULT_CONTINUE_TEXT}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
            onBlur={(e) => saveText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              saveText((e.target as HTMLInputElement).value);
            }}
          />
        </label>
        <div class="pop-note">The window must stay open and the machine awake; one that slept through the reset sends when it wakes. A turn that still meets the limit twice in a row stops it.</div>
      </section>
      <section class="set-sec" aria-label="Handoff">
        <Switch
          on={prefs.handoff && s.handoffTool !== false}
          disabled={!p.ours || s.handoffTool === false}
          label="Automatic handoff"
          title="On: when Claude hands this chat over to a fresh session (decision 103), it starts at once. Off: Claude's handoff shows a card, Continue or Stay."
          set={(on) => set({ handoff: on })}
        />
        <div class="pop-note">
          {s.handoffTool === false
            ? "Claude has no handoff tool here: embarchChat.handoff is off."
            : prefs.handoff
              ? "Claude's handoff starts the fresh session at once, in this panel."
              : "Claude's handoff asks you first, on a card."}
        </div>
      </section>
      <section class="set-sec" aria-label="Waiting">
        <div class="pop-head">Now</div>
        {w ? (
          <>
            <div class={`pop-note ${w.stopped ? "err" : ""}`}>{waitLine(w, prefs, now)}</div>
            {p.ours && (
              <button class="pop-row" onClick={() => post({ t: "limitCancel" })}>
                {w.armed ? "Cancel this continue" : "Dismiss"}
              </button>
            )}
          </>
        ) : (
          <div class="pop-note">No limit has cut this chat off.</div>
        )}
      </section>
    </RailPop>
  );
}
