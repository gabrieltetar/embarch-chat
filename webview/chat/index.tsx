// The chat webview: its card as a header (decision 18), the timeline, what
// waits on the owner, the input. State arrives as one snapshot and then as
// wire events, folded here by the same reducer the host runs; events are
// folded as they come and rendered once per frame.

import "../shared/style.css";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ChatState, Entry, chatStatus, liveBlocks, reduce } from "../../src/wire/reducer";
import { Link } from "../shared/link";
import { Markdown } from "../shared/markdown";
import type { ChatView, Header, HostToChat, MentionItem } from "../shared/protocol";
import type { Chip, PastPrompt } from "../../src/assistant/edits";
import type { LibraryEntry } from "../../src/library/entries";
import { duration, vscodeApi } from "../shared/vscode";
import { PendingCards } from "./cards";
import { Composer, returnToDraft } from "./composer";
import { ToolCtx, ToolView, toolLabel, toolRenderers } from "./tools";
import { benchRenderer } from "./bench";
import { setAtlas } from "./atlas";

let uiUrl = "";
toolRenderers.push(benchRenderer(() => uiUrl));

const post = (m: unknown) => vscodeApi.postMessage(m);

interface Model {
  state: ChatState | null;
  view: ChatView | null;
  header: Header | null;
  warning: string | null;
}

function HeaderBar({ h, state, view }: { h: Header | null; state: ChatState; view: ChatView }) {
  const [states, setStates] = useState<Array<{ id: string; name: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const on = (ev: MessageEvent<HostToChat>) => {
      if (ev.data.t === "states") {
        setStates(ev.data.states);
        setErr(ev.data.error ?? null);
      }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const ctx = state.context;
  const pct = ctx ? Math.min(100, Math.round((ctx.totalTokens / Math.max(1, ctx.maxTokens)) * 100)) : null;
  const title = h ? h.title : (state.title ?? "Chat");
  return (
    <div class="header">
      <div class="row">
        {h?.issueKey &&
          (h.issueUrl ? (
            <Link class="key" onOpen={() => post({ t: "openLink", url: h.issueUrl })} title="Open the issue">
              {h.issueKey}
            </Link>
          ) : (
            <span class="key">{h.issueKey}</span>
          ))}
        <span class="title" title={state.title ? `${title}\nChat: ${state.title}` : title}>
          {title}
          {h && state.title && <span class="muted"> · {state.title}</span>}
        </span>
        {h?.stateName && (
          <select
            title={err ?? "Issue status"}
            value={states ? (states.find((s) => s.name === h.stateName)?.id ?? "") : "cur"}
            onFocus={() => !states && post({ t: "states" })}
            onMouseDown={() => !states && post({ t: "states" })}
            onChange={(e) => post({ t: "setStatus", stateId: (e.target as HTMLSelectElement).value })}
          >
            {!states && <option value="cur">{h.stateName}</option>}
            {states?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div class="row second">
        {h?.untracked && <span>Untracked</span>}
        {h?.prs.map((p) => (
          <Link key={p.url} class={`pr ${p.state}`} onOpen={() => post({ t: "openLink", url: p.url })} title={p.title}>
            #{p.number} {p.draft ? "draft" : p.state}
          </Link>
        ))}
        {h && !h.untracked && <span title="Today's time on this work item">today {duration(h.todaySeconds)}</span>}
        {h && (
          <Link onOpen={() => post({ t: "openLink", url: h.deskUrl })} title="Open the Desk">
            Desk ↗
          </Link>
        )}
        <span class="meter" title={ctx ? ctx.categories.map((c) => `${c.name}: ${Math.round(c.tokens / 100) / 10}K`).join("\n") : "Context usage shows after the first turn"}>
          {pct !== null && (
            <>
              <span class="meter-wrap">
                <span class={`meter-fill ${pct > 70 ? "high" : ""}`} style={{ width: `${pct}%` }} />
              </span>
              <span>{pct}%</span>
            </>
          )}
          {view.ours && (
            <button class="icon" title="Compact the conversation (/compact)" disabled={state.busy || state.process !== "running"} onClick={() => post({ t: "compact" })}>
              Compact
            </button>
          )}
          {!view.inEditor && (
            <button class="icon" title="Open in an editor tab" onClick={() => post({ t: "openInEditor" })}>
              Tab
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function StatusLine({ state, warning }: { state: ChatState; warning: string | null }) {
  const st = chatStatus(state);
  const parts: preact.ComponentChildren[] = [];
  if (state.compacting) parts.push(<span key="c"><span class="spinner" /> Compacting…</span>);
  else if (st === "busy") parts.push(<span key="b"><span class="spinner" /> Working…</span>);
  if (state.process === "starting") parts.push(<span key="s">Starting claude…</span>);
  if (state.process === "closed" && state.timeline.length) parts.push(<span key="cl">Closed when idle — the next message resumes it.</span>);
  if (state.process === "error") parts.push(<span key="e" class="err">{state.processError ?? "claude failed"}</span>);
  if (state.background.length) parts.push(<span key="bg">{state.background.length} background task{state.background.length > 1 ? "s" : ""} running</span>);
  return (
    <>
      {warning && <div class="warn-line">{warning}</div>}
      {parts.length > 0 && <div class="status-line">{parts}</div>}
    </>
  );
}

function App() {
  const [model, setModel] = useState<Model>({ state: null, view: null, header: null, warning: null });
  const [empty, setEmpty] = useState(false);
  const [mentions, setMentions] = useState<{ q: string; items: MentionItem[] } | null>(null);
  const [prompts, setPrompts] = useState<PastPrompt[]>([]);
  const [library, setLibrary] = useState<{ entries: LibraryEntry[]; assistant: boolean }>({ entries: [], assistant: false });
  const [chips, setChips] = useState<{ sid: string; chips: Chip[] } | null>(null);
  const live = useRef<ChatState | null>(null);
  const frame = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const flush = () => {
      frame.current = 0;
      const s = live.current;
      setModel((m) => (m.state === s ? m : { ...m, state: s }));
    };
    const on = (ev: MessageEvent<HostToChat>) => {
      const m = ev.data;
      switch (m.t) {
        case "snapshot":
          uiUrl = m.view.uiUrl;
          setAtlas(m.view.atlas);
          live.current = m.state;
          stick.current = true;
          setEmpty(false);
          setModel({ state: m.state, view: m.view, header: m.header, warning: m.warning });
          document.body.classList.toggle("in-editor", m.view.inEditor);
          return;
        case "event":
          if (!live.current) return;
          live.current = reduce(live.current, m.e);
          if (!frame.current) frame.current = requestAnimationFrame(flush);
          return;
        case "header":
          setModel((x) => ({ ...x, header: m.header }));
          return;
        case "empty":
          live.current = null;
          setEmpty(true);
          setModel({ state: null, view: null, header: null, warning: m.warning });
          return;
        case "mentions":
          setMentions({ q: m.q, items: m.items });
          return;
        case "prompts":
          setPrompts(m.items);
          return;
        case "library":
          setLibrary({ entries: m.entries, assistant: m.assistant });
          return;
        case "chips":
          setChips({ sid: m.sid, chips: m.chips });
          return;
        case "draft":
          returnToDraft(m.sid, m.text);
          return;
      }
    };
    window.addEventListener("message", on);
    post({ t: "ready" });
    return () => window.removeEventListener("message", on);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const state = model.state;
  const cwd = state?.cwd ?? "";
  const ctx: ToolCtx = useMemo(
    () => ({
      openLink: (url: string) => post({ t: "openLink", url }),
      openFile: (path: string, line?: number) => post({ t: "openFile", path, line }),
      openDiff: (toolId: string) => post({ t: "openDiff", toolId }),
      cwd,
    }),
    [cwd],
  );

  if (empty || !state || !model.view) {
    return (
      <div class="chat">
        {model.warning && <div class="warn-line">{model.warning}</div>}
        <div class="timeline">
          <div class="empty-note">
            <p>No chat open.</p>
            <p>
              Pick a thread in the list, or <Link onOpen={() => post({ t: "newChat" })}>start a chat</Link> on a work item.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const view = model.view;
  const entries = state.entries;
  const renderEntry = (e: Entry): preact.ComponentChildren => {
    switch (e.kind) {
      case "user":
        return (
          <div
            class={`user ${e.pending ? "pending" : ""} ${e.unsent ? "unsent" : ""}`}
            title={e.pending ? (e.held ? "Sent once the compaction before it finishes" : "Sent; Claude has not taken it yet") : e.unsent ? "Not sent: the compaction before it did not finish, or Claude stopped before taking it" : undefined}
          >
            {e.images ? <span class="muted">[{e.images} image{e.images > 1 ? "s" : ""}] </span> : null}
            {e.text}
            {e.pending && e.held && <div class="held muted">after the compaction</div>}
            {e.unsent && <div class="held muted">not sent — it is back in the draft</div>}
          </div>
        );
      case "text":
        return <Markdown text={e.text} ctx={ctx} />;
      case "thinking":
        return (
          <details class="thinking">
            <summary>Thinking</summary>
            <Markdown text={e.text} ctx={ctx} />
          </details>
        );
      case "tool":
        return <ToolView t={e} entries={entries} ctx={ctx} render={renderEntry} />;
      case "note":
        return <div class={`note ${e.tone}`}>{e.text}</div>;
    }
  };

  const liveB = liveBlocks(state);
  const busy = state.busy || state.compacting;
  const placeholder = view.readOnly ? "" : view.resumable ? "Message to resume this chat here" : busy ? "Queue a message…" : "Message Claude — @ for files, / for commands";

  return (
    <div class="chat">
      <HeaderBar h={model.header} state={state} view={view} />
      <div
        class="timeline"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!state.timeline.length && !liveB.length && (
          <div class="empty-note">{view.ours ? "A new chat. The first message starts Claude, in this window's folder." : "Nothing in this chat's transcript yet."}</div>
        )}
        {state.timeline.map((id) => (
          <div key={id}>{renderEntry(entries[id])}</div>
        ))}
        {liveB.map((b, i) =>
          b.type === "text" ? (
            <div key={`live${i}`} class="live cursor">
              <Markdown text={b.text} ctx={ctx} />
            </div>
          ) : b.type === "thinking" ? (
            <details key={`live${i}`} class="thinking" open>
              <summary>Thinking…</summary>
              <div class="md muted">{b.text.slice(-600)}</div>
            </details>
          ) : b.type === "tool_use" ? (
            <div key={`live${i}`} class="tool running">
              <div class="line">
                <span class="name">{toolLabel(b.name ?? "tool")}</span>
                <span class="summary">{b.text.slice(0, 160)}</span>
                <span class="spinner" />
              </div>
            </div>
          ) : null,
        )}
      </div>
      <PendingCards pending={state.pending} ctx={ctx} readOnly={view.readOnly} />
      <StatusLine state={state} warning={model.warning} />
      {view.readOnly ? (
        <div class="readonly">
          <span style="flex:1">{view.where ? `Runs in ${view.where}` : "Not run by this window"} — read-only here.</span>
          <button class="primary" onClick={() => post({ t: "jump" })}>
            Jump
          </button>
        </div>
      ) : (
        <Composer
          key={state.sessionId}
          sid={state.sessionId}
          busy={busy}
          mode={state.mode}
          model={state.model}
          slashCommands={state.slashCommands}
          placeholder={placeholder}
          mentions={mentions}
          prompts={prompts}
          library={library.entries}
          assistant={library.assistant && view.ours}
          chips={chips?.sid === state.sessionId && view.ours ? chips.chips : []}
          onSend={(text, opts) => {
            stick.current = true;
            post({ t: "send", text, ...(opts.handoff ? { handoff: true } : {}) });
          }}
          onChip={(c) => {
            stick.current = true;
            post(c.action === "freshChat" ? { t: "freshChat" } : { t: "send", text: c.text });
          }}
        />
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
