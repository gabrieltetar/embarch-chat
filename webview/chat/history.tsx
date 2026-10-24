// The conversation's history, page side (decisions 73 and 74), as
// Claude Code's panel has it. A hover action on each of the owner's
// messages forks the conversation from there or rewinds the files Claude
// changed since; `/rewind` (or Esc twice) opens a picker over the owner's
// messages. A file rewind is shown first — a dry run's files and lines —
// and done only on the owner's click: it changes files on disk. Each reply
// gets a Copy button; `/copy` copies the latest, `/export` copies or saves
// the whole conversation as plain text.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatState, UserEntry } from "../../src/wire/reducer";
import type { RewindResult } from "../../src/wire/chat";
import type { ChatView, HostToChat, Restore } from "../shared/protocol";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** The commands this page answers itself, offered beside the session's own. */
export const LOCAL_COMMANDS = ["rewind", "copy", "export"];

// ------------------------------------------------------------ small things

/** A line that says what just happened, for a moment (a copy). */
export function toast(text: string): void {
  window.dispatchEvent(new CustomEvent("embarch-toast", { detail: text }));
}

export function Toast() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = window.setTimeout(() => setText(null), 2500);
    };
    // It was about the chat on screen: another one takes it away.
    const shown = (ev: MessageEvent<HostToChat>) => ev.data.t === "snapshot" && setText(null);
    window.addEventListener("embarch-toast", on);
    window.addEventListener("message", shown);
    return () => (window.removeEventListener("embarch-toast", on), window.removeEventListener("message", shown), clearTimeout(timer));
  }, []);
  return text ? <div class="toast">{text}</div> : null;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const lines = (n: number, what = "line") => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * A dialog that takes the keys gives them back when it closes, as Claude
 * Code's panel does: to what had them when it opened — the input, the ↶ —
 * else to the input. Called ahead of the effect that moves focus in.
 */
function useFocusBack(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const from = document.activeElement;
    return () =>
      void requestAnimationFrame(() => {
        const back = from instanceof HTMLElement && from !== document.body && from.isConnected ? from : document.querySelector<HTMLElement>(".composer textarea");
        back?.focus();
      });
  }, [open]);
}

/** The owner's message as a list shows it: its first line. */
const firstLine = (t: string) => t.trim().split("\n")[0];

// ------------------------------------------------------------ replies

/** The last answer, kept while the timeline and its entries are the same objects: a streamed delta changes neither (decision 85). */
let lastReplies: { timeline: string[]; entries: ChatState["entries"]; open: boolean; out: Map<string, string> } | null = null;

/**
 * Each finished turn's reply — the main thread's text, every block of it,
 * as Markdown — keyed by its last text block, where its Copy button goes.
 * A turn still running has none yet.
 */
export function replies(s: ChatState): Map<string, string> {
  const open = s.busy || s.compacting;
  if (lastReplies && lastReplies.timeline === s.timeline && lastReplies.entries === s.entries && lastReplies.open === open) return lastReplies.out;
  const out = new Map<string, string>();
  lastReplies = { timeline: s.timeline, entries: s.entries, open, out };
  let texts: string[] = [];
  let last: string | null = null;
  const flush = () => {
    if (last && texts.length) out.set(last, texts.join("\n\n"));
    texts = [];
    last = null;
  };
  for (const id of s.timeline) {
    const e = s.entries[id];
    if (!e) continue;
    if (e.kind === "user") flush();
    else if (e.kind === "text" && !e.parent) {
      texts.push(e.text.trim());
      last = e.id;
    }
  }
  if (!s.busy && !s.compacting) flush();
  return out;
}

/** The turn's reply copied whole; `children` share its row (Keep, 84). */
export function CopyReply({ text, children }: { text: string; children?: ComponentChildren }) {
  const [done, setDone] = useState(false);
  return (
    <div class="reply-acts">
      <button
        class="icon reply-copy"
        title="Copy the whole reply, as Markdown"
        onClick={async () => {
          if (!(await copy(text))) return toast("Could not copy to the clipboard");
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
      {children}
    </div>
  );
}

// ------------------------------------------------------------ the owner's messages

type Open = { uuid?: string; mode?: "code" | "both" };

function openRewind(o: Open = {}): void {
  window.dispatchEvent(new CustomEvent("embarch-rewind", { detail: o }));
}

function openExport(): void {
  window.dispatchEvent(new Event("embarch-export"));
}

/**
 * The menu on one of the owner's messages: fork from it; with the files,
 * only in a chat this window runs. Its items are buttons, so Tab walks them;
 * Esc closes it and gives the keys back to the ↶, and the input takes that
 * Esc as spent, as it does a footer panel's (composer.tsx).
 */
export function MessageActions({ e, view }: { e: UserEntry; view: ChatView }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top?: number; bottom?: number }>({});
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (ev: MouseEvent) => {
      if (box.current && !box.current.contains(ev.target as Node)) setOpen(false);
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => (document.removeEventListener("mousedown", away), document.removeEventListener("keydown", esc, true));
  }, [open]);
  if (!e.uuid || e.pending || e.unsent || view.readOnly) return null;
  const uuid = e.uuid;
  const pick = (f: () => void) => () => (setOpen(false), f());
  return (
    <span class={`msg-acts ${open ? "open" : ""}`} ref={box}>
      <button
        ref={btn}
        class="icon msg-act"
        title="Fork or rewind from this message"
        aria-expanded={open}
        onClick={(ev) => {
          // Under the message, at the timeline's right edge where the owner's
          // bubbles sit; above it when the window ends first.
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          setAt(r.bottom + 110 > window.innerHeight ? { bottom: window.innerHeight - r.top + 2 } : { top: r.bottom + 2 });
          setOpen(!open);
        }}
      >
        ↶
      </button>
      {open && (
        <div class="msg-menu" style={at}>
          <button class="menu-item" onClick={pick(() => post({ t: "rewind", uuid, restore: "conversation" }))}>
            Fork conversation from here
          </button>
          {view.ours && (
            <>
              <button class="menu-item" onClick={pick(() => openRewind({ uuid, mode: "code" }))}>
                Rewind code to here
              </button>
              <button class="menu-item" onClick={pick(() => openRewind({ uuid, mode: "both" }))}>
                Fork conversation and rewind code
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// ------------------------------------------------------------ the rewind dialog

const CHOICES: Array<{ value: Restore; label: string; description: string }> = [
  { value: "both", label: "Restore code and conversation", description: "The conversation is forked into a new chat." },
  { value: "conversation", label: "Restore conversation", description: "The conversation is forked into a new chat. The code stays as it is." },
  { value: "code", label: "Restore code", description: "The conversation stays as it is." },
];

/** `changed`: the host found the files changed since the dry run the owner confirmed, and asks again on this one. */
type Phase = { kind: "list" } | { kind: "check"; e: UserEntry; mode?: "code" | "both"; result: RewindResult | null; changed?: boolean };

/** The owner's messages a rewind can go back to, newest first. */
function points(s: ChatState): UserEntry[] {
  const out: UserEntry[] = [];
  for (const id of s.timeline) {
    const e = s.entries[id];
    if (e?.kind === "user" && e.uuid && !e.pending && !e.unsent && e.text.trim()) out.push(e);
  }
  return out.reverse();
}

export function RewindDialog({ state, view }: { state: ChatState; view: ChatView }) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [on, setOn] = useState(0);
  const [choice, setChoice] = useState<Restore>("both");
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const check = (e: UserEntry, mode?: "code" | "both") => {
    setPhase({ kind: "check", e, mode, result: null });
    if (view.ours) post({ t: "rewindCheck", uuid: e.uuid });
    // Nothing to ask where no process may run: only the conversation, as a fork.
    else setPhase({ kind: "check", e, mode, result: { canRewind: false } });
  };

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const o = (ev as CustomEvent<Open>).detail ?? {};
      const e = o.uuid ? points(stateRef.current).find((x) => x.uuid === o.uuid) : undefined;
      setOn(0);
      setChoice("both");
      if (e) check(e, o.mode);
      else setPhase({ kind: "list" });
    };
    const onHost = (ev: MessageEvent<HostToChat>) => {
      const m = ev.data;
      if (m.t !== "rewindCheck") return;
      // Nothing was rewound: the files changed since the owner looked, so the confirmation comes back with what a rewind restores now (review r4 L4).
      const e = m.again && m.again !== "conversation" ? points(stateRef.current).find((x) => x.uuid === m.uuid) : undefined;
      if (e && m.again && m.again !== "conversation") {
        setPhase({ kind: "check", e, mode: m.again, result: m.result, changed: true });
        return;
      }
      setPhase((p) => (p?.kind === "check" && p.e.uuid === m.uuid ? { ...p, result: m.result } : p));
    };
    window.addEventListener("embarch-rewind", onOpen);
    window.addEventListener("message", onHost);
    return () => (window.removeEventListener("embarch-rewind", onOpen), window.removeEventListener("message", onHost));
  }, [view.ours]);

  // The list, or the confirmation, takes the keys, and gives them back.
  useFocusBack(!!phase);
  useEffect(() => {
    if (phase?.kind === "list") requestAnimationFrame(() => list.current?.focus());
    else if (phase?.kind === "check") requestAnimationFrame(() => box.current?.focus());
  }, [phase?.kind]);

  if (!phase) return null;
  const close = () => setPhase(null);
  const keys = (ev: KeyboardEvent, n: number, enter: () => void) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      setOn((i) => Math.max(0, Math.min(n - 1, i + (ev.key === "ArrowDown" ? 1 : -1))));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      enter();
    }
  };

  if (phase.kind === "list") {
    const items = points(state);
    return (
      <div class="dialog-back" onMouseDown={(ev) => ev.target === ev.currentTarget && close()}>
        <div class="dialog rewind" role="dialog" aria-label="Rewind to…">
          <div class="dialog-title">Rewind to…</div>
          {items.length ? (
            <>
              <p class="muted">Pick one of your messages to restore the code and/or the conversation from before it.</p>
              <ul class="rewind-list" ref={list} tabIndex={0} role="listbox" onKeyDown={(ev) => keys(ev, items.length, () => items[on] && check(items[on]))}>
                {items.map((e, i) => (
                  <li key={e.id} class={i === on ? "on" : ""} role="option" aria-selected={i === on} onMouseEnter={() => setOn(i)} onClick={() => check(e)}>
                    {firstLine(e.text)}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p class="muted">No messages to rewind to yet.</p>
          )}
          <div class="dialog-buttons">
            <button onClick={close}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const { e, mode, result, changed } = phase;
  const files = result?.filesChanged ?? [];
  const codeOk = !!result?.canRewind && files.length > 0;
  // The picker offers what applies; the hover menu came with its own.
  const offered = mode ? [] : CHOICES.filter((c) => c.value === "conversation" || codeOk);
  const restore: Restore = mode ?? (offered.some((c) => c.value === choice) ? choice : "conversation");
  const withCode = restore !== "conversation";
  const ready = result !== null && (!withCode || codeOk);
  const title = mode === "code" ? "Rewind code" : mode === "both" ? "Fork and rewind" : "Rewind";
  const go = () => {
    if (!ready) return;
    post({ t: "rewind", uuid: e.uuid, restore });
    close();
  };
  const cwd = state.cwd ?? "";
  const rel = (f: string) => (cwd && f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f);
  return (
    <div class="dialog-back" onMouseDown={(ev) => ev.target === ev.currentTarget && close()}>
      <div class="dialog rewind" ref={box} role="dialog" aria-label={title} tabIndex={-1} onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), close())}>
        <div class="dialog-title">{title}</div>
        <p class="rewind-to">
          To before <q>{firstLine(e.text)}</q>
        </p>
        {changed && <p class="warn">The files changed since you looked, so nothing was rewound. This is what a rewind restores now.</p>}
        {mode === "both" && <p class="muted">The conversation is forked into a new chat once the files are back.</p>}
        {offered.length > 0 && (
          <div class="choices" role="group" aria-label="What to restore">
            {offered.map((c) => (
              <button key={c.value} class={`choice ${restore === c.value ? "on" : ""}`} aria-pressed={restore === c.value} onClick={() => setChoice(c.value)}>
                <span class="choice-label">{c.label}</span>
                <span class="choice-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {result === null && <p class="muted">Checking what the files would lose…</p>}
        {result?.error && withCode && <p class="err">{result.error}</p>}
        {withCode && result?.canRewind && (
          <>
            {files.length ? (
              <>
                <p class="rewind-sum">
                  <span class="del">{lines(result.deletions ?? 0)}</span> will be removed and <span class="add">{lines(result.insertions ?? 0)}</span> added, across {lines(files.length, "file")}:
                </p>
                <ul class="rewind-files">
                  {files.map((f) => (
                    <li key={f}>{rel(f)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p class="muted">The files have not changed since, so none is restored.</p>
            )}
            <p class="warn">Files edited by hand or by Bash are not rewound.</p>
          </>
        )}
        <div class="dialog-buttons">
          <button class="primary" disabled={!ready} onClick={go}>
            {title}
          </button>
          <button onClick={close}>Never mind</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the export dialog

type Export = { kind: "loading" } | { kind: "ready"; text: string; filename: string };

export function ExportDialog() {
  const [st, setSt] = useState<Export | null>(null);
  const [said, setSaid] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onOpen = () => {
      setSaid("");
      setSt({ kind: "loading" });
      post({ t: "export" });
    };
    const onHost = (ev: MessageEvent<HostToChat>) => {
      const m = ev.data;
      if (m.t === "export") setSt((s) => (s ? { kind: "ready", text: m.text, filename: m.filename } : s));
    };
    window.addEventListener("embarch-export", onOpen);
    window.addEventListener("message", onHost);
    return () => (window.removeEventListener("embarch-export", onOpen), window.removeEventListener("message", onHost));
  }, []);
  // The dialog takes the keys: Escape closes it, and gives them back.
  useFocusBack(!!st);
  useEffect(() => {
    if (st) box.current?.focus();
  }, [!!st]);
  if (!st) return null;
  const close = () => setSt(null);
  return (
    <div class="dialog-back" onMouseDown={(ev) => ev.target === ev.currentTarget && close()}>
      <div class="dialog export" ref={box} role="dialog" aria-label="Export conversation" tabIndex={-1} onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), close())}>
        <div class="dialog-title">Export conversation</div>
        <p>{st.kind === "loading" ? "Preparing the conversation…" : `The whole conversation as plain text, ${st.text.length.toLocaleString()} characters.`}</p>
        {st.kind === "ready" && <p class="muted export-name">{st.filename}</p>}
        {said && <p class="muted">{said}</p>}
        <div class="dialog-buttons">
          <button class="primary" disabled={st.kind !== "ready"} onClick={async () => st.kind === "ready" && setSaid((await copy(st.text)) ? "Copied to the clipboard." : "Could not copy to the clipboard.")}>
            Copy to clipboard
          </button>
          <button
            disabled={st.kind !== "ready"}
            onClick={() => {
              if (st.kind !== "ready") return;
              post({ t: "exportSave" });
              close();
            }}
          >
            Save to file…
          </button>
          <button onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ typed commands

/**
 * `/rewind`, `/copy [N]` and `/export`, answered by the page as Claude
 * Code's panel answers them; anything else goes to Claude. True when taken.
 */
export function localCommand(text: string, s: ChatState | null): boolean {
  const m = /^\/(rewind|copy|export)(?:\s+(.*))?$/.exec(text.trim());
  if (!m || !s) return false;
  if (m[1] === "rewind") openRewind();
  else if (m[1] === "export") openExport();
  else {
    const all = [...replies(s).values()].reverse();
    const arg = (m[2] ?? "").trim();
    const n = arg ? Number(arg) : 1;
    if (!Number.isInteger(n) || n < 1) toast(`/copy [N]: N is 1 for the latest reply, 2 for the one before, … — not ${arg}`);
    else if (!all.length) toast("No reply to copy yet");
    else if (n > all.length) toast(`Only ${all.length} ${all.length === 1 ? "reply" : "replies"} to copy`);
    else {
      const t = all[n - 1];
      void copy(t).then((ok) => toast(ok ? `Copied to the clipboard (${t.length.toLocaleString()} characters, ${lines(t.split("\n").length)})` : "Could not copy to the clipboard"));
    }
  }
  return true;
}

/**
 * Esc twice in a quick row, while Claude is idle and nothing else takes the
 * key — the input empty, no popup or dialog open — opens the rewind picker
 * (Claude Code's own shortcut). Watched at the window, ahead of the input.
 */
export function useEscEsc(enabled: boolean): void {
  const last = useRef(0);
  const on = useRef(enabled);
  on.current = enabled;
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      // Not while the input asks aside (57): that Esc leaves the side-question
      // mode; nor with a footer pill's panel open (81, 82): that Esc closes it.
      const free = on.current && !ta?.value && !ta?.classList.contains("aside") && !document.querySelector(".popup, .menu, .dialog-back, .msg-menu, .pop");
      if (!free) {
        last.current = 0;
        return;
      }
      const now = Date.now();
      if (now - last.current < 600) {
        last.current = 0;
        openRewind();
      } else last.current = now;
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
}
