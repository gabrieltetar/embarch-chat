// Claude's markdown, rendered to Preact nodes — never through innerHTML, so
// whatever HTML a reply carries shows as text. Covers what Claude writes:
// fenced code, headings, lists (nested), quotes, tables, rules, and inline
// code, bold, italic, strike, links. A code span that looks like a file path
// opens the file. A link opens in the browser when it is http(s), as a file
// when it is a path, and not at all otherwise; none carries an href
// (./link.tsx says why). A link's own text holds no other link — a URL, a
// file path or a citation in it is text — so a click opens one thing.
// `inlineHooks` is the seam for atlas citation links (decision 16) and the
// desk's keys and PRs (88): each may turn a run of plain text into nodes,
// and the next one reads the text the one before left as text.

import type { ComponentChildren, VNode } from "preact";
import { memo } from "preact/compat";
import { useRef } from "preact/hooks";
import { Link, hasScheme, isWebLink } from "./link";

export interface MdCtx {
  openLink(url: string): void;
  openFile(path: string, line?: number): void;
}

/** `key`: a prefix for the keys of the nodes it makes, unique among their siblings. */
export type InlineHook = (text: string, ctx: MdCtx, key: string) => ComponentChildren[] | null;
export const inlineHooks: InlineHook[] = [];

const FILE_RE = /^((?:[\w@.~-]+\/)*[\w@.~-]+\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::\d+)?$/;
const INLINE_RE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`])|\*\*([^*\n](?:[\s\S]*?[^*\s])?)\*\*|~~([\s\S]+?)~~|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\w])/g;

function plain(text: string, ctx: MdCtx, key: string, noLinks: boolean): ComponentChildren[] {
  let parts: ComponentChildren[] = [text];
  if (!noLinks) {
    inlineHooks.forEach((hook, h) => {
      parts = parts.flatMap((p, i) => (typeof p === "string" && p ? (hook(p, ctx, `${key}h${h}.${i}.`) ?? [p]) : [p]));
    });
  }
  // Line breaks inside the run stay line breaks.
  const out: ComponentChildren[] = [];
  parts.forEach((p, i) => {
    if (typeof p !== "string") return void out.push(p);
    p.split("\n").forEach((s, k) => {
      if (k) out.push(<br key={`${key}b${i}.${k}`} />);
      if (s) out.push(s);
    });
  });
  return out;
}

/** `noLinks`: inside a link's text, where nothing else may open. */
export function inline(text: string, ctx: MdCtx, key = "i", noLinks = false): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  let n = 0;
  // A fresh instance per call: the recursion below would otherwise move a
  // shared lastIndex under the outer loop.
  const re = new RegExp(INLINE_RE.source, "g");
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > last) out.push(...plain(text.slice(last, m.index), ctx, `${key}p${n}`, noLinks));
    const k = `${key}${n++}`;
    if (m[2] !== undefined) {
      const code = m[2].replace(/^ (.*) $/, "$1");
      const f = FILE_RE.exec(code);
      if (!noLinks && f && (code.includes("/") || /\.(c|h|cpp|hpp|rs|ts|tsx|js|py|md|json|toml|yaml|yml|dts|dtsi|overlay|conf|txt|sh|cmake)$/.test(f[1]))) {
        out.push(
          <code
            key={k}
            class="file"
            title="Open file"
            onClick={(e) => {
              e.stopPropagation();
              ctx.openFile(f[1], f[2] ? Number(f[2]) : undefined);
            }}
          >
            {code}
          </code>,
        );
      } else out.push(<code key={k}>{code}</code>);
    } else if (m[3] !== undefined) {
      const url = m[4];
      const label = inline(m[3], ctx, k, true);
      if (noLinks) out.push(<span key={k}>{label}</span>);
      else if (isWebLink(url))
        out.push(
          <Link key={k} title={url} onOpen={() => ctx.openLink(url)}>
            {label}
          </Link>,
        );
      else if (hasScheme(url))
        // vscode:, mailto:, command:, file: ... — a reply can carry one under
        // innocent text, and nothing but the browser opens from here.
        out.push(
          <span key={k} class="link-refused" title={`Not opened from a reply: ${url}`}>
            {label}
          </span>,
        );
      else
        out.push(
          <Link key={k} title={url} onOpen={() => ctx.openFile(url)}>
            {label}
          </Link>,
        );
    } else if (m[5] !== undefined) {
      const url = m[5];
      if (noLinks) out.push(url);
      else
        out.push(
          <Link key={k} onOpen={() => ctx.openLink(url)}>
            {url}
          </Link>,
        );
    } else if (m[6] !== undefined) out.push(<strong key={k}>{inline(m[6], ctx, k, noLinks)}</strong>);
    else if (m[7] !== undefined) out.push(<s key={k}>{inline(m[7], ctx, k, noLinks)}</s>);
    else if (m[8] !== undefined) out.push(<em key={k}>{inline(m[8], ctx, k, noLinks)}</em>);
    else if (m[9] !== undefined) out.push(<em key={k}>{inline(m[9], ctx, k, noLinks)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(...plain(text.slice(last), ctx, `${key}p${n}`, noLinks));
  return out;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || ITEM.test(line) || QUOTE.test(line);
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div class="codeblock">
      <button class="copy" title="Copy" onClick={() => void navigator.clipboard?.writeText(code)}>
        Copy
      </button>
      <pre>
        <code data-lang={lang}>{code}</code>
      </pre>
    </div>
  );
}

interface Item {
  text: string;
  kids: VNode[];
}

function list(lines: string[], start: number, ctx: MdCtx, key: string): { node: VNode; next: number } {
  const first = ITEM.exec(lines[start])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: Item[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const nx = j < lines.length ? ITEM.exec(lines[j]) : null;
      if (nx && nx[1].length >= base) {
        i = j;
        continue;
      }
      if (j < lines.length && items.length && /^\s+/.test(lines[j]) && (lines[j].match(/^\s*/)?.[0].length ?? 0) > base) {
        i = j;
        continue;
      }
      break;
    }
    if (m) {
      const indent = m[1].length;
      if (indent < base) break;
      if (indent > base && items.length) {
        const sub = list(lines, i, ctx, `${key}-${i}`);
        items[items.length - 1].kids.push(sub.node);
        i = sub.next;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ text: m[3], kids: [] });
      i++;
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (items.length && (indent > base || !isBlockStart(line))) {
      if (FENCE.test(line)) {
        const b = blocks(lines, i, ctx, `${key}-f${i}`, true);
        items[items.length - 1].kids.push(...b.nodes);
        i = b.next;
        continue;
      }
      items[items.length - 1].text += "\n" + line.trim();
      i++;
      continue;
    }
    break;
  }
  const lis = items.map((it, n) => (
    <li key={n}>
      {inline(it.text, ctx, `${key}l${n}`)}
      {it.kids}
    </li>
  ));
  const node = ordered ? (
    <ol key={key} start={Number(/\d+/.exec(first[2])![0])}>
      {lis}
    </ol>
  ) : (
    <ul key={key}>{lis}</ul>
  );
  return { node, next: i };
}

function blocks(lines: string[], start: number, ctx: MdCtx, key: string, one = false): { nodes: VNode[]; next: number } {
  const nodes: VNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const k = `${key}${i}`;
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && lines[i].trim().replace(new RegExp(`^\\${mark[0]}+`), "") === "")) {
        body.push(lines[i].startsWith(fence[1]) ? lines[i].slice(fence[1].length) : lines[i]);
        i++;
      }
      i++;
      nodes.push(<CodeBlock key={k} code={body.join("\n")} lang={fence[3]} />);
      if (one) break;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const Tag = `h${Math.min(6, h[1].length + 2)}` as "h3";
      nodes.push(<Tag key={k}>{inline(h[2], ctx, k)}</Tag>);
      i++;
      continue;
    }
    if (HR.test(line)) {
      nodes.push(<hr key={k} />);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i])![1]), i++;
      nodes.push(<blockquote key={k}>{blocks(body, 0, ctx, `${k}q`).nodes}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i])), i++;
      nodes.push(
        <div class="tablewrap" key={k}>
          <table>
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c, ctx, `${k}h${n}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, n) => (
                    <td key={n}>{inline(r[n] ?? "", ctx, `${k}r${ri}c${n}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (ITEM.test(line)) {
      const l = list(lines, i, ctx, k);
      nodes.push(l.node);
      i = l.next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    if (!para.length) {
      // A line that looked like a block start but was not one: keep it as text.
      para.push(line);
      i++;
    }
    nodes.push(<p key={k}>{inline(para.join("\n"), ctx, k)}</p>);
  }
  return { nodes, next: i };
}

export function Markdown({ text, ctx }: { text: string; ctx: MdCtx }) {
  return <div class="md">{blocks(text.replace(/\r\n/g, "\n").split("\n"), 0, ctx, "m").nodes}</div>;
}

// ------------------------------------------------------------ streaming

/**
 * A streaming reply's finished pieces (decision 85). A piece ends where a
 * line starts at the margin after a blank line, outside a fence and not a
 * list item (a list goes on across blank lines): nothing `blocks` reads
 * looks across such a line, so each piece parsed alone gives the nodes the
 * whole would. Only whole lines are read, each once; a call carries on from
 * the last one while the text only grows.
 */
interface Pieces {
  /** The text read so far, up to `read`. */
  text: string;
  read: number;
  /** Where each piece starts; the last is still open. */
  at: number[];
  /** The finished pieces' text, one fewer than `at`. */
  done: string[];
  fence: string | null;
  blank: boolean;
}

function pieces(text: string, last: Pieces | null): Pieces {
  const p: Pieces = last && text.startsWith(last.text.slice(0, last.read)) ? last : { text, read: 0, at: [0], done: [], fence: null, blank: false };
  p.text = text;
  for (let nl; (nl = text.indexOf("\n", p.read)) >= 0; p.read = nl + 1) {
    const i = p.read;
    const line = text.slice(i, nl);
    if (p.fence) {
      const t = line.trim();
      if (t.startsWith(p.fence) && t.replace(new RegExp(`^\\${p.fence[0]}+`), "") === "") p.fence = null;
    } else if (!line.trim()) p.blank = true;
    else {
      if (p.blank && !/^\s/.test(line) && !ITEM.test(line)) {
        p.done.push(text.slice(p.at[p.at.length - 1], i));
        p.at.push(i);
      }
      p.blank = false;
      const f = FENCE.exec(line);
      if (f) p.fence = f[2];
    }
  }
  return p;
}

const Piece = memo(
  ({ text, ctx }: { text: string; ctx: MdCtx }) => <>{blocks(text.split("\n"), 0, ctx, "m").nodes}</>,
  (a, b) => a.text === b.text && a.ctx === b.ctx,
);

/** A reply still streaming (decision 85): each finished piece is parsed once, and only the open one again on each delta. */
export function LiveMarkdown({ text, ctx }: { text: string; ctx: MdCtx }) {
  const last = useRef<Pieces | null>(null);
  const p = (last.current = pieces(text.replace(/\r\n/g, "\n"), last.current));
  return (
    <div class="md">
      {p.at.map((start, k) => (
        <Piece key={start} text={k < p.done.length ? p.done[k] : p.text.slice(start)} ctx={ctx} />
      ))}
    </div>
  );
}
