// A tool call in the timeline: one line (what the agent says it does, else
// the tool and what it acts on; its status), opening into its input and
// result. Edit and Write show their change as a diff that opens VS Code's
// diff editor on a click (decision 8); a subagent's own steps nest under its
// call. Two or more quiet steps in a row fold into one run row (decision 50,
// runs.ts). `toolRenderers` is the seam for bench result cards (decision 15).
// A step running in the foreground offers "Run in background"; one that runs
// there shows its output as it goes (port items 70, 71; background.tsx).
// A step that touches a connector names what it touched, the connector's
// glyph before it, as a link (decision 87, subjects.ts).

import { memo } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Entry, ToolEntry } from "../../src/wire/reducer";
import { Markdown, MdCtx } from "../shared/markdown";
import { movable } from "../../src/wire/tasks";
import { failedText, foldRuns, quietTool, runHead, runTally, toolIntent } from "./runs";
import { Elapsed } from "./clock";
import { QuestionsBody, QuestionsLine } from "./questions";
import { vscodeApi } from "../shared/vscode";
import { RunInBackground, TaskOutput, backgroundStatus } from "./background";
import { Link } from "../shared/link";
import { Connector, Subject, SubjectEnv, runSubjects, stepSubject } from "./subjects";

export interface ToolCtx extends MdCtx {
  openDiff(toolId: string): void;
  cwd: string;
  /** A turn runs: a step without its result counts its time (68); after the turn only a background one does. */
  live?: boolean;
  /** Moves a step in the foreground to the background (port item 70); absent where the chat runs elsewhere. */
  runInBackground?: (toolUseId: string) => void;
  /** embarch-ui's address and the chat's own work item, for what a step touched (decision 87). */
  subjects?: SubjectEnv;
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

// ------------------------------------------------------------ glyphs (decision 87)

/**
 * Each connector's mark in one colour, drawn in currentColor so it follows
 * the theme as a codicon does. Linear's, GitHub's and Slack's paths are
 * Simple Icons 13.21.0 (https://simpleicons.org, icons/linear.svg,
 * github.svg, slack.svg), CC0-1.0; the marks stay their owners' trademarks.
 * The Desk's and the bench's is the EmbArch mark (decision 54,
 * media/embarch-glyph.svg, whose path this is).
 */
const MARK = "M4.466,14.864 6.641,11 6.504,11 7.409,9 7.592,9 10.515,3 13.709,3 15,15 12.485,15 12.214,12 8.408,12 7.049,15 4.466,15ZM1,10.379 2.903,1 9.019,1 8.68,3 4.534,3 4.194,5 7.796,5 7.796,5.01 7.456,7 3.786,7 3.379,9 6.286,9 5.381,11 1,11ZM9.427,9.971 12.01,10.039 11.67,5.35 11.466,5.485Z";
const GLYPHS: Record<Connector, { name: string; box: string; d: string }> = {
  linear: {
    name: "Linear",
    box: "0 0 24 24",
    d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  },
  github: {
    name: "GitHub",
    box: "0 0 24 24",
    d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  slack: {
    name: "Slack",
    box: "0 0 24 24",
    d: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  },
  desk: { name: "the Desk", box: "0 0 16 16", d: MARK },
  bench: { name: "the bench", box: "0 0 16 16", d: MARK },
};

export function Glyph({ c }: { c: Connector }) {
  const g = GLYPHS[c];
  return (
    <svg class={`glyph g-${c}`} viewBox={g.box} role="img" aria-label={g.name}>
      <path d={g.d} fill="currentColor" />
    </svg>
  );
}

/** What a step touched: its glyph, its name and title, a link when it has one; the raw input on hover. */
function SubjectView({ s, raw, ctx, brief = false }: { s: Subject; raw: string; ctx: ToolCtx; brief?: boolean }) {
  const text = (
    <>
      <span class="subject-key">{s.label}</span>
      {!brief && s.title && <span class="subject-title">{s.title}</span>}
    </>
  );
  const hover = [s.title && brief ? `${s.label} ${s.title}` : "", raw, s.url ? `Opens in ${s.where ?? "the browser"}: ${s.url}` : ""].filter(Boolean).join("\n");
  return (
    <span class="subject" title={hover}>
      <Glyph c={s.connector} />
      {s.url ? (
        <Link class="subject-link" title={hover} onOpen={() => ctx.openLink(s.url!)}>
          {text}
          {!brief && <span class="subject-out">↗</span>}
        </Link>
      ) : (
        <span class="subject-text">{text}</span>
      )}
    </span>
  );
}

/** A step's input as its hover shows it: a command as typed, an MCP call's JSON. */
function rawInput(t: ToolEntry, summary: string): string {
  if (!t.name.startsWith("mcp__")) return summary;
  const j = JSON.stringify(t.input);
  return j.length > 600 ? `${j.slice(0, 600)}…` : j;
}

/**
 * A step's one line (decision 50): the agent's own description when the
 * call carries one, its tool a muted tag after it (`tag`); else the tool and
 * what it acts on. A step that touched a connector names the thing, as a
 * link, its glyph before it (decision 87). The raw input stays a hover away.
 */
function StepLabel({ t, ctx, tag = true }: { t: ToolEntry; ctx: ToolCtx; tag?: boolean }) {
  const summary = toolSummary(t.name, t.input, ctx.cwd);
  const what = toolIntent(t.name, t.input);
  const subject = stepSubject(t, ctx.subjects ?? {});
  if (subject)
    return (
      <>
        {what && (
          <span class="what" title={summary !== what ? summary : undefined}>
            {what}
          </span>
        )}
        <SubjectView s={subject} raw={rawInput(t, summary)} ctx={ctx} />
        {tag && <span class="name tag">{toolLabel(t.name)}</span>}
      </>
    );
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

/**
 * A task's row names its card (decision 89): a click opens the card, whether
 * it is a row of its own or a step in a folded run, and scrolls to it. The
 * ask waits in `wanted` for a card that mounts after it (a run just opened).
 */
const wanted = new Set<string>();
const REVEAL = "embarch-reveal-tool";
export function revealTool(id: string): void {
  wanted.add(id);
  window.dispatchEvent(new CustomEvent(REVEAL, { detail: id }));
  const look = (tries: number) =>
    setTimeout(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("[data-tool]")).find((x) => x.dataset.tool === id);
      if (el) {
        wanted.delete(id);
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (tries > 0) look(tries - 1);
      else wanted.delete(id);
    }, 40);
  look(10);
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
  // Claude's question stays as a Questions row, opening to the picks once answered (decision 79).
  const asked = t.name === "AskUserQuestion";
  const answered = asked && t.status === "done";
  const [open, setOpen] = useState<boolean>(editLike || sub || t.name === "TodoWrite" || !!custom || answered || wanted.has(t.id));
  useEffect(() => {
    if (answered) setOpen(true);
  }, [answered]);
  useEffect(() => {
    const on = (ev: Event) => (ev as CustomEvent<string>).detail === t.id && setOpen(true);
    window.addEventListener(REVEAL, on);
    return () => window.removeEventListener(REVEAL, on);
  }, [t.id]);
  const d = editLike ? diffLines(t) : null;
  const bg = backgroundStatus(t);
  // A step that went to the background: its tool result only says so; its output is the task's.
  const output = bg && t.name !== "Agent" && t.name !== "Task";
  return (
    <div class={`tool ${t.status}`} data-tool={t.id}>
      <div class="line" onClick={() => setOpen(!open)}>
        {asked ? <QuestionsLine t={t} /> : <StepLabel t={t} ctx={ctx} />}
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
          ) : asked ? (
            <QuestionsBody t={t} />
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
  useEffect(() => {
    const on = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      if (!steps.some((e) => e.id === id) || openRuns.has(key)) return;
      openRuns.add(key);
      redraw((x) => x + 1);
    };
    window.addEventListener(REVEAL, on);
    return () => window.removeEventListener(REVEAL, on);
  }, [key, steps]);
  const head = runHead(steps);
  const n = runTally(steps);
  const failed = failedText(n);
  // The run's time: since its first step, counting while one runs (68).
  const tools = steps.filter((e): e is ToolEntry => e.kind === "tool");
  const from = tools.find((t) => t.at !== undefined)?.at;
  const to = n.running || n.awaiting ? undefined : Math.max(0, ...tools.map((t) => t.doneAt ?? 0)) || undefined;
  const mover = [...tools].reverse().find(movable);
  // The connectors' things its other steps touched, each once (decision 87).
  const touched = runSubjects(steps, ctx.subjects ?? {});
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
        {head && <StepLabel t={head} ctx={ctx} tag={false} />}
        {touched.shown.length > 0 && (
          <span class="run-subjects">
            {touched.shown.map((s) => (
              <SubjectView key={s.id} s={s} raw="" ctx={ctx} brief />
            ))}
            {touched.more > 0 && <span class="run-more" title={`${touched.more} more`}>+{touched.more}</span>}
          </span>
        )}
        <span class="count">{n.steps} steps</span>
        {failed && <span class="st error">{failed}</span>}
        {!n.awaiting && <Elapsed from={from} to={to} live={!!ctx.live} />}
        {n.awaiting ? <span class="st awaiting">{STATUS.awaiting}</span> : n.running ? <span class="spinner" /> : null}
      </div>
      {/* Reachable folded: the run's latest step that runs in the foreground — parallel calls can leave an earlier one (port item 70); open, the step's own row has it. */}
      {ctx.runInBackground && !open && mover && <RunInBackground toolUseId={mover.id} onMove={ctx.runInBackground} />}
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
