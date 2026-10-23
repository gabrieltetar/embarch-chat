// Claude Code's own transcripts, read as history. Nothing new is stored
// (decision 12): a chat's past is the transcript Claude writes, its name is
// Claude's own `ai-title` until the assistant names chats, and a thread
// another window runs opens read-only from here (decision 31).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { WireMessage } from "./types";

export function projectsRoot(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
}

/** Claude Code's folder for a working directory: every non-alphanumeric character becomes '-'. */
export function projectDir(cwd: string, root = projectsRoot()): string {
  return path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function transcriptPath(cwd: string, sessionId: string, root = projectsRoot()): string {
  return path.join(projectDir(cwd, root), `${sessionId}.jsonl`);
}

/** Where a session's transcript is, searching every project folder when its cwd is unknown. */
export function findTranscript(sessionId: string, cwd?: string, root = projectsRoot()): string | null {
  if (cwd) {
    const p = transcriptPath(cwd, sessionId, root);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* no projects folder */
  }
  return null;
}

export interface TranscriptMeta {
  sessionId: string;
  file: string;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastMs: number;
  size: number;
}

/** Lines of a transcript turned into wire messages the reducer folds. */
export function transcriptEvents(text: string): { events: WireMessage[]; meta: Omit<TranscriptMeta, "sessionId" | "file" | "size" | "lastMs"> & { lastTs: number } } {
  const events: WireMessage[] = [];
  let title: string | null = null;
  let cwd: string | null = null;
  let firstPrompt: string | null = null;
  let lastTs = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(ts)) lastTs = Math.max(lastTs, ts);
    if (o.type === "ai-title" && typeof o.aiTitle === "string") {
      title = o.aiTitle;
      events.push({ type: "_title", title });
      continue;
    }
    if (o.type === "custom-title" && typeof o.customTitle === "string") {
      title = o.customTitle;
      events.push({ type: "_title", title });
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant" && o.type !== "system") continue;
    if (o.isSidechain) continue;
    if (typeof o.cwd === "string") cwd = o.cwd;
    if (o.type === "system" && o.subtype !== "compact_boundary") continue;
    if (o.type === "user" && !firstPrompt && !o.isMeta && !o.isSynthetic) {
      const m = o.message as { content?: unknown } | undefined;
      const c = m?.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && b.type === "text" ? b.text : "")).join(" ") : "";
      if (t.trim() && !t.startsWith("<")) firstPrompt = t.trim().slice(0, 200);
    }
    events.push(o as WireMessage);
  }
  return { events, meta: { cwd, title, firstPrompt, lastTs } };
}

export function readTranscript(file: string): { events: WireMessage[]; meta: TranscriptMeta } {
  const text = fs.readFileSync(file, "utf8");
  const st = fs.statSync(file);
  const { events, meta } = transcriptEvents(text);
  return {
    events,
    meta: { sessionId: path.basename(file, ".jsonl"), file, cwd: meta.cwd, title: meta.title, firstPrompt: meta.firstPrompt, lastMs: meta.lastTs || st.mtimeMs, size: st.size },
  };
}

/** Title, cwd and age of transcripts, re-read only when a file changes. */
export class TranscriptIndex {
  private cache = new Map<string, { mtimeMs: number; size: number; meta: TranscriptMeta }>();

  constructor(private root = projectsRoot()) {}

  /** Every transcript in the project folders of `cwds`, newer than `sinceMs`. */
  list(cwds: string[], sinceMs: number): TranscriptMeta[] {
    const out: TranscriptMeta[] = [];
    const dirs = new Set(cwds.map((c) => projectDir(c, this.root)));
    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const file = path.join(dir, n);
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (st.mtimeMs < sinceMs) continue;
        const hit = this.cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          out.push(hit.meta);
          continue;
        }
        try {
          const { meta } = readTranscript(file);
          meta.lastMs = st.mtimeMs;
          this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
          out.push(meta);
        } catch {
          /* unreadable; skip */
        }
      }
    }
    return out;
  }
}
