// A chat's history as the owner works with it (decisions 74 and 75):
// the conversation as plain text, and a name given by hand, appended to the
// transcript Claude writes — nothing new is stored (decision 12).

import * as fs from "fs";
import type { ChatState, Entry } from "./reducer";

/**
 * Names a session Claude Code's own way when no process of it runs: the
 * `custom-title` line its panel appends to the transcript, which wins over
 * Claude's ai-title on every read (decision 12).
 */
export function appendTitle(file: string, sessionId: string, title: string): void {
  const st = fs.statSync(file);
  let lead = "";
  if (st.size > 0) {
    const fd = fs.openSync(file, "r");
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, st.size - 1);
      if (b[0] !== 10) lead = "\n";
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.appendFileSync(file, `${lead}${JSON.stringify({ type: "custom-title", sessionId, customTitle: title })}\n`);
}

const indent = (text: string, first: string, rest: string) =>
  text
    .split("\n")
    .map((l, i) => (i ? rest : first) + l)
    .join("\n");

function summary(input: Record<string, unknown>): string {
  for (const k of ["command", "file_path", "pattern", "path", "url", "description", "prompt"]) {
    if (typeof input[k] === "string") return (input[k] as string).split("\n")[0].slice(0, 120);
  }
  return "";
}

/**
 * The conversation as plain text in the shape of Claude Code's `/export`
 * (❯ the owner, ● Claude): for a chat no process may be started for — a
 * thread this window does not run — or when the CLI cannot give its own.
 */
export function conversationText(s: ChatState): string {
  const out: string[] = [];
  const one = (e: Entry | undefined) => {
    if (!e) return;
    if (e.kind === "user") out.push(indent(e.text, "❯ ", "  "));
    else if (e.kind === "text") out.push(indent(e.text.trim(), "● ", "  "));
    else if (e.kind === "tool") {
      const head = `● ${e.name}(${summary(e.input)})`;
      const res = (e.result ?? "").trim().split("\n")[0]?.slice(0, 200);
      out.push(res ? `${head}\n  ⎿  ${res}` : head);
    } else if (e.kind === "note") out.push(indent(e.text, "  ⎿  ", "     "));
  };
  for (const id of s.timeline) one(s.entries[id]);
  return out.join("\n\n") + "\n";
}

/** The file name `/export` offers: the date and time, and the first prompt. */
export function exportFileName(s: ChatState, now = new Date()): string {
  const first = s.timeline.map((id) => s.entries[id]).find((e) => e?.kind === "user");
  const slug = (first && first.kind === "user" ? first.text : (s.title ?? "conversation"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${slug || "conversation"}.txt`;
}
