// Runs of steps (decision 50): the owner watches the timeline to catch an
// agent heading the wrong way, so a step says what the agent is doing in its
// own words — the call's own one-line `description` — and two or more quiet
// steps in a row fold into one row headed by the latest. Pure, so the node
// tests run it; tools.tsx draws it.

import type { Entry, StreamBlock, ToolEntry } from "../../src/wire/reducer";

/**
 * Tools whose own body is the signal: a diff, the todo list, a question, a
 * plan, a subagent's steps. They stand alone, open as before, and end a run.
 */
const LOUD = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "Agent", "Task"]);

/** Whether a tool folds into a run by its name; a renderer's card (decision 15) is the caller's to exclude. */
export function quietTool(name: string): boolean {
  return !LOUD.has(name);
}

/**
 * What the agent says the call does: its input's `description`, first line.
 * Only Claude Code's own tools carry one as narration (Bash, Agent, Task);
 * an MCP tool's `description` is its own data — an issue's body, say.
 */
export function toolIntent(name: string, input: Record<string, unknown>): string | null {
  if (name.startsWith("mcp__")) return null;
  const d = input.description;
  if (typeof d !== "string") return null;
  const line = d.trim().split("\n", 1)[0].trim();
  return line || null;
}

/** One row of a timeline: an entry on its own, or a run of quiet steps. */
export interface Fold {
  /** The entry's id, or the run's first step's: the row's key, and what the owner's toggle is kept by. */
  key: string;
  /** The entry, or the run's steps with the thinking between them. */
  ids: string[];
  run: boolean;
}

/**
 * Folds a timeline (or a subagent's steps) into rows: two or more quiet
 * tools in a row become one run, with any thinking between them; text, the
 * owner's messages, notes and every other tool end it. A run of one is a
 * plain row, and thinking after a run's last step stays outside it.
 */
export function foldRuns(ids: readonly string[], get: (id: string) => Entry | undefined, quiet: (t: ToolEntry) => boolean): Fold[] {
  const out: Fold[] = [];
  let run: string[] = [];
  let tools = 0;
  const close = () => {
    let end = run.length;
    while (end > 0 && get(run[end - 1])?.kind === "thinking") end--;
    if (tools >= 2) out.push({ key: run[0], ids: run.slice(0, end), run: true });
    else for (const id of run.slice(0, end)) out.push({ key: id, ids: [id], run: false });
    for (const id of run.slice(end)) out.push({ key: id, ids: [id], run: false });
    run = [];
    tools = 0;
  };
  for (const id of ids) {
    const e = get(id);
    if (!e) continue;
    if (e.kind === "tool" && quiet(e)) {
      run.push(id);
      tools++;
    } else if (e.kind === "thinking" && tools > 0) {
      run.push(id);
    } else {
      close();
      out.push({ key: id, ids: [id], run: false });
    }
  }
  close();
  return out;
}

/** A run's steps by status, for its row: a spinner, "waits on you", a red count. */
export function runTally(steps: readonly Entry[]): { steps: number; running: number; awaiting: number; error: number; denied: number } {
  const n = { steps: 0, running: 0, awaiting: 0, error: 0, denied: 0 };
  for (const e of steps) {
    if (e.kind !== "tool") continue;
    n.steps++;
    if (e.status !== "done") n[e.status]++;
  }
  return n;
}

/** The run's red count: "1 error", "2 errors · 1 denied"; empty when nothing failed. */
export function failedText(n: { error: number; denied: number }): string {
  const parts: string[] = [];
  if (n.error) parts.push(`${n.error} error${n.error > 1 ? "s" : ""}`);
  if (n.denied) parts.push(`${n.denied} denied`);
  return parts.join(" · ");
}

/** The step a run is headed by: its latest. */
export function runHead(steps: readonly Entry[]): ToolEntry | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const e = steps[i];
    if (e.kind === "tool") return e;
  }
  return undefined;
}

// ------------------------------------------------------------ streaming

function readString(s: string, i: number): { value: string; end: number } {
  let j = i + 1;
  while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
  const closed = j < s.length;
  let body = s.slice(i + 1, Math.min(j, s.length));
  if (!closed) {
    // A cut escape: a lone backslash, or \u with fewer than four digits.
    const m = /(\\+)(u[0-9a-fA-F]{0,3})?$/.exec(body);
    if (m && m[1].length % 2 === 1) body = body.slice(0, m.index + m[1].length - 1);
  }
  let value: string;
  try {
    value = JSON.parse(`"${body}"`) as string;
  } catch {
    value = body;
  }
  return { value, end: closed ? j + 1 : -1 };
}

/** The end of a number, a literal, an array or an object at `i`; -1 while it is still arriving. */
function skipValue(s: string, i: number): number {
  if (s[i] !== "{" && s[i] !== "[") {
    let j = i;
    while (j < s.length && !/[,}\]\s]/.test(s[j])) j++;
    return j < s.length ? j : -1;
  }
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') {
      const r = readString(s, j);
      if (r.end < 0) return -1;
      j = r.end - 1;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return j + 1;
    }
  }
  return -1;
}

const ws = (s: string, i: number) => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/**
 * A tool call's input while it streams: `partial_json` is a prefix of one
 * JSON object. Its whole members are read, and a string still arriving as
 * far as it has come, named in `open`.
 */
export function partialInput(json: string): { input: Record<string, unknown>; open: string | null } {
  try {
    const whole = JSON.parse(json) as unknown;
    if (whole && typeof whole === "object" && !Array.isArray(whole)) return { input: whole as Record<string, unknown>, open: null };
  } catch {
    // still arriving
  }
  const input: Record<string, unknown> = {};
  let i = json.indexOf("{");
  if (i < 0) return { input, open: null };
  i++;
  for (;;) {
    i = ws(json, i);
    if (json[i] !== '"') break;
    const k = readString(json, i);
    if (k.end < 0) break;
    i = ws(json, k.end);
    if (json[i] !== ":") break;
    i = ws(json, i + 1);
    if (i >= json.length) break;
    if (json[i] === '"') {
      const v = readString(json, i);
      input[k.value] = v.value;
      if (v.end < 0) return { input, open: k.value };
      i = v.end;
    } else {
      const end = skipValue(json, i);
      if (end < 0) break;
      try {
        input[k.value] = JSON.parse(json.slice(i, end));
      } catch {
        // not a value after all; left out
      }
      i = end;
    }
    i = ws(json, i);
    if (json[i] !== ",") break;
    i++;
  }
  return { input, open: null };
}

/**
 * A streaming tool call as the step it is about to be: its input so far, a
 * description only once it has arrived whole, running. It carries the
 * call's own id, so its row is the same one when it lands.
 */
export function liveTool(b: StreamBlock, i: number): ToolEntry {
  const { input, open } = partialInput(b.text);
  if (open === "description") delete input.description;
  return { kind: "tool", id: b.id ?? `live${i}`, name: b.name ?? "tool", input, parent: null, status: "running", children: [] };
}
