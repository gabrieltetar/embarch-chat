// The chat's settings menu (EMB-164): the gear at the bottom of the rail
// (94) opens it beside the rail as Memory's menu opens (98). What sat left of
// the input's box until then (EMB-60) is in it: the permission mode, the
// model, Remote Control and the MCP servers. A chat with no message yet
// opens with it shown, the draft keeping the focus; before the chat's own
// claude runs, what it lists comes from the login's probe (startupProbe.ts).
//
// The model section is Claude Code's model pill (its changelog L2008, L1858,
// L416): the model and the effort it runs at, "· Ultracode" when that is
// on; the model list, an Effort row of the levels the model takes, and the
// Ultracode switch where the CLI offers it. Effort is this chat's own — low
// for a log check, high for driver bring-up — and goes with each process it
// starts; the model list is the panel's (MODELS).
//
// Remote Control is Claude Code's (its changelog L5709, L2097): on while
// `/remote-control` or the switch here has it on, or Claude Code's
// remoteControlAtStartup had the panel start it (100); on, the chat's
// session on claude.ai/code opens from here, where a permission prompt can
// be answered from the phone; failed, it says why. Before a process runs,
// the switch says what its start will do.
//
// MCP is Claude Code's `/mcp` dialog (its changelog L6014): every server of
// the chat's CLI with its state, Reconnect, Disable and Enable. Reconnect
// starts the server's process again — after a rebuild of the embarch-api MCP
// binary the running chat keeps the old one until then, and the chat goes
// on. The window's own server (decision 65) lists too, with nothing to do.
//
// The gear shows what the menu hides: a red mark when a server or Remote
// Control failed, its name on hover the mode and the model, tinted in Plan
// and Ask.

import { useEffect, useState } from "preact/hooks";
import type { ChatState, McpServer } from "../../src/wire/reducer";
import { MODELS, MODES } from "../shared/protocol";
import { vscodeApi } from "../shared/vscode";
import { RailPop } from "./rail";

const post = (m: unknown) => vscodeApi.postMessage(m);

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

/** The event `/mcp` raises: the composer opens the settings menu on it. */
export const SETTINGS_EVENT = "embarch-settings";

/**
 * `/mcp` and `/remote-control [name]`, answered by the page as Claude Code's
 * panel answers them — its MCP dialog, here the settings menu; Remote
 * Control on or off — as history.tsx answers /rewind, /copy and /export.
 * The CLI's own text answer to /mcp is not asked for. True when taken.
 */
export function footerCommand(text: string): boolean {
  const t = text.trim();
  if (t === "/mcp") {
    window.dispatchEvent(new Event(SETTINGS_EVENT));
    return true;
  }
  const rc = /^\/remote-control(?:\s+(.+))?$/.exec(t);
  if (!rc) return false;
  post({ t: "remoteControl", ...(rc[1]?.trim() ? { name: rc[1].trim() } : {}) });
  return true;
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

/** "Sonnet · high", "· Ultracode" when on: what runs while a process runs, else what the owner picked for the next one. */
export function modelLabel(state: ChatState): string {
  const entry = modelEntry(state);
  // A model the panel's list does not name: its id, short ("haiku-4-5").
  const name = entry ? (entry.id === "default" ? "Default" : entry.label) : (state.model ?? "Default").replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const levels = levelsOf(state);
  const effort = state.applied ? state.applied.effort : levels.length ? state.effort : null;
  const ultra = state.applied ? state.applied.ultracode : state.ultracode;
  return `${name}${effort ? ` · ${effort}` : ""}${ultra ? " · Ultracode" : ""}`;
}

export function modeLabel(mode: string): string {
  return MODES.find((m) => m.id === mode)?.label ?? mode;
}

/** Servers to look at, Claude Code's ✗ count in its dialog: failed, or waiting on a sign-in. */
function mcpBad(state: ChatState): number {
  return (state.mcp ?? []).filter((s) => s.status === "failed" || s.status === "needs-auth").length;
}

/**
 * The gear's look: its class (tinted in Plan and Ask, marked on a failure)
 * and its words. Only a failed server marks it: a claude.ai connector never
 * signed in to waits on its sign-in for good [measured 2026-11-12: 10 of 21
 * servers on the owner's login], and a mark always on says nothing.
 */
export function settingsGear(state: ChatState): { cls: string; label: string; title: string } {
  const summary = `${modeLabel(state.mode)} · ${modelLabel(state)}`;
  const bad = (state.mcp ?? []).filter((s) => s.status === "failed").length;
  const remoteBad = state.remote?.status === "failed";
  const why = [bad ? `${bad} MCP server${bad > 1 ? "s" : ""} failed` : "", remoteBad ? "Remote Control failed" : ""].filter(Boolean).join(", ");
  const tint = state.mode === "plan" ? "mode-plan" : state.mode === "default" ? "mode-ask" : "";
  return {
    cls: `settings ${tint} ${bad || remoteBad ? "bad" : ""}`,
    label: summary,
    title: `Settings: ${summary}${remoteOn(state) ? " · Remote Control on" : ""}${why ? ` — ${why}` : ""}`,
  };
}

/** Whether Remote Control is on, or will be when the chat's claude starts. */
function remoteOn(state: ChatState): boolean {
  const r = state.remote;
  if (r) return r.status !== "failed";
  return state.process !== "running" && !!state.remoteStartup?.on;
}

function ModeSection({ state }: { state: ChatState }) {
  const known = MODES.some((m) => m.id === state.mode);
  return (
    <section class="set-sec" aria-label="Permission mode">
      <div class="pop-head">Permission mode</div>
      <div role="group" aria-label="Permission mode" class="set-choices">
        {[...MODES, ...(known ? [] : [{ id: state.mode, label: state.mode }])].map((m) => (
          <button key={m.id} class={`pop-row ${state.mode === m.id ? "on" : ""}`} role="menuitemradio" aria-checked={state.mode === m.id} onClick={() => state.mode !== m.id && post({ t: "mode", mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function ModelSection({ state }: { state: ChatState }) {
  const entry = modelEntry(state);
  const levels = levelsOf(state);
  const offer = state.applied ? state.applied.ultracodeAvailable : state.ultracode;
  const pick = (e: string | null, u: boolean) => post({ t: "effort", effort: e, ultracode: u });
  return (
    <section class="set-sec" aria-label="Model">
      <div class="pop-head">Model</div>
      {/* Buttons, so the keyboard reaches each model as it did the <select> before (82). */}
      <div role="group" aria-label="Model" class="set-choices">
        {MODELS.map((m) => (
          <button key={m.id} class={`pop-row ${entry?.id === m.id ? "on" : ""}`} role="menuitemradio" aria-checked={entry?.id === m.id} onClick={() => entry?.id !== m.id && post({ t: "model", model: m.id })}>
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
    </section>
  );
}

/** What the Remote Control switch stands on, in words. */
function remoteNote(state: ChatState): string {
  const r = state.remote;
  if (r?.status === "connecting") return "Connecting to claude.ai/code…";
  if (r?.status === "failed") return `Failed: ${r.error ?? "unknown"}`;
  if (r) return r.auto ? "On since this chat's claude started: the phone reaches it while the chat is open." : "On: the phone reaches this chat.";
  if (state.process === "running") return "Off.";
  const st = state.remoteStartup;
  if (!st) return "Off. Whether Claude Code turns it on with the chat is known once its claude answers.";
  if (st.on) return st.setting ? "Turns on when Claude starts, at your first message (remoteControlAtStartup)." : "Turns on when Claude starts, at your first message.";
  return st.setting ? "Off for this chat, though remoteControlAtStartup would turn it on." : "Off.";
}

function RemoteSection({ state }: { state: ChatState }) {
  const on = remoteOn(state);
  const url = state.remote?.status === "connected" ? state.remote.url : undefined;
  return (
    <section class="set-sec" aria-label="Remote Control">
      <label class={`set-switch remote ${state.remote?.status ?? ""}`} title="Claude Code's Remote Control: this chat on claude.ai/code and the phone (/remote-control)">
        <input type="checkbox" checked={on} onChange={() => post({ t: "remote", on: !on })} />
        Remote Control
      </label>
      <div class={`pop-note ${state.remote?.status === "failed" ? "err" : ""}`}>{remoteNote(state)}</div>
      {url && (
        <button class="pop-row link" onClick={() => post({ t: "openLink", url })}>
          Open this chat on claude.ai/code
        </button>
      )}
      {state.remoteByDefault && !state.remote && on && <div class="pop-note">Claude Code's default turns it on, not your setting.</div>}
    </section>
  );
}

function McpSection({ state }: { state: ChatState }) {
  const [busy, setBusy] = useState<{ name: string; action: McpAct } | null>(null);
  const live = state.process === "running";
  // The list came back: the action under way is done, whatever it did.
  useEffect(() => setBusy(null), [state.mcp]);
  useEffect(() => {
    if (live) post({ t: "mcpStatus" });
  }, [live]);
  const servers = state.mcp ?? [];
  const act = (name: string, action: McpAct) => {
    setBusy({ name, action });
    post({ t: "mcp", name, action });
  };
  return (
    <section class="set-sec" aria-label="MCP servers">
      <div class="pop-head">MCP servers{mcpBad(state) > 0 && <span class="pill-bad"> ✗{mcpBad(state)}</span>}</div>
      {servers.map((s) => (
        <McpRow key={s.name} s={s} live={live} busy={busy} act={act} />
      ))}
      {!servers.length && <div class="pop-note">{live ? "No MCP servers." : "Not known yet: Claude lists them when it starts."}</div>}
      {!live && servers.length > 0 && <div class="pop-note">Claude is not running: the next message starts every server afresh.</div>}
    </section>
  );
}

/**
 * The settings menu beside the rail: mode, model, Remote Control and, for a
 * chat this window runs, MCP. It stands on the input's row (`lift`, the
 * input's height), so what is typed while it shows stays in sight.
 */
export function SettingsPanel(p: { state: ChatState; ours: boolean; focusIn: boolean; onClose: () => void; lift: number }) {
  const s = p.state;
  const style = p.lift ? { bottom: `${p.lift + 4}px`, maxHeight: `calc(100% - ${p.lift + 12}px)` } : undefined;
  return (
    <RailPop cls="settings-pop" label="Settings" focusIn={p.focusIn} onClose={p.onClose} style={style}>
      <div class="mem-head">
        <b>Settings</b>
        <span class="muted"> · this chat</span>
      </div>
      <ModeSection state={s} />
      <ModelSection state={s} />
      {p.ours && <RemoteSection state={s} />}
      {p.ours && <McpSection state={s} />}
      {s.process !== "running" && <div class="pop-note">Claude is not running: the next message starts it with these.</div>}
    </RailPop>
  );
}
