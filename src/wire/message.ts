// What goes into a message besides the owner's words, built as Claude
// Code's own panel (2.1.309) builds it, so the CLI and Claude read it the
// same way: the editor's selection or open file (decision 60) and a
// terminal's output (58) as text blocks before the text, pasted images as
// image blocks (56), and a long paste named in the line's `inline_pastes`,
// which the CLI wraps in <pasted_content> to tell it from what was typed
// (recorded: test/fixtures/wire/attach.jsonl). Pure: the host builds
// messages with it, the reducer reads them back, the composer cleans
// pastes with it.

/** base64 image data; pasted images ride the wire as image blocks. */
export interface Attachment {
  mediaType: string;
  data: string;
}

/** The image types the API takes, as Claude Code's panel accepts them. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Context sent with a message, shown as a row under it. Paths are absolute, as Claude Code sends them. */
export type ContextItem =
  | { kind: "selection"; path: string; startLine: number; endLine: number; text: string }
  | { kind: "file"; path: string }
  | { kind: "terminal"; name: string; text: string };

/** A user line for the CLI: its content, and the pastes it marks (`inline_pastes`). */
export interface Outgoing {
  content: string | unknown[];
  pastes?: string[];
}

const TAIL = "This may or may not be related to the current task.";

/** Claude Code's own wording for each block: Claude has seen these from the IDE integration. */
export function ideBlock(c: ContextItem): string {
  switch (c.kind) {
    case "selection":
      return `<ide_selection>The user selected the lines ${c.startLine} to ${c.endLine} from ${c.path}:\n${c.text}\n\n${TAIL}</ide_selection>`;
    case "file":
      return `<ide_opened_file>The user opened the file ${c.path} in the IDE. ${TAIL}</ide_opened_file>`;
    case "terminal":
      return `<terminal name="${c.name.replace(/["\n]/g, "_")}">\n${c.text}\n</terminal>`;
  }
}

/** The line's content: context blocks, then images, then the text (none when it is blank: an image alone sends). */
export function outgoing(text: string, images: Attachment[] = [], context: ContextItem[] = [], pastes: string[] = []): Outgoing {
  const marked = pastesIn(text, pastes);
  const extra = marked.length ? { pastes: marked } : {};
  if (!images.length && !context.length) return { content: text, ...extra };
  return {
    content: [
      ...context.map((c) => ({ type: "text", text: ideBlock(c) })),
      ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
      ...(text.trim() ? [{ type: "text", text }] : []),
    ],
    ...extra,
  };
}

const LEAD = [
  {
    re: /^<ide_selection>The user selected the lines (\d+) to (\d+) from ([^\n]*?):\n([\s\S]*?)\n\nThis may or may not be related to the current task\.<\/ide_selection>\n?/,
    item: (m: RegExpExecArray): ContextItem => ({ kind: "selection", path: m[3], startLine: Number(m[1]), endLine: Number(m[2]), text: m[4] }),
  },
  {
    re: /^<ide_opened_file>The user opened the file ([^\n]*?) in the IDE\. This may or may not be related to the current task\.<\/ide_opened_file>\n?/,
    item: (m: RegExpExecArray): ContextItem => ({ kind: "file", path: m[1] }),
  },
  {
    re: /^<terminal name="([^"\n]*)">\n([\s\S]*?)\n<\/terminal>\n?/,
    item: (m: RegExpExecArray): ContextItem => ({ kind: "terminal", name: m[1], text: m[2] }),
  },
];

/**
 * A user message read back (an echo, a transcript): the context blocks it
 * starts with, and the owner's own text with each marked paste unwrapped.
 */
export function readMessage(raw: string): { text: string; context: ContextItem[] } {
  const context: ContextItem[] = [];
  let rest = raw;
  for (let found = true; found; ) {
    found = false;
    for (const l of LEAD) {
      const m = l.re.exec(rest);
      if (!m) continue;
      context.push(l.item(m));
      rest = rest.slice(m[0].length);
      found = true;
    }
  }
  const text = rest.includes("<pasted_content id=") ? rest.replace(/\n{0,2}<pasted_content id="([0-9a-f]{4})">\n([\s\S]*?)\n<\/pasted_content id="\1">\n{0,2}/g, "\n$2\n").trim() : rest;
  return { text, context };
}

/** Whitespace-blind: the CLI's echo of a marked paste moves its line breaks. */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ pastes

/** Claude Code's rule: a paste over 800 characters or over 2 line breaks is marked. */
export function isLongPaste(s: string): boolean {
  return s.length > 800 || (stripInvisible(s).text.match(/\n/g) ?? []).length > 2;
}

const PASTE_MAX = 50000;
const PASTE_MIN = 20;
const PASTES_KEPT = 100;

/** A paste to remember for marking (trimmed, at most 50 000 characters), or null for a short one. */
export function pasteToMark(s: string): string | null {
  const t = s.replace(/\r\n?/g, "\n");
  const trimmed = t.trim();
  return isLongPaste(t) && trimmed.length >= PASTE_MIN ? trimmed.slice(0, PASTE_MAX) : null;
}

/** Adds a paste to the remembered ones, newest last. */
export function rememberPaste(list: string[], p: string): string[] {
  return list.at(-1) === p ? list : [...list.filter((x) => x !== p), p].slice(-PASTES_KEPT);
}

/** The remembered pastes the message still holds; a short one that is the head of a slash command is not marked. */
export function pastesIn(text: string, pastes: string[]): string[] {
  const t = text.trimStart();
  const slash = t.startsWith("/");
  return pastes.filter((p) => text.includes(p) && !(slash && t.startsWith(p) && !isLongPaste(p)));
}

/**
 * Raw image bytes offered as text (the WSL2/WSLg clipboard bridge does
 * this): a NUL, or more than 5% replacement characters in the first 4 KB.
 */
export function looksBinary(s: string): boolean {
  if (s.includes("\0")) return true;
  const head = s.slice(0, 4096);
  if (head.length < 32) return false;
  let bad = 0;
  for (const ch of head) if (ch === "�") bad++;
  return bad / head.length > 0.05;
}

// ------------------------------------------------------------------ invisible characters

/** Claude Code's list of characters that show nothing (format controls, zero widths, bidi, tags, fillers). */
function hidden(cp: number): boolean {
  if (cp < 160) return (cp < 32 && cp !== 9 && cp !== 10) || cp >= 127;
  if (cp < 8192) return cp === 173 || cp === 847 || cp === 1564 || cp === 4447 || cp === 4448 || cp === 6068 || cp === 6069 || (cp >= 6155 && cp <= 6159);
  if (cp < 65536) return (cp >= 8203 && cp <= 8207) || (cp >= 8232 && cp <= 8238) || (cp >= 8288 && cp <= 8303) || cp === 12644 || (cp >= 65024 && cp <= 65039) || cp === 65279 || cp === 65440 || (cp >= 65520 && cp <= 65531);
  return cp === 69759 || (cp >= 78896 && cp <= 78911) || cp === 94180 || (cp >= 113824 && cp <= 113827) || (cp >= 119155 && cp <= 119162) || (cp >= 917504 && cp <= 921599);
}

const is = (re: RegExp, cp: number | undefined) => cp !== undefined && re.test(String.fromCodePoint(cp));
const PICTO = /\p{Extended_Pictographic}/u;
const EMOJI = /\p{Emoji}/u;
const JOINS = /^(?![\p{Script=Latin}\p{Script=Common}])[\p{L}\p{M}]$/u;
const RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const FLAG_TAGS = ["gbeng", "gbsct", "gbwls"];

/**
 * Strips what shows nothing, as Claude Code does to a paste and to a draft
 * before it goes (its changelog, 2.1.2xx): format and tag characters, zero
 * widths, bidi controls, stray variation selectors. A joiner inside an emoji
 * or a script that needs one, a selector after an emoji, a flag's tags and
 * bidi marks in right-to-left text stay. Odd line breaks become \n.
 */
export function stripInvisible(s: string): { text: string; removed: number } {
  // The fast path: printable ASCII, tabs and line feeds only.
  if (!/[^\t\n\x20-\x7e]/.test(s)) return { text: s, removed: 0 };
  const cps = Array.from(s, (c) => c.codePointAt(0)!);
  const out: string[] = [];
  let prev: number | undefined;
  let removed = 0;
  const put = (cp: number) => {
    out.push(String.fromCodePoint(cp));
    prev = cp;
  };
  /** Whether the line around `i` holds right-to-left letters. */
  const rtlLine = (i: number) => {
    let a = i;
    let b = i;
    while (a > 0 && cps[a - 1] !== 10) a--;
    while (b < cps.length && cps[b] !== 10) b++;
    return cps.slice(a, b).some((c) => is(RTL, c));
  };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const next = cps[i + 1];
    // A lone surrogate half.
    if (cp >= 0xd800 && cp <= 0xdfff) {
      removed++;
      continue;
    }
    if (cp === 13 && next === 10) continue;
    if (cp === 11 || cp === 12 || cp === 13 || cp === 133 || cp === 8232 || cp === 8233) {
      put(10);
      removed++;
      continue;
    }
    if (!hidden(cp)) {
      put(cp);
      continue;
    }
    if (cp >= 0xe0061 && cp <= 0xe007a && prev === 0x1f3f4) {
      // A subdivision flag: 🏴, tag letters, the cancel tag.
      let tag = "";
      let j = i;
      while (j < cps.length && cps[j] >= 0xe0061 && cps[j] <= 0xe007a) tag += String.fromCharCode(cps[j++] - 0xe0000);
      if (cps[j] === 0xe007f && FLAG_TAGS.includes(tag)) {
        for (let k = i; k <= j; k++) put(cps[k]);
        i = j;
        continue;
      }
    }
    let keep = false;
    if (cp === 8205 && (is(PICTO, prev) || prev === 0xfe0f || (prev !== undefined && prev >= 0x1f3fb && prev <= 0x1f3ff)) && is(PICTO, next)) keep = true;
    else if (cp === 8204 || cp === 8205) keep = is(JOINS, prev) && is(JOINS, next);
    else if (cp === 0xfe0e || cp === 0xfe0f) keep = is(EMOJI, prev);
    else if (cp >= 0xfe00 && cp <= 0xfe0d) keep = is(/[\p{Script=Han}\p{Sm}]/u, prev);
    else if (cp >= 0xe0100 && cp <= 0xe01ef) keep = is(/\p{Script=Han}/u, prev);
    else if (cp >= 6155 && cp <= 6159) keep = is(/\p{Script=Mongolian}/u, prev);
    else if (cp === 847) keep = is(/\p{M}/u, prev) || is(/\p{M}/u, next);
    else if (cp === 8206 || cp === 8207 || cp === 1564) keep = rtlLine(i);
    if (keep) put(cp);
    else removed++;
  }
  return removed ? { text: out.join(""), removed } : { text: s, removed: 0 };
}

/** Claude Code's notice for what was stripped. */
export function strippedNotice(n: number, where: "pasted" | "review"): string {
  const what = n === 1 ? "Removed 1 invisible character" : `Removed ${n} invisible characters`;
  return where === "pasted" ? `${what} from the pasted text` : `${what} · review and press Enter to send`;
}
