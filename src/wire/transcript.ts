// Claude Code's own transcripts, read as history. Nothing new is stored
// (decision 12): a chat's past is the transcript Claude writes, its name is
// Claude's own `ai-title` until the assistant names chats, and a thread
// another window runs opens read-only from here (decision 31).

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { WireMessage } from "./types";

/**
 * A session id as Claude Code makes them: a UUID. Ids reach this window from
 * the desk and from transcript names, and one goes into a path and onto
 * `claude`'s command line, so anything else is refused.
 */
export function isSessionId(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

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
  if (!isSessionId(sessionId)) return null;
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

/**
 * Lines of a transcript turned into wire messages the reducer folds. `named`:
 * an earlier part of the same transcript held a custom title, so Claude's
 * own ai-titles after it no longer apply (for reading only what was added).
 */
export function transcriptEvents(
  text: string,
  named = false,
): { events: WireMessage[]; meta: Omit<TranscriptMeta, "sessionId" | "file" | "size" | "lastMs"> & { lastTs: number; named: boolean } } {
  const events: WireMessage[] = [];
  let title: string | null = null;
  let custom = named;
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
    // A name given with rename_session (the assistant's, decision 12) wins
    // over Claude's own ai-title, which it renews as it goes.
    if (o.type === "ai-title" && typeof o.aiTitle === "string") {
      if (custom) continue;
      title = o.aiTitle;
      events.push({ type: "_title", title });
      continue;
    }
    if (o.type === "custom-title" && typeof o.customTitle === "string") {
      title = o.customTitle;
      custom = true;
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
  return { events, meta: { cwd, title, firstPrompt, lastTs, named: custom } };
}

/**
 * The complete lines of a transcript from byte `from` on: the text, and the
 * offset after its last newline — a line Claude is still writing is left for
 * the next read.
 */
export function readLines(file: string, from = 0): { text: string; end: number; size: number; mtimeMs: number } {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd);
    const len = Math.max(0, st.size - from);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (!n) break;
      got += n;
    }
    const cut = buf.subarray(0, got).lastIndexOf(10) + 1;
    return { text: buf.subarray(0, cut).toString("utf8"), end: from + cut, size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

const HEAD = 4096;

/**
 * What says a transcript is still the file that was read: its inode, and a
 * hash of its first bytes (up to 4 KB of what was read). An append changes
 * neither; a rewrite — to the same size or a larger one — changes one, and
 * the file is then read again from the start rather than from an offset
 * into text that is no longer there.
 */
export interface FileMark {
  dev: number;
  ino: number;
  len: number;
  hash: string;
}

/** The mark of a file's first `upTo` bytes (at most 4 KB); null when it cannot be read. */
export function markFile(file: string, upTo: number): FileMark | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const st = fs.fstatSync(fd);
      const len = Math.max(0, Math.min(HEAD, upTo, st.size));
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, got);
        if (!n) break;
        got += n;
      }
      return { dev: st.dev, ino: st.ino, len: got, hash: crypto.createHash("sha1").update(buf.subarray(0, got)).digest("hex") };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Whether `file` is still the one `mark` was taken of: only then may a read go on from an offset. */
export function sameFile(file: string, mark: FileMark | null | undefined): boolean {
  if (!mark) return false;
  const now = markFile(file, mark.len);
  return !!now && now.dev === mark.dev && now.ino === mark.ino && now.len === mark.len && now.hash === mark.hash;
}

/** The mark after reading on to `end`: taken again while it covers less than 4 KB, so it grows to its full length. */
export function remark(file: string, mark: FileMark | null, end: number): FileMark | null {
  return mark && (mark.len >= HEAD || end <= mark.len) ? mark : markFile(file, end);
}

export function readTranscript(file: string): { events: WireMessage[]; meta: TranscriptMeta & { named: boolean }; end: number; mtimeMs: number } {
  const r = readLines(file);
  const { events, meta } = transcriptEvents(r.text);
  return {
    events,
    meta: { sessionId: path.basename(file, ".jsonl"), file, cwd: meta.cwd, title: meta.title, firstPrompt: meta.firstPrompt, lastMs: meta.lastTs || r.mtimeMs, size: r.size, named: meta.named },
    end: r.end,
    mtimeMs: r.mtimeMs,
  };
}

/**
 * Title, cwd and age of transcripts. A file read once is read again only
 * from where it ended — a live session's transcript grows every turn, and
 * the largest run to tens of MB.
 */
export class TranscriptIndex {
  private cache = new Map<string, { mtimeMs: number; size: number; end: number; named: boolean; meta: TranscriptMeta; mark: FileMark | null }>();

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
        if (!n.endsWith(".jsonl") || !isSessionId(n.slice(0, -6))) continue;
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
          if (hit && st.size > hit.size && sameFile(file, hit.mark)) {
            // Grown, and still the same file: only what was added.
            const r = readLines(file, hit.end);
            const { meta: add } = transcriptEvents(r.text, hit.named);
            const meta: TranscriptMeta = {
              ...hit.meta,
              cwd: add.cwd ?? hit.meta.cwd,
              title: add.title ?? hit.meta.title,
              firstPrompt: hit.meta.firstPrompt ?? add.firstPrompt,
              lastMs: st.mtimeMs,
              size: r.size,
            };
            this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, end: r.end, named: add.named, meta, mark: remark(file, hit.mark, r.end) });
            out.push(meta);
            continue;
          }
          const { meta, end } = readTranscript(file);
          const m: TranscriptMeta = { sessionId: meta.sessionId, file, cwd: meta.cwd, title: meta.title, firstPrompt: meta.firstPrompt, lastMs: st.mtimeMs, size: meta.size };
          this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, end, named: meta.named, meta: m, mark: markFile(file, end) });
          out.push(m);
        } catch {
          /* unreadable; skip */
        }
      }
    }
    return out;
  }
}
