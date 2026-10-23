// A tool call in the timeline: one line (what the agent says it does, else
// the tool and what it acts on; its status), opening into its input and
// result. Edit and Write show their change as a diff that opens VS Code's
// diff editor on a click (decision 8); a subagent's own steps nest under its
// call. Two or more quiet steps in a row fold into one run row (decision 50,
// runs.ts). `toolRenderers` is the seam for bench result cards (decision 15).
// A step running in the foreground offers "Run in background"; one that runs
// there shows its output as it goes (port items 70, 71; background.tsx).

import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Entry, ToolEntry } from "../../src/wire/reducer";
import { Markdown, MdCtx } from "../shared/markdown";
import { movable } from "../../src/wire/tasks";
import { failedText, foldRuns, quietTool, runHead, runTally, toolIntent } from "./runs";
import { Elapsed } from "./clock";
import { vscodeApi } from "../shared/vscode";
import { RunInBackground, TaskOutput, backgroundStatus } from "./background";

export interface ToolCtx extends MdCtx {
  openDiff(toolId: string): void;
  cwd: string;
  /** A turn runs: a step without its result counts its time (68); after the turn only a background one does. */
  live?: boolean;
  /** Moves a step in the foreground to the background (port item 70); absent where the chat runs elsewhere. */
  runInBackground?: (toolUseId: string) => void;
}

/** A custom body for a tool by name — bench cards plug in here. */
export interface ToolRenderer {
  /** Whether it draws this tool: a claimed tool stands alone, never folded into a run (decision 50). */
  claims(name: string): boolean;
  render(t: ToolEntry, ctx: ToolCtx): ComponentChildren | null;
}
export const toolRenderers: ToolRenderer[] = [];

/** A step that folds into a run (decision 50): any tool but those runs.ts names and those a renderer claims. */
export const quiet = (t: ToolEntry) => quietTool(t.name) && !toolRenderers.some((r) => r.claims(t.name));

function rel(p: unknown, cwd: string): string {
  const s = String(p ?? "");
  return cwd && s.startsWith(cwd + "/") ? s.slice(cwd.length + 1) : s;
}

export function toolSummary(name: string, input: Record<string, unknown>, cwd: string): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash":
      return s("command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return rel(input.file_path, cwd);
    case "NotebookEdit":
      return rel(input.notebook_path, cwd);
    case "Glob":
      return s("pattern");
    case "Grep":
      return `${s("pattern")}${input.path ? `  in ${rel(input.path, cwd)}` : ""}`;
    case "WebFetch":
      return s("url");
    case "WebSearch":
      return s("query");
    case "Agent":
    case "Task":
      return s("description") || s("prompt");
    case "TodoWrite":
      return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
    case "AskUserQuestion":
      return Array.isArray(input.questions) ? String((input.questions[0] as { question?: string })?.question ?? "") : "";
    case "ExitPlanMode":
      return "plan for approval";
    case "Skill":
      return s("skill") || s("command");
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first ?? "";
    }
  }
}

export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[2]}` : name;
}

/**
 * A step's one line (decision 50): the agent's own description when the
 * call carries one, its tool a muted tag after it (`tag`); else the tool and
 * what it acts on. The raw input stays a hover away.
 */
function StepLabel({ t, cwd, tag = true }: { t: ToolEntry; cwd: string; tag?: boolean }) {
  const summary = toolSummary(t.name, t.input, cwd);
  const what = toolIntent(t.name, t.input);
  return what ? (
    <>
      <span class="what" title={summary !== what ? summary : undefined}>
        {what}
      </span>
      {tag && <span class="name">{toolLabel(t.name)}</span>}
    </>
  ) : (
    <>
      <span class="name">{toolLabel(t.name)}</span>
      <span class="summary" title={summary}>
        {summary}
      </span>
    </>
  );
}

const STATUS: Record<ToolEntry["status"], string> = {
  running: "running",
  awaiting: "waits on you",
  done: "",
  error: "error",
  denied: "denied",
};

interface PatchHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

/** Lines of a diff: the CLI's own structuredPatch when there is one, else old against new. */
export function diffLines(t: { name: string; input: Record<string, unknown>; structured?: unknown }): { lines: Array<{ k: "add" | "del" | "ctx" | "hunk"; s: string }>; add: number; del: number } | null {
  const out: Array<{ k: "add" | "del" | "ctx" | "hunk"; s: string }> = [];
  const st = t.structured as { structuredPatch?: PatchHunk[] } | undefined;
  if (st && Array.isArray(st.structuredPatch) && st.structuredPatch.length) {
    for (const h of st.structuredPatch) {
      out.push({ k: "hunk", s: `@@ -${h.oldStart} +${h.newStart} @@` });
      for (const l of h.lines) {
        if (l.startsWith("\\")) continue;
        out.push({ k: l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx", s: l.slice(1) });
      }
    }
  } else if (t.name === "Edit") {
    for (const l of String(t.input.old_string ?? "").split("\n")) out.push({ k: "del", s: l });
    for (const l of String(t.input.new_string ?? "").split("\n")) out.push({ k: "add", s: l });
  } else if (t.name === "MultiEdit" && Array.isArray(t.input.edits)) {
    for (const e of t.input.edits as Array<Record<string, unknown>>) {
      out.push({ k: "hunk", s: "@@" });
      for (const l of String(e.old_string ?? "").split("\n")) out.push({ k: "del", s: l });
      for (const l of String(e.new_string ?? "").split("\n")) out.push({ k: "add", s: l });
    }
  } else if (t.name === "Write") {
    for (const l of String(t.input.content ?? "").split("\n")) out.push({ k: "add", s: l });
  } else return null;
  return { lines: out, add: out.filter((l) => l.k === "add").length, del: out.filter((l) => l.k === "del").length };
}

export function DiffView({ t, onOpen, max = 40 }: { t: { name: string; input: Record<string, unknown>; structured?: unknown }; onOpen: () => void; max?: number }) {
  const d = diffLines(t);
  if (!d) return null;
  const shown = d.lines.slice(0, max);
  return (
    <div>
      <div class="diff" onClick={onOpen} title="Open in VS Code's diff editor">
        {shown.map((l, i) => (
          <div key={i} class={l.k}>
            {l.k === "add" ? "+ " : l.k === "del" ? "- " : l.k === "hunk" ? "" : "  "}
            {l.s}
          </div>
        ))}
        {d.lines.length > max && <div class="hunk">… {d.lines.length - max} more lines</div>}
      </div>
      <button onClick={onOpen}>Open diff</button>
    </div>
  );
}

function Result({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const cut = 4000;
  if (!text) return null;
  return (
    <div>
      <pre class="out">{all || text.length <= cut ? text : text.slice(0, cut) + "\n…"}</pre>
      {text.length > cut && !all && <button onClick={() => setAll(true)}>Show all ({Math.round(text.length / 1000)}K chars)</button>}
    </div>
  );
}

function Todos({ input }: { input: Record<string, unknown> }) {
  const todos = Array.isArray(input.todos) ? (input.todos as Array<{ content?: string; status?: string }>) : [];
  return (
    <div>
      {todos.map((t, i) => (
        <div key={i} class={t.status === "completed" ? "muted" : ""}>
          {t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.content}
        </div>
      ))}
    </div>
  );
}

interface ToolProps {
  t: ToolEntry;
  entries: Record<string, Entry>;
  ctx: ToolCtx;
  render: (e: Entry) => ComponentChildren;
}

function ToolViewInner({ t, entries, ctx, render }: ToolProps) {
  const editLike = ["Edit", "Write", "MultiEdit"].includes(t.name);
  const sub = t.name === "Agent" || t.name === "Task";
  const custom = toolRenderers.map((r) => r.render(t, ctx)).find((x) => x);
  const [open, setOpen] = useState<boolean>(editLike || sub || t.name === "TodoWrite" || !!custom);
  const d = editLike ? diffLines(t) : null;
  const bg = backgroundStatus(t);
  // A step that went to the background: its tool result only says so; its output is the task's.
  const output = bg && t.name !== "Agent" && t.name !== "Task";
  return (
    <div class={`tool ${t.status}`}>
      <div class="line" onClick={() => setOpen(!open)}>
        <StepLabel t={t} cwd={ctx.cwd} />
        {d && (
          <span class="diffstat">
            <span class="a">+{d.add}</span> <span class="d">−{d.del}</span>
          </span>
        )}
        {/* A step in the background counts until its task ends, not until the call returned (68, port item 70). */}
        {t.status !== "awaiting" && t.status !== "denied" && <Elapsed from={t.at} to={bg ? t.taskEndAt : t.doneAt} live={!!ctx.live || !!t.background} always={sub && !t.background} />}
        {bg ? <span class={`st ${bg.cls}`}>{bg.text}</span> : t.status === "running" ? <span class="spinner" /> : <span class={`st ${t.status}`}>{STATUS[t.status]}</span>}
      </div>
      {ctx.runInBackground && movable(t) && <RunInBackground toolUseId={t.id} onMove={ctx.runInBackground} />}
      {t.progress && sub && <div class="progress">{t.progress}</div>}
      {open && (
        <div class="body">
          {custom ? (
            custom
          ) : editLike ? (
            <DiffView t={t} onOpen={() => ctx.openDiff(t.id)} />
          ) : t.name === "TodoWrite" ? (
            <Todos input={t.input} />
          ) : sub ? (
            <div class="children">
              {foldRuns(t.children, (id) => entries[id], quiet).map((f) => (
                <div key={f.key}>{f.run ? <RunView steps={f.ids.map((id) => entries[id])} entries={entries} ctx={ctx} render={render} /> : render(entries[f.ids[0]])}</div>
              ))}
              {t.result && t.status !== "running" && !bg && <Markdown text={t.result} ctx={ctx} />}
            </div>
          ) : (
            <>
              {t.name === "Bash" ? <pre class="out">$ {String(t.input.command ?? "")}</pre> : <pre class="out">{JSON.stringify(t.input, null, 2)}</pre>}
              {output && ctx.runInBackground ? <TaskOutput taskId={t.task!} live={!t.taskEnd} /> : t.result !== undefined && <Result text={t.result} />}
              {/* The whole of either in an editor tab: search, minimap, log colours (decision 62). */}
              <div class="open-tab">
                <button onClick={() => vscodeApi.postMessage({ t: "openContent", toolId: t.id, part: "input" })}>Open input</button>
                {t.result && <button onClick={() => vscodeApi.postMessage({ t: "openContent", toolId: t.id, part: "output" })}>Open output</button>}
              </div>
            </>
          )}
          {editLike && t.status === "error" && t.result && <Result text={t.result} />}
        </div>
      )}
    </div>
  );
}

function same(a: ToolProps, b: ToolProps): boolean {
  if (a.t !== b.t || a.ctx !== b.ctx) return false;
  for (const id of b.t.children) {
    if (a.entries[id] !== b.entries[id]) return false;
    const e = b.entries[id];
    if (e?.kind === "tool") for (const g of e.children) if (a.entries[g] !== b.entries[g]) return false;
  }
  return true;
}

export const ToolView = memo(ToolViewInner, same);

/** The runs the owner opened, by first step: a toggle outlives a re-render, a new snapshot, a switch of chats. */
const openRuns = new Set<string>();

interface RunProps {
  steps: Entry[];
  entries: Record<string, Entry>;
  ctx: ToolCtx;
  render: (e: Entry) => ComponentChildren;
}

/**
 * A run of quiet steps as one row (decision 50): ▸, the latest step's line,
 * how many, and a spinner, "waits on you" or a red count. It follows each
 * step as it arrives, opens only on the owner's click, and then lists one
 * line per step, each opening as a tool row does.
 */
function RunViewInner({ steps, entries, ctx, render }: RunProps) {
  const key = steps[0].id;
  const [, redraw] = useState(0);
  const open = openRuns.has(key);
  const head = runHead(steps);
  const n = runTally(steps);
  const failed = failedText(n);
  // The run's time: since its first step, counting while one runs (68).
  const tools = steps.filter((e): e is ToolEntry => e.kind === "tool");
  const from = tools.find((t) => t.at !== undefined)?.at;
  const to = n.running || n.awaiting ? undefined : Math.max(0, ...tools.map((t) => t.doneAt ?? 0)) || undefined;
  return (
    <div class="tool run">
      <div
        class="line"
        onClick={() => {
          if (open) openRuns.delete(key);
          else openRuns.add(key);
          redraw((x) => x + 1);
        }}
      >
        <span class="chev">{open ? "▾" : "▸"}</span>
        {head && <StepLabel t={head} cwd={ctx.cwd} tag={false} />}
        <span class="count">{n.steps} steps</span>
        {failed && <span class="st error">{failed}</span>}
        {!n.awaiting && <Elapsed from={from} to={to} live={!!ctx.live} />}
        {n.awaiting ? <span class="st awaiting">{STATUS.awaiting}</span> : n.running ? <span class="spinner" /> : null}
      </div>
      {/* Reachable folded: the run's latest step is the running one (port item 70); open, the step's own row has it. */}
      {ctx.runInBackground && !open && head && movable(head) && <RunInBackground toolUseId={head.id} onMove={ctx.runInBackground} />}
      {open && (
        <div class="steps">
          {steps.map((e) => (
            <div key={e.id}>{e.kind === "tool" ? <ToolView t={e} entries={entries} ctx={ctx} render={render} /> : render(e)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export const RunView = memo(RunViewInner, (a: RunProps, b: RunProps) => a.ctx === b.ctx && a.steps.length === b.steps.length && a.steps.every((e, i) => e === b.steps[i]));
