// A tool call in the timeline: one line (name, what it acts on, status),
// opening into its input and result. Edit and Write show their change as a
// diff that opens VS Code's diff editor on a click (decision 8); a subagent's
// own steps nest under its call. `toolRenderers` is the seam for bench
// result cards (decision 15).

import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Entry, ToolEntry } from "../../src/wire/reducer";
import { Markdown, MdCtx } from "../shared/markdown";

export interface ToolCtx extends MdCtx {
  openDiff(toolId: string): void;
  cwd: string;
}

/** A custom body for a tool by name — bench cards plug in here. */
export type ToolRenderer = (t: ToolEntry, ctx: ToolCtx) => ComponentChildren | null;
export const toolRenderers: ToolRenderer[] = [];

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
  const [open, setOpen] = useState<boolean>(editLike || sub || t.name === "TodoWrite");
  const d = editLike ? diffLines(t) : null;
  const custom = toolRenderers.map((r) => r(t, ctx)).find((x) => x);
  return (
    <div class={`tool ${t.status}`}>
      <div class="line" onClick={() => setOpen(!open)}>
        <span class="name">{toolLabel(t.name)}</span>
        <span class="summary" title={toolSummary(t.name, t.input, ctx.cwd)}>
          {toolSummary(t.name, t.input, ctx.cwd)}
        </span>
        {d && (
          <span class="diffstat">
            <span class="a">+{d.add}</span> <span class="d">−{d.del}</span>
          </span>
        )}
        {t.status === "running" ? <span class="spinner" /> : <span class={`st ${t.status}`}>{STATUS[t.status]}</span>}
      </div>
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
              {t.children.map((id) => entries[id] && <div key={id}>{render(entries[id])}</div>)}
              {t.result && t.status !== "running" && <Markdown text={t.result} ctx={ctx} />}
            </div>
          ) : (
            <>
              {t.name === "Bash" ? <pre class="out">$ {String(t.input.command ?? "")}</pre> : <pre class="out">{JSON.stringify(t.input, null, 2)}</pre>}
              {t.result !== undefined && <Result text={t.result} />}
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
