// Promptu's pure text helpers, shared by the host and the chat page.

/** `Work on KEY — title`: the rough prompt of a desk Start work pass, the title on one line (embarch-desk decision 67). */
export function startRough(key: string | undefined, title: string | undefined, fallback: string): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (key && t) return `Work on ${key} — ${t}`;
  if (key) return `Work on ${key}`;
  return `Work on ${fallback.replace(/\s+/g, " ").trim()}`;
}

/** A draft that already went through Promptu: its last line is a footer (contract §6.1). */
export function hasFooter(text: string): boolean {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1]?.startsWith("— promptu ") ?? false;
}
