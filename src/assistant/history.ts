// The owner's own prompts of the last 30 days, for the instant wave's prefix
// match (decision 26): the top-level user text of Claude Code's transcripts,
// `~/.claude/projects/*/*.jsonl` (`~/.claude/history.jsonl` holds only the
// terminal's). Read at runtime and kept in memory only — never written
// anywhere, never sent to a model. Transcripts only grow, so each is read
// once and then from where the last read stopped.

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { projectsRoot } from "../wire/transcript";
import { readMessage } from "../wire/message";
import type { PastPrompt } from "./edits";

const DAY = 86_400_000;
const MAX_LEN = 400;
const CHUNK = 1 << 20;

interface FileState {
  size: number;
  offset: number;
  mtimeMs: number;
  prompts: Array<{ text: string; ms: number }>;
}

function stripTags(s: string): string {
  // IDE context, a terminal's output and reminders the panel adds around
  // what the owner typed; a paste the CLI marked, unwrapped (56, 58).
  return readMessage(s).text.replace(/<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g, "").trim();
}

/** The text the owner typed, from one transcript line, or null when the line is not a prompt of theirs. */
export function humanPrompt(o: Record<string, unknown>): string | null {
  if (o.type !== "user" || o.isMeta || o.isSidechain || o.isCompactSummary || o.isVisibleInTranscriptOnly) return null;
  const origin = o.origin as { kind?: string } | undefined;
  if (origin) {
    if (origin.kind !== "human") return null;
  } else if (o.turnOrigin !== undefined && o.turnOrigin !== "human") return null;
  if (o.promptSource === "system") return null;
  const content = (o.message as { content?: unknown } | undefined)?.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b && (b as { type?: string }).type === "tool_result")) return null;
    text = content
      .filter((b) => b && (b as { type?: string }).type === "text")
      .map((b) => String((b as { text?: unknown }).text ?? ""))
      .filter((t) => !t.trimStart().startsWith("<"))
      .join("\n");
  } else return null;
  // A slash command the owner typed reads as they typed it.
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
    text = `${name.startsWith("/") ? name : "/" + name}${args.trim() ? " " + args.trim() : ""}`;
  }
  text = stripTags(text);
  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted") || text.length > MAX_LEN) return null;
  return text;
}

/** Events: `changed` (the list moved). */
export class PromptHistory extends EventEmitter {
  private files = new Map<string, FileState>();
  private cached: PastPrompt[] = [];
  private running: Promise<void> | null = null;
  /** Bumped whenever the list changes, so a page gets it again only then. */
  version = 0;

  constructor(
    private root = projectsRoot(),
    private days = 30,
  ) {
    super();
  }

  /** The deduplicated prompts, most-sent first, then most recent; at most `limit`. */
  prompts(): PastPrompt[] {
    return this.cached;
  }

  /** Reads what is new since the last refresh. One at a time. */
  refresh(limit = 3000): Promise<void> {
    if (!this.running) this.running = this.scan(limit).finally(() => (this.running = null));
    return this.running;
  }

  private async scan(limit: number): Promise<void> {
    const since = Date.now() - this.days * DAY;
    const seen = new Set<string>();
    let dirs: string[] = [];
    try {
      dirs = await fs.promises.readdir(this.root);
    } catch {
      /* no transcripts */
    }
    for (const d of dirs) {
      let names: string[];
      try {
        names = await fs.promises.readdir(path.join(this.root, d));
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const file = path.join(this.root, d, n);
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(file);
        } catch {
          continue;
        }
        if (!st.isFile() || st.mtimeMs < since) continue;
        seen.add(file);
        await this.readFile(file, st);
      }
    }
    for (const f of [...this.files.keys()]) if (!seen.has(f)) this.files.delete(f);
    const agg = new Map<string, PastPrompt>();
    for (const fsx of this.files.values()) {
      for (const p of fsx.prompts) {
        if (p.ms < since) continue;
        const a = agg.get(p.text);
        if (a) {
          a.n++;
          a.lastMs = Math.max(a.lastMs, p.ms);
        } else agg.set(p.text, { text: p.text, n: 1, lastMs: p.ms });
      }
    }
    const next = [...agg.values()].sort((a, b) => b.n - a.n || b.lastMs - a.lastMs).slice(0, limit);
    if (JSON.stringify(next) !== JSON.stringify(this.cached)) {
      this.cached = next;
      this.version++;
      this.emit("changed");
    }
  }

  private async readFile(file: string, st: fs.Stats): Promise<void> {
    let s = this.files.get(file);
    if (s && st.size === s.size && st.mtimeMs === s.mtimeMs) return;
    if (!s || st.size < s.offset) {
      s = { size: 0, offset: 0, mtimeMs: 0, prompts: [] };
      this.files.set(file, s);
    }
    const fh = await fs.promises.open(file, "r");
    try {
      let pos = s.offset;
      let carry = Buffer.alloc(0);
      const buf = Buffer.allocUnsafe(CHUNK);
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        let nl: number;
        while ((nl = data.indexOf(10, start)) >= 0) {
          this.line(data, start, nl, s);
          start = nl + 1;
        }
        carry = Buffer.from(data.subarray(start));
      }
      // An unfinished last line is read again next time.
      s.offset = pos - carry.length;
      s.size = st.size;
      s.mtimeMs = st.mtimeMs;
    } finally {
      await fh.close();
    }
  }

  private line(data: Buffer, a: number, b: number, s: FileState): void {
    // Cheap filters before parsing: a user line, not a tool result.
    const head = data.toString("utf8", a, Math.min(b, a + 400));
    if (!head.includes('"type":"user"') && !data.subarray(a, b).includes('"type":"user"')) return;
    const line = data.toString("utf8", a, b);
    if (line.includes('"tool_use_id"')) return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const text = humanPrompt(o);
    if (!text) return;
    const ms = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    s.prompts.push({ text, ms: Number.isNaN(ms) ? Date.now() : ms });
  }
}
