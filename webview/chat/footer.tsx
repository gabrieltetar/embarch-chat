// The pills at the input's foot, where Claude Code's panel keeps its own
// (its model, MCP and Remote Control pills): each a small button that opens
// a panel over the input, in the place the 💡's and 📚's menus open (38).
//
// The model pill is Claude Code's (its changelog L2008, L1858, L416): the
// model and the effort it runs at, "· Ultracode" when that is on; it opens
// the model list, an Effort row of the levels the model takes, and the
// Ultracode switch where the CLI offers it. Effort is this chat's own — low
// for a log check, high for driver bring-up — and goes with each process it
// starts; the model list is the panel's (MODELS), as before.
//
// MCP is Claude Code's `/mcp` dialog (its changelog L6014): every server of
// the chat's CLI with its state, Reconnect, Disable and Enable. Reconnect
// starts the server's process again — after a rebuild of the embarch-api MCP
// binary the running chat keeps the old one until then, and the chat goes
// on. The window's own server (decision 65) lists too, with nothing to do.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatState, McpServer } from "../../src/wire/reducer";
import { MODELS } from "../shared/protocol";
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

/** The levels the CLI's `--effort` takes, for a model the CLI has not described yet. */
const LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** The panel's entry for the chat's model: an alias it sent, or the one the CLI resolved it to (a non-default alias first). */
function modelEntry(state: ChatState) {
  const m = state.model;
  const byId = MODELS.find((x) => x.id === m);
  if (byId || !m) return byId ?? MODELS[0];
  const aliases = (state.models ?? []).filter((x) => x.resolved === m).map((x) => x.value);
  return MODELS.find((x) => x.id !== "default" && aliases.includes(x.id)) ?? null;
}

/** The levels the chat's model takes: the CLI's word for it, else none once it runs at no effort, else Claude Code's list. */
function levelsOf(state: ChatState): string[] {
  const m = state.model ?? "default";
  const info = (state.models ?? []).find((x) => x.value === m) ?? (state.models ?? []).find((x) => x.resolved === m);
  if (info) return info.levels;
  if (state.applied) return state.applied.effort === null ? [] : LEVELS;
  return LEVELS;
}

/** The model pill: "Sonnet · high", "· Ultracode" when on; the model, its effort and Ultracode inside. */
export function ModelPill({ state }: { state: ChatState }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const entry = modelEntry(state);
  const name = entry ? (entry.id === "default" ? "Default" : entry.label) : (state.model ?? "Default");
  const levels = levelsOf(state);
  // What runs, while a process runs; else what the owner picked, for the next one.
  const effort = state.applied ? state.applied.effort : levels.length ? state.effort : null;
  const ultra = state.applied ? state.applied.ultracode : state.ultracode;
  const offer = state.applied ? state.applied.ultracodeAvailable : state.ultracode;
  const label = `${name}${effort ? ` · ${effort}` : ""}${ultra ? " · Ultracode" : ""}`;
  const pick = (e: string | null, u: boolean) => post({ t: "effort", effort: e, ultracode: u });
  return (
    <>
      <button ref={btn} class="pill model" title={`Model and effort for this chat${state.effort ? "" : " — effort at the model's default"}`} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <Pop kind="model-pop" anchor={btn.current} onClose={() => setOpen(false)}>
          <div class="pop-head">Model</div>
          {MODELS.map((m) => (
            <div
              key={m.id}
              class={`pop-row ${entry?.id === m.id ? "on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setOpen(false);
                if (entry?.id !== m.id) post({ t: "model", model: m.id });
              }}
            >
              {m.label}
              {m.id === "default" && !entry && state.model ? <span class="muted"> · now {state.model}</span> : null}
            </div>
          ))}
          <div class="pop-head">Effort</div>
          {levels.length ? (
            <div class="effort-row" role="radiogroup">
              <button class={state.effort === null ? "on" : ""} title="The model's own default" onClick={() => pick(null, state.ultracode)}>
                Default
              </button>
              {levels.map((l) => (
                <button key={l} class={state.effort === l ? "on" : ""} onClick={() => pick(l, state.ultracode)}>
                  {l}
                </button>
              ))}
            </div>
          ) : (
            <div class="pop-note">This model takes no effort level.</div>
          )}
          {offer && (
            <label class="ultracode" title="Claude Code's Ultracode, for this chat">
              <input type="checkbox" checked={state.ultracode} onChange={() => pick(state.effort, !state.ultracode)} />
              Ultracode
            </label>
          )}
          {state.process !== "running" && <div class="pop-note">Claude is not running: the next message starts it with these.</div>}
        </Pop>
      )}
    </>
  );
}
