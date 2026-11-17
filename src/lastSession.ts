// Where a dead session stopped, read without parsing its transcript by hand:
// the newest transcript of the previous session in a folder, as its last
// turns, its tool calls and the background work still pending. Read-only;
// `lastSessionTool` is the MCP tool beside `handoff`, and the same function
// serves `node dist/last-session.js` (src/lastSessionCli.ts).

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { McpTool } from "./mcpServer";
import { isSessionId, projectDir, projectsRoot } from "./wire/transcript";

/** A transcript written to this recently, with no session id to rule it out by, is taken as still live. */
export const LIVE_WINDOW_MS = 30_000;
export const DEFAULT_TURNS = 6;
/** A tool call shows its input up to here. */
export const TOOL_INPUT_CHARS = 300;
/** A turn's text shows up to here. */
const TURN_CHARS = 2000;

export interface LastSessionItem {
  kind: "user" | "assistant" | "tool";
  /** The text; for a tool, `Name: input`. */
  text: string;
}

export interface LastSession {
  sessionId: string;
  file: string;
  /** Which folder held it: the cwd's own, or the main clone's. */
  folder: "cwd" | "main-clone";
  items: LastSessionItem[];
  /** Background shells, monitors and agents with no finished notification. */
  pending: string[];
}

export interface LastSessionOpts {
  cwd: string;
  turns?: number;
  root?: string;
  /** The caller's own session: never returned. Without it, a file written within LIVE_WINDOW_MS is skipped instead. */
  currentSessionId?: string;
  now?: number;
}

/** The main clone a worktree belongs to, by `git rev-parse --git-common-dir`; null when cwd is not a worktree of another folder. */
export function mainClone(cwd: string): string | null {
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!common || path.basename(common) !== ".git") return null;
    const main = path.dirname(common);
    return path.resolve(main) === path.resolve(cwd) ? null : main;
  } catch {
    return null;
  }
}

/** The newest transcript in a project folder that is not the caller's own. */
function newestPrevious(dir: string, o: LastSessionOpts): { id: string; file: string } | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const now = o.now ?? Date.now();
  const files = names
    .filter((n) => n.endsWith(".jsonl") && isSessionId(n.slice(0, -6)))
    .map((n) => ({ id: n.slice(0, -6), file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .filter((f) => f.id !== o.currentSessionId)
    .filter((f) => o.currentSessionId !== undefined || now - f.mtime > LIVE_WINDOW_MS)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ?? null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Notifications and reminders are the harness talking, not a turn. */
const harnessText = (t: string) => /^<(task-notification|system-reminder|command-|local-command|user-prompt-submit-hook)/.test(t.trimStart());

/** Background work a transcript started and never saw finish. */
const FINISHED = /<status>(completed|failed|killed|stopped|cancelled)<\/status>/;

export function lastTurns(text: string, turns: number): { items: LastSessionItem[]; pending: string[] } {
  const items: LastSessionItem[] = [];
  const started = new Map<string, string>();
  const done = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "attachment") {
      const p = o.attachment?.type === "queued_command" ? o.attachment.prompt : null;
      if (typeof p === "string") noteNotification(p, done);
      continue;
    }
    if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain || o.isMeta) continue;
    const c = o.message?.content;
    const blocks: any[] = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (o.type === "user" && harnessText(b.text)) {
          noteNotification(b.text, done);
          continue;
        }
        items.push({ kind: o.type, text: clip(b.text.trim(), TURN_CHARS) });
      } else if (b?.type === "tool_use" && typeof b.name === "string") {
        const input = JSON.stringify(b.input ?? {});
        items.push({ kind: "tool", text: `${b.name}: ${clip(input, TOOL_INPUT_CHARS)}` });
        if (b.input?.run_in_background === true || b.name === "Monitor") started.set(String(b.id), `${b.name}: ${clip(String(b.input?.description ?? b.input?.command ?? input), 120)}`);
      } else if (b?.type === "tool_result" && typeof b.content === "string") {
        noteNotification(b.content, done);
      }
    }
  }
  const pending = [...started].filter(([id]) => !done.has(id)).map(([, d]) => d);
  // Keep from the Nth-from-last text turn on, with the tool calls between.
  let seen = 0;
  let from = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind !== "tool" && ++seen === turns) {
      from = i;
      break;
    }
  }
  return { items: items.slice(from), pending };
}

function noteNotification(text: string, done: Set<string>): void {
  for (const m of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m[0])?.[1];
    if (id && FINISHED.test(m[0])) done.add(id);
  }
}

/** The previous session in `cwd`: its own folder first, then its main clone's. Null when there is none. */
export function lastSession(o: LastSessionOpts): LastSession | null {
  const root = o.root ?? projectsRoot();
  const turns = Math.max(1, Math.floor(o.turns ?? DEFAULT_TURNS));
  const tries: Array<["cwd" | "main-clone", string]> = [["cwd", o.cwd]];
  const main = mainClone(o.cwd);
  if (main) tries.push(["main-clone", main]);
  for (const [folder, dir] of tries) {
    const hit = newestPrevious(projectDir(dir, root), o);
    if (!hit) continue;
    return { sessionId: hit.id, file: hit.file, folder, ...lastTurns(fs.readFileSync(hit.file, "utf8"), turns) };
  }
  return null;
}

export function formatLastSession(s: LastSession | null): string {
  if (!s) return "No previous session found for this folder.";
  const out = [`Previous session ${s.sessionId} (${s.folder === "cwd" ? "this folder" : "the main clone's folder"}), oldest first:`, ""];
  for (const i of s.items) out.push(i.kind === "tool" ? `[tool] ${i.text}` : `[${i.kind}] ${i.text}`, "");
  out.push(s.pending.length ? `Still pending when it stopped:\n${s.pending.map((p) => `- ${p}`).join("\n")}` : "Nothing pending when it stopped.");
  return out.join("\n");
}

export const LAST_SESSION_TOOL: Omit<McpTool, "call"> = {
  name: "last_session",
  description:
    "Read where the previous session in this folder stopped, when it died without a handoff: its last user and assistant turns, its tool calls (name and the start of the input), and background tasks still pending. Read-only. Never returns this session. `cwd` defaults to this chat's folder and may be a worktree; its main clone's sessions are tried next.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "A repo or worktree folder; default this chat's." },
      turns: { type: "number", description: `How many user and assistant turns, default ${DEFAULT_TURNS}.` },
    },
    additionalProperties: false,
  },
  annotations: { title: "Read the previous session", readOnlyHint: true },
};

/** The tool's call for a chat in `cwd` running as `sessionId`. */
export function lastSessionCall(cwd: string, sessionId: string | undefined, root?: string): (args: Record<string, unknown>) => Promise<string> {
  return async (args) =>
    formatLastSession(
      lastSession({
        cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : cwd,
        turns: typeof args.turns === "number" ? args.turns : undefined,
        currentSessionId: sessionId,
        root,
      }),
    );
}
