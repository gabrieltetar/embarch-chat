// Promptu's pure text helpers, shared by the host and the chat page.

/** `Work on KEY — title`: the rough prompt of a desk Start work pass, the title on one line (embarch-desk decision 67). */
export function startRough(key: string | undefined, title: string | undefined, fallback: string): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (key && t) return `Work on ${key} — ${t}`;
  if (key) return `Work on ${key}`;
  return `Work on ${fallback.replace(/\s+/g, " ").trim()}`;
}

/** The review skill's name as Claude Code types it, plugin then skill (embarch-promptu `docs/contract.md`, "The review skill"): typed unsent in a new chat when the card's weekly line is clicked with a sheet waiting (95). */
export const REVIEW_SKILL = "/embarch-promptu:review";

/** A draft that already went through Promptu: its last line is a footer (contract §6.1). */
export function hasFooter(text: string): boolean {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1]?.startsWith("— promptu ") ?? false;
}
