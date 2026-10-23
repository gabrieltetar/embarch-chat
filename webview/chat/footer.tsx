// The pills at the input's foot, where Claude Code's panel keeps its own
// (its model, MCP and Remote Control pills): each a small button that opens
// a panel over the input, in the place the 💡's and 📚's menus open (38).
//
// MCP is Claude Code's `/mcp` dialog (its changelog L6014): every server of
// the chat's CLI with its state, Reconnect, Disable and Enable. Reconnect
// starts the server's process again — after a rebuild of the embarch-api MCP
// binary the running chat keeps the old one until then, and the chat goes
// on. The window's own server (decision 65) lists too, with nothing to do.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatState, McpServer } from "../../src/wire/reducer";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** A panel over the input, closed by a click outside it and its pill, or Escape. */
function Pop({ kind, anchor, onClose, children }: { kind: string; anchor: HTMLElement | null; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [anchor, onClose]);
  return (
    <div class={`pop ${kind}`} ref={ref}>
      {children}
    </div>
  );
}

/** Claude Code's own marks and words for a server's state. */
const MCP_ICON: Record<string, string> = { connected: "✓", failed: "✗", "needs-auth": "⚠", pending: "◐", disabled: "○" };
const MCP_LABEL: Record<string, string> = { connected: "Connected", failed: "Failed", "needs-auth": "Needs Auth", pending: "Connecting…", disabled: "Disabled" };
const DOING: Record<string, string> = { reconnect: "Reconnecting…", disable: "Disabling…", enable: "Enabling…" };

type McpAct = "reconnect" | "enable" | "disable";

function McpRow({ s, live, busy, act }: { s: McpServer; live: boolean; busy: { name: string; action: McpAct } | null; act: (name: string, a: McpAct) => void }) {
  // The window's own server is this extension's, over the chat's stdio: it has no process to start again.
  const own = s.source === "sdk";
  const acts: McpAct[] = !live || own ? [] : s.status === "disabled" ? ["enable"] : s.status === "pending" ? [] : ["reconnect", "disable"];
  const label = (a: McpAct) => (busy?.name === s.name && busy.action === a ? DOING[a] : a === "reconnect" ? "Reconnect" : a === "enable" ? "Enable" : "Disable");
  return (
    <>
      <div class={`mcp-row ${s.status}`}>
        <span class={`st ${s.status}`} aria-hidden="true">
          {MCP_ICON[s.status] ?? "?"}
        </span>
        <span class="name" title={s.tools !== undefined ? `${s.tools} tool${s.tools === 1 ? "" : "s"}` : undefined}>
          {s.name}
        </span>
        <span class={`st-label ${s.status}`}>{own ? "this window's" : (MCP_LABEL[s.status] ?? s.status)}</span>
        {acts.map((a) => (
          <button key={a} class={a === "enable" ? "primary" : "secondary"} disabled={!!busy} onClick={() => act(s.name, a)}>
            {label(a)}
          </button>
        ))}
      </div>
      {s.error && s.status !== "connected" && <div class="mcp-err">{s.error}</div>}
    </>
  );
}

/**
 * `/mcp`, answered by the page as Claude Code's panel answers it — its MCP
 * dialog, here the pill — as history.tsx answers /rewind, /copy and
 * /export; the CLI's own text answer is not asked for. True when taken.
 */
export function footerCommand(text: string): boolean {
  if (text.trim() !== "/mcp") return false;
  window.dispatchEvent(new Event("embarch-mcp"));
  return true;
}

/** The MCP pill: what the CLI's servers are doing, a mark when one has failed, and the dialog's actions. */
export function McpPill({ state }: { state: ChatState }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<{ name: string; action: McpAct } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const live = state.process === "running";
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("embarch-mcp", on);
    return () => window.removeEventListener("embarch-mcp", on);
  }, []);
  // The list came back: the action under way is done, whatever it did.
  useEffect(() => setBusy(null), [state.mcp]);
  useEffect(() => {
    if (open && live) post({ t: "mcpStatus" });
  }, [open, live]);
  const servers = state.mcp ?? [];
  const bad = servers.filter((s) => s.status === "failed" || s.status === "needs-auth").length;
  const counts = Object.entries(servers.reduce<Record<string, number>>((n, s) => ((n[s.status] = (n[s.status] ?? 0) + 1), n), {}))
    .map(([st, n]) => `${n} ${(MCP_LABEL[st] ?? st).toLowerCase()}`)
    .join(", ");
  const act = (name: string, action: McpAct) => {
    setBusy({ name, action });
    post({ t: "mcp", name, action });
  };
  return (
    <>
      <button ref={btn} class={`pill mcp ${bad ? "bad" : ""}`} title={`MCP servers${counts ? `: ${counts}` : ""} — see them, reconnect or disable one (/mcp)`} onClick={() => setOpen(!open)}>
        MCP{bad > 0 && <span class="pill-bad"> ✗{bad}</span>}
      </button>
      {open && (
        <Pop kind="mcp-pop" anchor={btn.current} onClose={() => setOpen(false)}>
          <div class="pop-head">MCP servers</div>
          {servers.map((s) => (
            <McpRow key={s.name} s={s} live={live} busy={busy} act={act} />
          ))}
          {!servers.length && <div class="pop-note">{live ? "No MCP servers." : "Not known yet: Claude lists them when it starts."}</div>}
          {!live && servers.length > 0 && <div class="pop-note">Claude is not running: the next message starts every server afresh.</div>}
        </Pop>
      )}
    </>
  );
}
