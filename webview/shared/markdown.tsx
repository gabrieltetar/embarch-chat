// Claude's markdown, rendered to Preact nodes — never through innerHTML, so
// whatever HTML a reply carries shows as text. Covers what Claude writes:
// fenced code, headings, lists (nested), quotes, tables, rules, and inline
// code, bold, italic, strike, links. A code span that looks like a file path
// opens the file. `inlineHooks` is the seam for atlas citation links
// (decision 16): each may turn a run of plain text into nodes.

import type { ComponentChildren, VNode } from "preact";

export interface MdCtx {
  openLink(url: string): void;
  openFile(path: string, line?: number): void;
}

export type InlineHook = (text: string, ctx: MdCtx) => ComponentChildren[] | null;
export const inlineHooks: InlineHook[] = [];

const FILE_RE = /^((?:[\w@.~-]+\/)*[\w@.~-]+\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::\d+)?$/;
const INLINE_RE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"`])|\*\*([^*\n](?:[\s\S]*?[^*\s])?)\*\*|~~([\s\S]+?)~~|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\w])/g;

function plain(text: string, ctx: MdCtx, key: string): ComponentChildren[] {
  for (const hook of inlineHooks) {
    const r = hook(text, ctx);
    if (r) return r;
  }
  const parts = text.split("\n");
  const out: ComponentChildren[] = [];
  parts.forEach((p, i) => {
    if (i) out.push(<br key={`${key}b${i}`} />);
    if (p) out.push(p);
  });
  return out;
}

export function inline(text: string, ctx: MdCtx, key = "i"): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  let n = 0;
  // A fresh instance per call: the recursion below would otherwise move a
  // shared lastIndex under the outer loop.
  const re = new RegExp(INLINE_RE.source, "g");
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > last) out.push(...plain(text.slice(last, m.index), ctx, `${key}p${n}`));
    const k = `${key}${n++}`;
    if (m[2] !== undefined) {
      const code = m[2].replace(/^ (.*) $/, "$1");
      const f = FILE_RE.exec(code);
      if (f && (code.includes("/") || /\.(c|h|cpp|hpp|rs|ts|tsx|js|py|md|json|toml|yaml|yml|dts|dtsi|overlay|conf|txt|sh|cmake)$/.test(f[1]))) {
        out.push(
          <code key={k} class="file" title="Open file" onClick={() => ctx.openFile(f[1], f[2] ? Number(f[2]) : undefined)}>
            {code}
          </code>,
        );
      } else out.push(<code key={k}>{code}</code>);
    } else if (m[3] !== undefined) {
      const url = m[4];
      out.push(
        <a key={k} href={url} onClick={(e) => (e.preventDefault(), /^https?:/.test(url) ? ctx.openLink(url) : ctx.openFile(url))}>
          {inline(m[3], ctx, k)}
        </a>,
      );
    } else if (m[5] !== undefined) {
      const url = m[5];
      out.push(
        <a key={k} href={url} onClick={(e) => (e.preventDefault(), ctx.openLink(url))}>
          {url}
        </a>,
      );
    } else if (m[6] !== undefined) out.push(<strong key={k}>{inline(m[6], ctx, k)}</strong>);
    else if (m[7] !== undefined) out.push(<s key={k}>{inline(m[7], ctx, k)}</s>);
    else if (m[8] !== undefined) out.push(<em key={k}>{inline(m[8], ctx, k)}</em>);
    else if (m[9] !== undefined) out.push(<em key={k}>{inline(m[9], ctx, k)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(...plain(text.slice(last), ctx, `${key}p${n}`));
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
