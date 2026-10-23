// The thread list (decision 9): the window's desk's threads by work item,
// waiting-on-you first, Untracked last. A + on a group starts a chat on that
// item; the top + picks one (decision 10). Threads this window does not run
// open read-only, with Jump (decision 31). A thread nothing else runs can be
// renamed by hand (decision 75).

import "../shared/style.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Thread, ThreadGroup } from "../../src/desk/threads";
import type { HostToList } from "../shared/protocol";
import { Link } from "../shared/link";
import { ago, duration, vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);
const SHOW_ENDED = 3;

function where(t: Thread): string {
  if (t.ours) return "here";
  if (!t.live) return "past";
  if (t.client === "embarch-chat") return "another window";
  if (t.client) return t.client;
  return "terminal or panel";
}

function Row({ t, selected, now }: { t: Thread; selected: boolean; now: number }) {
  // A turn that finished off screen, not yet seen: a filled dot, Claude Code's unread.
  const unread = !!t.unread && t.state === "idle";
  return (
    <div
      class={`thread ${selected ? "sel" : ""}`}
      onClick={() => post({ t: "open", sid: t.sessionId })}
      title={t.title}
      // This window's chats get Mark as Unread on right-click (package.json, webview/context).
      data-vscode-context={t.ours ? JSON.stringify({ webviewSection: "embarchChat", sid: t.sessionId }) : undefined}
    >
      <span class={`dot ${unread ? "unread" : t.state}`} title={unread ? "finished — unread" : t.state} />
      <div class="tbody">
        <div class="ttitle">{t.title}</div>
        <div class="tmeta">
          {t.state === "waiting" ? <span class="w">{t.waitingFor ?? "waits on you"}</span> : unread ? <span class="u">finished — unread</span> : where(t)} · {ago(t.lastMs, now)}
        </div>
      </div>
      <span class="acts">
        {(t.ours || !t.live) && (
          <button class="icon rename" title="Rename" onClick={(e) => (e.stopPropagation(), post({ t: "rename", sid: t.sessionId }))}>
            ✎
          </button>
        )}
        <button class="icon" title="Open in an editor tab" onClick={(e) => (e.stopPropagation(), post({ t: "openInEditor", sid: t.sessionId }))}>
          Tab
        </button>
        {!t.ours && t.live && (
          <button class="icon" title="Jump to where it runs" onClick={(e) => (e.stopPropagation(), post({ t: "jump", sid: t.sessionId }))}>
            ↗
          </button>
        )}
      </span>
    </div>
  );
}

function Group({ g, selected, now }: { g: ThreadGroup; selected: string | null; now: number }) {
  const [more, setMore] = useState(false);
  const active = g.threads.filter((t) => t.state !== "ended");
  const ended = g.threads.filter((t) => t.state === "ended");
  const shownEnded = more ? ended : ended.slice(0, Math.max(0, SHOW_ENDED - active.length));
  const it = g.item;
  return (
    <div class="group">
      <div class="group-head" title={it ? `${it.issueKey ?? ""} ${it.title}${it.stateName ? ` — ${it.stateName}` : ""}` : "Chats on no work item"}>
        <span class="gtitle">
          {it ? (
            <>
              {it.issueKey && <span>{it.issueKey} </span>}
              <span style="font-weight:normal">{it.title}</span>
            </>
          ) : (
            "Untracked"
          )}
        </span>
        {it && it.todaySeconds > 0 && <span class="muted" style="font-weight:normal;font-size:0.85em">{duration(it.todaySeconds)}</span>}
        {g.waiting > 0 && <span class="badge">{g.waiting}</span>}
        <button class="icon add" title={it ? "New chat on this work item" : "New untracked chat"} onClick={() => post({ t: "newChat", itemId: it?.id })}>
          +
        </button>
      </div>
      {active.map((t) => (
        <Row key={t.sessionId} t={t} selected={selected === t.sessionId} now={now} />
      ))}
      {shownEnded.map((t) => (
        <Row key={t.sessionId} t={t} selected={selected === t.sessionId} now={now} />
      ))}
      {ended.length > shownEnded.length && (
        <div class="older">
          <Link onOpen={() => setMore(true)}>{ended.length - shownEnded.length} older chats</Link>
        </div>
      )}
      {more && ended.length > SHOW_ENDED && (
        <div class="older">
          <Link onOpen={() => setMore(false)}>fewer</Link>
        </div>
      )}
    </div>
  );
}

function App() {
  const [d, setD] = useState<HostToList | null>(null);
  useEffect(() => {
    const on = (ev: MessageEvent<HostToList>) => {
      if (ev.data.t === "groups") setD(ev.data);
    };
    window.addEventListener("message", on);
    post({ t: "ready" });
    return () => window.removeEventListener("message", on);
  }, []);
  if (!d) return <div class="list muted" style="padding:8px">Loading…</div>;
  return (
    <div class="list">
      <div class="list-head">
        <span class="desk">{d.desk ?? "No desk"}</span>
        <button class="icon" title="New chat…" onClick={() => post({ t: "newChat" })}>
          +
        </button>
      </div>
      {d.error && <div class="warn-line">{d.error}</div>}
      {!d.error && d.notice && <div class="warn-line notice">{d.notice}</div>}
      {!d.groups.length && (
        <div class="muted" style="padding:4px 8px">
          No threads yet. <Link onOpen={() => post({ t: "newChat" })}>Start a chat</Link>.
        </div>
      )}
      {d.groups.map((g) => (
        <Group key={g.key} g={g} selected={d.selected} now={d.now} />
      ))}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
