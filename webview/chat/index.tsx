// The chat webview: its card as a header (decision 18), the timeline, what
// waits on the owner, the input. State arrives as one snapshot and then as
// wire events, folded here by the same reducer the host runs; events are
// folded as they come and rendered once per frame. The timeline is in turns,
// one per message of the owner's (decision 51), and runs of quiet steps fold
// into one row (decision 50); only the turns and rows that changed are
// drawn again (decision 85, settled.tsx). Its history — fork, rewind, copy,
// export — is history.tsx's (decisions 73 and 74). Messages that wait for
// Claude sit above the input, background tasks open from the status line
// (port items 70–72). A rail on the left edge holds Memory, Promptu, the 📚
// and the 💡 (decision 94); Promptu's dialog opens over the chat (96).

import "../shared/style.css";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ChatState, Entry, chatStatus, liveBlocks, reduce } from "../../src/wire/reducer";
import { Link } from "../shared/link";
import { LiveMarkdown, Markdown } from "../shared/markdown";
import type { ChatView, Header, HostToChat, MentionItem } from "../shared/protocol";
import type { Chip, PastPrompt } from "../../src/assistant/edits";
import type { LibraryEntry } from "../../src/library/entries";
import { duration, vscodeApi } from "../shared/vscode";
import { CompactCard, PendingCards } from "./cards";
import { Composer, EditorChip, promptuLanded, returnToDraft } from "./composer";
import { PromptuDialog } from "./promptu";
import type { PromptuView } from "../../src/promptu/runs";
import type { PromptuState } from "../../src/promptu/service";
import { RunView, ToolCtx, ToolView, quiet, revealTool, toolRenderers } from "./tools";
import { Fold, foldRuns, liveTool } from "./runs";
import { benchRenderer } from "./bench";
import { BackgroundPanel, BackgroundToggle } from "./background";
import { Queued } from "./queue";
import { setAtlas } from "./atlas";
import "./reflinks";
import { setChatRepo, setRefs } from "./refs";
import { LimitBannerView } from "./limits";
import { FOOTER_COMMANDS, McpPill, ModelPill, RemotePill, footerCommand } from "./footer";
import { KeepReply } from "./keep";
import { Stamp, useNow } from "./clock";
import { dayKey, elapsedText, stalled } from "./time";
import { cacheClock } from "../../src/wire/limits";
import { CopyReply, ExportDialog, LOCAL_COMMANDS, MessageActions, RewindDialog, Toast, localCommand, replies, useEscEsc } from "./history";
import { SideQuestions } from "./side";
import { ContextRows } from "./context";
import { Settled, turns } from "./settled";

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
        {!view.readOnly && (
          <button class="icon rename" title="Rename this chat" onClick={() => post({ t: "rename" })}>
            ✎
          </button>
        )}
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

function StatusLine({ state, warning, bg }: { state: ChatState; warning: string | null; bg: preact.ComponentChildren }) {
  const st = chatStatus(state);
  // A minute with no word from the CLI and no tool running: it may be stuck, not flashing (68); the cache clock by the half minute (69).
  const now = useNow(st === "busy" ? 1000 : 30_000, st === "busy" || !!state.cache);
  const quiet = stalled(state, now);
  const parts: preact.ComponentChildren[] = [];
  if (state.compacting) parts.push(<span key="c"><span class="spinner" /> Compacting…</span>);
  else if (quiet)
    parts.push(
      <span key="b" class="stalled" title={`No word from Claude Code for ${elapsedText(now - state.lastLineAt!)}, and no tool is running`}>
        <span class="spinner" /> Not responding
      </span>,
    );
  else if (st === "busy") parts.push(<span key="b"><span class="spinner" /> Working…</span>);
  if (state.process === "starting") parts.push(<span key="s">Starting claude…</span>);
  if (state.process === "closed" && state.timeline.length) parts.push(<span key="cl">Closed when idle — the next message resumes it.</span>);
  if (state.process === "error") parts.push(<span key="e" class="err">{state.processError ?? "claude failed"}</span>);
  if (state.background.length) parts.push(<span key="bg">{bg}</span>);
  // Between turns, whether a message now reads the conversation from the prompt cache (69); not mid-turn, a card waiting on the owner included.
  const cache = st === "idle" || st === "closed" ? cacheClock(state.cache, now) : null;
  if (cache) parts.push(<span key="pc" class={`cache ${cache.kind}`} title={cache.detail}>{cache.text}</span>);
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
  const [editor, setEditor] = useState<EditorChip | null>(null);
  // Promptu (94–96): its card's state, each chat's dialog, and the rail the composer draws into.
  const [promptu, setPromptu] = useState<PromptuState | null>(null);
  const [promptuViews, setPromptuViews] = useState<Record<string, PromptuView | null>>({});
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  // The desk's reference index (decision 88), set whole by the host: each one draws the rows that read it again.
  const [refsV, setRefsV] = useState(0);
  const live = useRef<ChatState | null>(null);
  const frame = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Esc twice at an idle input opens the rewind picker (decision 73).
  useEscEsc(!!model.view && !model.view.readOnly && !!model.state && !model.state.busy && !model.state.compacting);
  // The chats whose background tasks are open (port item 71).
  const [bgOpen, setBgOpen] = useState<Record<string, boolean>>({});

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
          setChatRepo(m.view.githubRepo);
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
          returnToDraft(m.sid, m.text, m.typed === true);
          return;
        case "editor":
          setEditor(m.editor);
          return;
        case "refs":
          setRefs(m.refs);
          setRefsV((v) => v + 1);
          return;
        case "promptuState":
          setPromptu(m.state);
          return;
        case "promptu":
          setPromptuViews((v) => ({ ...v, [m.sid]: m.view }));
          return;
        case "promptuResult":
          promptuLanded(m.result);
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
  const turnRuns = !!state && (state.busy || state.compacting);
  const sid = state?.sessionId ?? "";
  const acts = !!model.view && !model.view.readOnly;
  // What a step touched links into embarch-ui, and names the chat's own item from its card (decision 87). A `gh` naming
  // no repo is not the chat's folder's: where the shell was when it ran is not known.
  const ui = model.view?.uiUrl ?? "";
  const h = model.header;
  const [ownId, ownTitle, ownKey, ownUrl] = [h?.itemId ?? null, h?.title ?? "", h?.issueKey, h?.issueUrl];
  const ctx: ToolCtx = useMemo(
    () => ({
      openLink: (url: string) => post({ t: "openLink", url }),
      openFile: (path: string, line?: number) => post({ t: "openFile", path, line }),
      openDiff: (toolId: string) => post({ t: "openDiff", toolId }),
      cwd,
      live: turnRuns,
      // Moved there by the owner: the background tasks open, to show where it went.
      runInBackground: acts
        ? (toolUseId: string) => {
            setBgOpen((o) => ({ ...o, [sid]: true }));
            post({ t: "runInBackground", toolUseId });
          }
        : undefined,
      subjects: { uiUrl: ui, own: h ? { itemId: ownId, title: ownTitle, issueKey: ownKey, issueUrl: ownUrl } : null },
    }),
    // The card's fields, not the header object a desk poll replaces; and the desk's index, which a step's
    // title and link and a key in prose read (decisions 87, 88): rows already drawn take it when it arrives.
    [cwd, turnRuns, sid, acts, ui, !!h, ownId, ownTitle, ownKey, ownUrl, refsV],
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
  const reply = replies(state);
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
            {e.context && <ContextRows items={e.context} ctx={ctx} />}
            <MessageActions e={e} view={view} />
          </div>
        );
      case "text": {
        // Claude's own text (not a subagent's step) can be kept on the work
        // item, block by block (84). A finished turn's last block carries one
        // row: Copy, the whole reply (74), and Keep, this block; an earlier
        // block offers Keep under the pointer.
        if (e.parent !== null) return <Markdown text={e.text} ctx={ctx} />;
        const whole = reply.get(e.id);
        return (
          <div class="reply">
            <Markdown text={e.text} ctx={ctx} />
            {whole !== undefined ? (
              <CopyReply text={whole}>
                <KeepReply id={e.id} inRow />
              </CopyReply>
            ) : (
              <KeepReply id={e.id} />
            )}
          </div>
        );
      }
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
        if (e.tone === "compact") return <CompactCard e={e} ctx={ctx} />;
        // What the CLI sent Claude, not the owner (decision 89): a task's end as a line that opens its card, another session's message collapsed.
        if (e.tone === "task")
          return e.tool && entries[e.tool] ? (
            <button type="button" class="note task link" title="Show the step it ended" onClick={() => revealTool(e.tool!)}>
              {e.text}
            </button>
          ) : (
            <div class="note task">{e.text}</div>
          );
        if (e.tone === "peer")
          return (
            <details class="note peer">
              <summary>{e.text}</summary>
              <pre>{e.detail}</pre>
            </details>
          );
        return (
          <div class={`note ${e.tone}`}>
            {e.text}
            {e.offer === "rerun" && acts && state.rerunOffer === e.id && (
              <div class="offer">
                <button title="Resume the chat and rerun the step the reload cut off, in the chat's own mode" onClick={() => post({ t: "continueStep" })}>
                  Continue the interrupted step
                </button>
              </div>
            )}
            {e.kept && (
              <div class="kept">
                <pre>{e.kept}</pre>
                <button class="secondary" title="Copy the message" onClick={() => void navigator.clipboard?.writeText(e.kept!)}>
                  Copy
                </button>
              </div>
            )}
          </div>
        );
    }
  };

  const liveB = liveBlocks(state);
  // Blocks still streaming join the timeline as entries: a streaming call
  // folds into the run before it, and keeps its row when it lands.
  const streaming = new Map<string, Entry>();
  liveB.forEach((b, i) => {
    if (b.type === "text" || b.type === "thinking") streaming.set(`live${i}`, { kind: b.type, id: `live${i}`, text: b.text, parent: null });
    else if (b.type === "tool_use" && !(b.id && entries[b.id])) {
      const t = liveTool(b, i);
      streaming.set(t.id, t);
    }
  });
  const get = (id: string) => streaming.get(id) ?? entries[id];
  const rows = foldRuns(streaming.size ? [...state.timeline, ...streaming.keys()] : state.timeline, get, quiet);
  const renderRow = (e: Entry): preact.ComponentChildren =>
    !streaming.has(e.id) || e.kind === "tool" ? (
      renderEntry(e)
    ) : e.kind === "text" ? (
      <div class="live cursor">
        <LiveMarkdown text={e.text} ctx={ctx} />
      </div>
    ) : e.kind === "thinking" ? (
      <details class="thinking" open>
        <summary>Thinking…</summary>
        <div class="md muted">{e.text.slice(-600)}</div>
      </details>
    ) : null;
  const busy = state.busy || state.compacting;
  // The page's own /rewind, /copy and /export join the session's commands once it has them: a chat with none yet has nothing to rewind.
  // And the footer's /remote-control (footer.tsx), which the CLI has not over this wire.
  const commands = state.slashCommands.length ? [...state.slashCommands, ...[...LOCAL_COMMANDS, ...FOOTER_COMMANDS].filter((c) => !state.slashCommands.includes(c))] : state.slashCommands;
  // The time above the owner's messages and Claude's replies, a date line where the day changes (68).
  const stamps = new Map<string, { at: number; day: boolean }>();
  let lastDay = "";
  for (const r of rows) {
    const e = get(r.ids[0])!;
    const at = view.timestamps && !r.run && (e.kind === "user" || e.kind === "text") && !streaming.has(e.id) ? e.at : undefined;
    if (at === undefined) continue;
    const day = dayKey(at);
    stamps.set(r.key, { at, day: day !== lastDay });
    lastDay = day;
  }
  // Whether a reload's note still offers to continue its step (63): a process starting ends the offer and leaves the note
  // as it was, so both memos below name it — else the button outlives the offer (review r5 N2).
  const offering = (e: Entry | undefined) => e?.kind === "note" && e.offer === "rerun" && state.rerunOffer === e.id;
  const row = (r: Fold, first: boolean) => {
    const e = get(r.ids[0])!;
    const stamp = stamps.get(r.key);
    // A turn begins at each of the owner's messages: a rule above it, none above the first (decision 51).
    return (
      <div key={r.key} class={!first && !r.run && e.kind === "user" ? "turn" : undefined}>
        {stamp && <Stamp at={stamp.at} mine={e.kind === "user"} day={stamp.day} />}
        {r.run ? (
          <RunView steps={r.ids.map((id) => get(id)!)} entries={entries} ctx={ctx} render={renderEntry} />
        ) : e.kind === "tool" ? (
          renderRow(e)
        ) : (
          // A settled row is drawn once (decision 85): of ctx these rows read only its links and cwd, so a turn
          // starting or ending draws none of them again — the desk's index arriving does, for keys in prose (88).
          // A tool's row has its own memo, which also follows its subagent's steps.
          <Settled deps={[e, view, reply.get(e.id), cwd, offering(e), refsV]} render={() => renderRow(e)} />
        )}
      </div>
    );
  };
  const placeholder = view.readOnly ? "" : view.resumable ? "Message to resume this chat here" : busy ? "Queue a message…" : "Message Claude — @ for files, / for commands";
  // A task start: no message of the owner's in this chat yet (96).
  const taskStart = !state.timeline.some((id) => state.entries[id]?.kind === "user");
  const pv = promptuViews[state.sessionId] ?? null;

  return (
    // A chat of this window's gets Mark as Unread on right-click (package.json, webview/context).
    <div class="chat" data-vscode-context={view.ours ? JSON.stringify({ webviewSection: "embarchChat", sid: state.sessionId }) : undefined}>
      <HeaderBar h={model.header} state={state} view={view} />
      {/* Inert while Promptu's run holds the chat (96; review F4): its dialog's, or Quick mode's with none. */}
      <div class="body" inert={!!pv && !view.readOnly}>
        {!view.readOnly && <div class="rail" ref={setRail} />}
        <div class="main">
          {/* What gives way in a short panel, so the input and Send never leave it (style.css; review r5 N1). */}
          <div class="middle">
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
              {turns(rows, get, entries).map((t, k) => (
                // A turn none of whose entries changed is not drawn again (decision 85): its rows read only these and the page's ctx,
                // view, cwd, each reply's whole text, the stamps' date lines and a reload's offer to continue.
                <Settled
                  key={t.key}
                  deps={[ctx, view, cwd, ...t.deps, ...t.rows.map((r) => reply.get(r.key)), ...t.rows.map((r) => stamps.get(r.key)?.day), ...t.rows.map((r) => offering(get(r.ids[0])))]}
                  render={() => t.rows.map((r, i) => row(r, k === 0 && i === 0))}
                />
              ))}
            </div>
            {/* Each chat's own: another chat put in this view closes them, so a rewind never acts on a message of the chat before (73, 74). */}
            <RewindDialog key={`rewind:${state.sessionId}`} state={state} view={view} />
            <ExportDialog key={`export:${state.sessionId}`} />
            <Toast />
            <PendingCards
              pending={state.pending}
              ctx={ctx}
              readOnly={view.readOnly}
              permDestination={view.permDestination}
              recall={() => {
                // A flagged message back into the draft, to edit and retry (66).
                const last = [...state.timeline].reverse().find((id) => entries[id]?.kind === "user");
                const u = last ? entries[last] : undefined;
                if (u?.kind === "user" && u.text.trim()) returnToDraft(state.sessionId, u.text);
              }}
            />
            <LimitBannerView info={state.rateLimit} busy={busy} />
            {bgOpen[sid] && <BackgroundPanel state={state} readOnly={view.readOnly} />}
            <StatusLine
              state={state}
              warning={model.warning}
              bg={<BackgroundToggle n={state.background.length} open={!!bgOpen[sid]} onToggle={() => setBgOpen((o) => ({ ...o, [sid]: !o[sid] }))} />}
            />
            <SideQuestions items={state.side ?? []} ctx={ctx} />
            <Queued state={state} readOnly={view.readOnly} />
          </div>
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
              waiting={state.pending.length > 0}
              mode={state.mode}
              slashCommands={commands}
              placeholder={placeholder}
              mentions={mentions}
              prompts={prompts}
              library={library.entries}
              assistant={library.assistant && view.ours}
              canAsk={view.ours && (state.timeline.length > 0 || state.process === "running")}
              editor={editor}
              chips={chips?.sid === state.sessionId && view.ours ? chips.chips : []}
              rail={rail}
              promptu={promptu}
              taskStart={taskStart}
              promptuView={pv}
              footer={
                <>
                  <ModelPill state={state} />
                  {view.ours && <McpPill state={state} />}
                  <RemotePill state={state} />
                </>
              }
              onCommand={(text) => localCommand(text, live.current) || (view.ours && footerCommand(text))}
              onSend={(text, opts) => {
                stick.current = true;
                post({ t: "send", text, ...opts });
              }}
              onChip={(c) => {
                stick.current = true;
                post(c.action === "freshChat" ? { t: "freshChat" } : { t: "send", text: c.text });
              }}
            />
          )}
        </div>
      </div>
      {pv && !view.readOnly && pv.quick && pv.phase === "working" && (
        <div class="promptu-quick muted" role="status">
          <span class="spinner" /> Promptu is writing your prompt (Quick mode){pv.doing === "prep" ? " — Esc skips it" : ""}
        </div>
      )}
      {pv && !view.readOnly && <PromptuDialog view={pv} />}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
