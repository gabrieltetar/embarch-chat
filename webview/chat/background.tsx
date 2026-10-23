// Work that runs while the owner does something else (port items 70 and
// 71, after Claude Code's own panel): "Run in background" under a step
// running in the foreground — a Bash call or a subagent — moves it there and
// the turn goes on; the background tasks — shells, Monitors, subagents —
// open from the status line, each with its latest output (a shell's or a
// Monitor's tail, read every second while it runs, as Claude Code's panel
// polls it) or progress (a subagent's), and a Stop of its own. Stop on the
// turn ends only the turn (recorded: the CLI leaves background tasks running).

import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatState, ToolEntry } from "../../src/wire/reducer";
import { hasOutput, plainOutput, taskKind } from "../../src/wire/tasks";
import type { HostToChat } from "../shared/protocol";
import { vscodeApi } from "../shared/vscode";
import { toolIntent } from "./runs";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** How often a running task's output is read again: Claude Code's panel reads it every second. */
export const OUTPUT_POLL_MS = 1000;

type Output = Extract<HostToChat, { t: "taskOutput" }>;

/** The pages' readers of a task's output, by task: the host's answer goes to each. */
const readers = new Map<string, Set<(m: Output) => void>>();
let listening = false;
function onOutput(taskId: string, f: (m: Output) => void): () => void {
  if (!listening) {
    listening = true;
    window.addEventListener("message", (ev: MessageEvent<HostToChat>) => {
      const m = ev.data;
      if (m?.t === "taskOutput") readers.get(m.taskId)?.forEach((g) => g(m));
    });
  }
  const set = readers.get(taskId) ?? new Set();
  set.add(f);
  readers.set(taskId, set);
  return () => {
    set.delete(f);
    if (!set.size) readers.delete(taskId);
  };
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

/**
 * The end of a shell's or a Monitor's output (the CLI keeps the last
 * 8 KiB), read again every second while the task runs and the page is
 * visible, once more after it ended. It follows the end unless the owner
 * scrolled up.
 */
export function TaskOutput({ taskId, live }: { taskId: string; live: boolean }) {
  const [out, setOut] = useState<Output | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    let timer = 0;
    let alive = true;
    const ask = () => {
      if (document.visibilityState === "hidden") timer = window.setTimeout(ask, OUTPUT_POLL_MS);
      else post({ t: "taskOutput", taskId });
    };
    const off = onOutput(taskId, (m) => {
      if (!alive) return;
      setOut(m);
      clearTimeout(timer);
      if (live && !m.error) timer = window.setTimeout(ask, OUTPUT_POLL_MS);
    });
    ask();
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [taskId, live]);
  useEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [out?.output]);
  if (!out) return <div class="task-out muted">Reading its output…</div>;
  if (out.error) return <div class="task-out muted" title={out.error}>Output is not available.</div>;
  const text = plainOutput(out.output ?? "");
  return (
    <div class="task-out">
      <pre
        class="out"
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLPreElement;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
        }}
      >
        {text || "(nothing written yet)"}
      </pre>
      {out.truncated && <div class="muted">the last 8 KB of {kb(out.totalBytes ?? 0)}</div>}
    </div>
  );
}

/**
 * "Run in background" under a step running in the foreground (port item
 * 70), as Claude Code's panel puts it under its card: the step goes on as a
 * background task and the turn goes on without waiting for it.
 */
export function RunInBackground({ toolUseId, onMove }: { toolUseId: string; onMove: (toolUseId: string) => void }) {
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!asked) return;
    // No answer that moves it (the host notes a refusal): the button comes back.
    const t = window.setTimeout(() => setAsked(false), 5000);
    return () => clearTimeout(t);
  }, [asked]);
  return (
    <div class="bg-line">
      <button
        class="link-button"
        disabled={asked}
        title="The step keeps running in the background and Claude goes on; its output and its Stop are under background tasks, below"
        onClick={(e) => {
          e.stopPropagation();
          setAsked(true);
          onMove(toolUseId);
        }}
      >
        {asked ? "Moving to the background…" : "Run in background"}
      </button>
    </div>
  );
}

/** How a step that ran as a background task stands, for its row: running there, or how it ended. */
export function backgroundStatus(t: ToolEntry): { text: string; cls: string } | null {
  if (!t.background || !t.task) return null;
  if (!t.taskEnd) return { text: "in the background", cls: "bg" };
  if (t.taskEnd === "stopped") return { text: "stopped", cls: "stopped" };
  if (t.taskEnd === "failed") return { text: "failed", cls: "error" };
  return { text: "", cls: "done" };
}

/** The status line's switch: how many tasks run in the background; a click opens them. */
export function BackgroundToggle({ n, open, onToggle }: { n: number; open: boolean; onToggle: () => void }) {
  return (
    <button class="link-button bg-toggle" aria-expanded={open} title={open ? "Hide the background tasks" : "Show the background tasks: output and a Stop for each"} onClick={onToggle}>
      {open ? "▾" : "▸"} {n} background task{n > 1 ? "s" : ""}
    </button>
  );
}

/**
 * The background tasks (port item 71): each with what it is (shell,
 * monitor, agent), what the agent says it does, its latest output or
 * progress, and a Stop that ends it and nothing else. The CLI's own list
 * (background_tasks_changed) is the truth: a task leaves when it ends, and
 * its row in the timeline says how.
 */
export function BackgroundPanel({ state, readOnly }: { state: ChatState; readOnly: boolean }) {
  if (!state.background.length) return null;
  return (
    <div class="bg-tasks" aria-label="Background tasks">
      {state.background.map((b) => {
        const id = state.tasks?.[b.id];
        const e = id ? state.entries[id] : undefined;
        const tool = e?.kind === "tool" ? e : undefined;
        const what = (tool && toolIntent(tool.name, tool.input)) || b.description;
        const cmd = tool && typeof tool.input.command === "string" ? tool.input.command : "";
        return (
          <div key={b.id} class="bg-task">
            <div class="line">
              <span class="kind">{taskKind(b.type, tool)}</span>
              <span class="what" title={cmd && cmd !== what ? cmd : undefined}>
                {what}
              </span>
              <span class="spinner" />
              {!readOnly && (
                <button title="Stop this task: the turn and the other tasks go on" onClick={() => post({ t: "stopTask", taskId: b.id })}>
                  Stop
                </button>
              )}
            </div>
            {hasOutput(b.type) ? !readOnly && <TaskOutput taskId={b.id} live /> : tool?.progress && <div class="progress">{tool.progress}</div>}
          </div>
        );
      })}
    </div>
  );
}
