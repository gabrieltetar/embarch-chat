// The input: Enter sends, Shift+Enter breaks the line, Stop while a turn
// runs (decision 8). `@` completes a workspace path (with the selected lines)
// and the CLI inlines it; `/` completes the session's own commands from
// system/init. The 📚 library and the Haiku assistant's 💡 sit by the input
// when they exist (decision 38); this pass leaves their slot empty.

import { useEffect, useRef, useState } from "preact/hooks";
import type { MentionItem } from "../shared/protocol";
import { MODELS, MODES } from "../shared/protocol";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

interface Props {
  sid: string;
  busy: boolean;
  mode: string;
  model: string | null;
  slashCommands: string[];
  placeholder: string;
  mentions: { q: string; items: MentionItem[] } | null;
  onSend: (text: string) => void;
}

type Pop = { kind: "at" | "slash"; start: number; q: string; items: MentionItem[]; on: number };

type Saved = { drafts?: Record<string, string> };

/** Unsent text survives the webview being hidden and the chat being switched, per chat. */
function saveDraft(sid: string, text: string): void {
  const st = (vscodeApi.getState() as Saved | undefined) ?? {};
  const drafts = { ...(st.drafts ?? {}) };
  if (text) drafts[sid] = text;
  else delete drafts[sid];
  vscodeApi.setState({ ...st, drafts });
}

export function Composer({ sid, busy, mode, model, slashCommands, placeholder, mentions, onSend }: Props) {
  const [text, setText] = useState(() => (vscodeApi.getState() as Saved | undefined)?.drafts?.[sid] ?? "");
  const [pop, setPop] = useState<Pop | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number>(0);

  useEffect(() => {
    saveDraft(sid, text);
    const el = ta.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.4)}px`;
    }
  }, [text]);

  useEffect(() => {
    if (mentions && pop?.kind === "at" && mentions.q === pop.q) setPop({ ...pop, items: mentions.items, on: 0 });
  }, [mentions]);

  const detect = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const q = at[2];
      const start = caret - q.length - 1;
      setPop((p) => ({ kind: "at", start, q, items: p?.kind === "at" ? p.items : [], on: 0 }));
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => post({ t: "mention", q }), 120);
      return;
    }
    const sl = /^\/(\S*)$/.exec(before);
    if (sl && slashCommands.length) {
      const q = sl[1].toLowerCase();
      const items = slashCommands
        .filter((c) => c.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)))
        .slice(0, 30)
        .map((c) => ({ insert: c, label: `/${c}` }));
      setPop(items.length ? { kind: "slash", start: 0, q, items, on: 0 } : null);
      return;
    }
    setPop(null);
  };

  const choose = (it: MentionItem) => {
    if (!pop) return;
    const el = ta.current!;
    const caret = el.selectionStart;
    const ins = pop.kind === "at" ? `@${it.insert} ` : `/${it.insert} `;
    const next = text.slice(0, pop.start) + ins + text.slice(caret);
    setText(next);
    setPop(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = pop.start + ins.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const send = () => {
    // The DOM, not the last render: keys typed and Enter in one frame would
    // otherwise send the text from before them.
    const t = (ta.current?.value ?? text).trim();
    if (!t) return;
    onSend(t);
    setText("");
    setPop(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (pop && pop.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = pop.items.length;
        setPop({ ...pop, on: (pop.on + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(pop.items[pop.on]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPop(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape" && busy) post({ t: "interrupt" });
  };

  return (
    <div class="composer">
      {pop && pop.items.length > 0 && (
        <div class="popup">
          {pop.items.map((it, i) => (
            <div key={it.insert} class={i === pop.on ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), choose(it))}>
              {it.label}
              {it.detail && <span class="detail">{it.detail}</span>}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={placeholder}
        onInput={(e) => {
          const el = e.target as HTMLTextAreaElement;
          setText(el.value);
          detect(el.value, el.selectionStart);
        }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setPop(null), 150)}
      />
      <div class="bar">
        <select title="Permission mode" value={mode} onChange={(e) => post({ t: "mode", mode: (e.target as HTMLSelectElement).value })}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {!MODES.some((m) => m.id === mode) && <option value={mode}>{mode}</option>}
        </select>
        <select title="Model" value={MODELS.some((m) => m.id === model) ? (model as string) : "default"} onChange={(e) => post({ t: "model", model: (e.target as HTMLSelectElement).value })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === "default" && model && !MODELS.some((x) => x.id === model) ? model : m.label}
            </option>
          ))}
        </select>
        <span class="assist-slot" />
        <span class="spacer" />
        {busy && (
          <button title="Stop (Esc)" onClick={() => post({ t: "interrupt" })}>
            Stop
          </button>
        )}
        <button class="primary" disabled={!text.trim()} onClick={send} title={busy ? "Queued until Claude's turn ends" : "Send (Enter)"}>
          {busy ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
