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
// Remote Control is Claude Code's footer pill (its changelog L5709, L2097):
// shown while `/remote-control` has it on, or the CLI started the bridge
// itself, or it has failed; on, a click opens the chat's session on
// claude.ai/code, where a permission prompt can be answered from the phone;
// failed, it says why until /remote-control dismisses it.
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

/**
 * A panel over the input, closed by a click outside it and its pill, or
 * Escape. That Escape closes the panel and does nothing else: taken ahead
 * of the input and marked, so the input's own Esc — Stop while a turn runs
 * (8) — leaves it be. From inside the panel the keys go back to the pill.
 */
function Pop({ kind, anchor, onClose, children }: { kind: string; anchor: HTMLElement | null; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (ref.current?.contains(document.activeElement)) anchor?.focus();
      onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc, true);
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

/** The page's own commands for the `/` list beside the session's: Remote Control is not the CLI's over this wire. */
export const FOOTER_COMMANDS = ["remote-control"];

/**
 * `/mcp` and `/remote-control [name]`, answered by the page as Claude Code's
 * panel answers them — its MCP dialog, here the pill; Remote Control on or
 * off — as history.tsx answers /rewind, /copy and /export. The CLI's own
 * text answer to /mcp is not asked for. True when taken.
 */
export function footerCommand(text: string): boolean {
  const t = text.trim();
  if (t === "/mcp") {
    window.dispatchEvent(new Event("embarch-mcp"));
    return true;
  }
  const rc = /^\/remote-control(?:\s+(.+))?$/.exec(t);
  if (!rc) return false;
  post({ t: "remoteControl", ...(rc[1]?.trim() ? { name: rc[1].trim() } : {}) });
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
  // A model the panel's list does not name: its id, short ("haiku-4-5").
  const name = entry ? (entry.id === "default" ? "Default" : entry.label) : (state.model ?? "Default").replace(/^claude-/, "").replace(/-\d{8}$/, "");
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
          {/* Buttons, so the keyboard reaches each model as it did the <select> before (82); a pick gives the keys back to the pill. */}
          <div role="group" aria-label="Model">
            {MODELS.map((m) => (
              <button
                key={m.id}
                class={`pop-row ${entry?.id === m.id ? "on" : ""}`}
                role="menuitemradio"
                aria-checked={entry?.id === m.id}
                onClick={() => {
                  setOpen(false);
                  btn.current?.focus();
                  if (entry?.id !== m.id) post({ t: "model", model: m.id });
                }}
              >
                {m.label}
                {m.id === "default" && !entry && state.model ? <span class="muted"> · now {state.model}</span> : null}
              </button>
            ))}
          </div>
          <div class="pop-head">Effort</div>
          {levels.length ? (
            <div class="effort-row" role="radiogroup" aria-label="Effort">
              <button class={state.effort === null ? "on" : ""} role="radio" aria-checked={state.effort === null} title="The model's own default" onClick={() => pick(null, state.ultracode)}>
                Default
              </button>
              {levels.map((l) => (
                <button key={l} class={state.effort === l ? "on" : ""} role="radio" aria-checked={state.effort === l} onClick={() => pick(l, state.ultracode)}>
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

/** The Remote Control pill, in Claude Code's words; nothing while it is off. */
export function RemotePill({ state }: { state: ChatState }) {
  const r = state.remote;
  if (!r) return null;
  if (r.status === "connected" && r.url) {
    const url = r.url;
    return (
      <button class="pill remote on" title="Remote Control is active · Click to open claude.ai/code · Run /remote-control to turn off" onClick={() => post({ t: "openLink", url })}>
        Remote Control
      </button>
    );
  }
  // On, though not by /remote-control here: Claude Code started the bridge itself, and named no link (review r4 L6).
  if (r.status === "connected") {
    const tip = "Remote Control is active: Claude Code started it for this session · Run /remote-control to turn off";
    return (
      <span class="pill remote on" role="status" aria-label={tip} title={tip}>
        Remote Control
      </span>
    );
  }
  const tip = r.status === "failed" ? `Remote Control error: ${r.error ?? "unknown"} · Run /remote-control to dismiss` : "Connecting to claude.ai/code…";
  return (
    <span class={`pill remote ${r.status === "failed" ? "bad" : "connecting"}`} role="status" aria-label={tip} title={tip}>
      Remote Control{r.status === "failed" && <span class="pill-bad"> ✗</span>}
    </span>
  );
}
