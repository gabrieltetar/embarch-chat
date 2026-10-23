// The repo's embarch-atlas, as far as citation links need it (decision 16):
// which doc ids and board labels exist, and which file a citation opens —
// `<doc_id> p<N>` that page's text (`docs/<doc_id>/pages/pNNN.txt`, the card
// when the page has none), `<board>:<ref>` the line naming it in the board's
// nets or parts.

import * as fs from "fs";
import * as path from "path";

export interface AtlasInfo {
  root: string;
  docs: string[];
  boards: string[];
}

const cache = new Map<string, { at: number; info: AtlasInfo | null }>();

/** The nearest `embarch/atlas` at or above `cwd`. */
export function atlasRoot(cwd: string): string | null {
  let d = cwd;
  for (let i = 0; i < 12 && d && d !== path.dirname(d); i++, d = path.dirname(d)) {
    const a = path.join(d, "embarch", "atlas");
    if (fs.existsSync(path.join(a, "docs")) || fs.existsSync(path.join(a, "boards"))) return a;
  }
  return null;
}

function dirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function atlasInfo(cwd: string): AtlasInfo | null {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < 60000) return hit.info;
  const root = atlasRoot(cwd);
  const info = root ? { root, docs: dirs(path.join(root, "docs")), boards: dirs(path.join(root, "boards")) } : null;
  cache.set(cwd, { at: Date.now(), info });
  return info;
}

export interface AtlasTarget {
  file: string;
  line?: number;
}

/** The file (and line) a citation opens, or null when the atlas has nothing for it. */
export function citationTarget(info: AtlasInfo, c: { doc?: string; page?: number; board?: string; ref?: string }): AtlasTarget | null {
  if (c.doc && info.docs.includes(c.doc)) {
    const dir = path.join(info.root, "docs", c.doc);
    if (c.page) {
      const page = path.join(dir, "pages", `p${String(c.page).padStart(3, "0")}.txt`);
      if (fs.existsSync(page)) return { file: page };
    }
    const card = path.join(dir, "card.md");
    return fs.existsSync(card) ? { file: card } : null;
  }
  if (c.board && c.ref && info.boards.includes(c.board)) {
    const dir = path.join(info.root, "boards", c.board);
    const want = new RegExp(`(^|[^\\w])${c.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`);
    for (const name of ["nets.md", "parts.md"]) {
      const f = path.join(dir, name);
      let text: string;
      try {
        text = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      const i = lines.findIndex((l) => want.test(l));
      if (i >= 0) return { file: f, line: i + 1 };
    }
    const nets = path.join(dir, "nets.md");
    return fs.existsSync(nets) ? { file: nets } : null;
  }
  return null;
}
