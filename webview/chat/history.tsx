// The conversation's history, page side (decision 74), as Claude
// Code's panel has it: each reply gets a Copy button; `/copy` copies the
// latest, `/export` copies or saves the whole conversation as plain text.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatState } from "../../src/wire/reducer";
import type { HostToChat } from "../shared/protocol";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** The commands this page answers itself, offered beside the session's own. */
export const LOCAL_COMMANDS = ["copy", "export"];

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

// ------------------------------------------------------------ replies

/**
 * Each finished turn's reply — the main thread's text, every block of it,
 * as Markdown — keyed by its last text block, where its Copy button goes.
 * A turn still running has none yet.
 */
export function replies(s: ChatState): Map<string, string> {
  const out = new Map<string, string>();
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

export function CopyReply({ text }: { text: string }) {
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
    </div>
  );
}

function openExport(): void {
  window.dispatchEvent(new Event("embarch-export"));
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
  // The dialog takes the keys: Escape closes it.
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
              post({ t: "exportSave", text: st.text, filename: st.filename });
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
 * `/copy [N]` and `/export`, answered by the page as Claude
 * Code's panel answers them; anything else goes to Claude. True when taken.
 */
export function localCommand(text: string, s: ChatState | null): boolean {
  const m = /^\/(copy|export)(?:\s+(.*))?$/.exec(text.trim());
  if (!m || !s) return false;
  if (m[1] === "export") openExport();
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
