// A file link in a reply, as Claude writes one (decision 93): `src/a.c`,
// `src/a.c:42`, `src/a.c:42:7`, `src/a.c:42-51`, `src/a.c#L42-L51`,
// `~/notes.md`, percent-encoded or not — and where it is on disk. Claude
// names a file from wherever it stood: by its bare name (`hal.c`), from the
// repo it `cd`d into, or from a folder above the chat's (a sibling repo, a
// west workspace's module). This file knows the shapes and the lookups that
// need no VS Code; the host searches the workspace for what they miss.

import * as fs from "fs";
import * as path from "path";

export interface FileTarget {
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
}

/**
 * A link's path and lines. `line`: one the page already split off (a code
 * span's `:42`). Null for an empty link or a URI with a scheme of its own —
 * one letter is a Windows drive, not a scheme.
 */
export function parseFileLink(raw: string, line?: number): FileTarget | null {
  let p = raw.trim();
  if (!p || /^[a-z][a-z0-9+.-]+:/i.test(p)) return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* a lone % is a character of the name */
  }
  const t: FileTarget = { path: p };
  const anchor = /#L(\d+)(?:C(\d+))?(?:-L?(\d+))?$/.exec(p);
  const suffix = anchor ? null : /:(\d+)(?:([:-])(\d+))?$/.exec(p);
  if (anchor) {
    t.path = p.slice(0, anchor.index);
    t.line = Number(anchor[1]);
    if (anchor[2]) t.column = Number(anchor[2]);
    if (anchor[3]) t.endLine = Number(anchor[3]);
  } else if (suffix) {
    t.path = p.slice(0, suffix.index);
    t.line = Number(suffix[1]);
    if (suffix[3]) t[suffix[2] === ":" ? "column" : "endLine"] = Number(suffix[3]);
  } else if (line) t.line = line;
  // A `#heading` anchor in a markdown link opens the file at its top.
  t.path = t.path.replace(/#[^/]*$/, "");
  if (!t.path) return null;
  if (t.endLine !== undefined && t.line !== undefined && t.endLine < t.line) delete t.endLine;
  return t;
}

const exists = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false });

/**
 * Where a link's path is as written: absolute, from `~`, from the chat's
 * folder, or — `up` — from a folder above it, nearest first and no higher
 * than `home`'s parent when the folder is under `home`.
 */
export function resolveFileLink(p: string, cwd: string, home: string, opts: { up?: boolean } = {}): string | null {
  if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
  if (path.isAbsolute(p)) return exists(p) ? path.normalize(p) : null;
  if (!cwd) return null;
  const stop = cwd === home || cwd.startsWith(home + path.sep) ? path.dirname(home) : path.parse(cwd).root;
  for (let d = cwd; ; d = path.dirname(d)) {
    const abs = path.join(d, p);
    if (exists(abs)) return abs;
    if (!opts.up || d === stop || d === path.dirname(d)) return null;
  }
}

/** Tools whose input names the one file they acted on. */
const FILE_KEYS = ["file_path", "notebook_path"];

/**
 * The files the chat's own steps named whose path ends with `p`, whole
 * names only (`main.c` is not `domain.c`), the latest first: what Claude
 * means by a bare `hal.c` is most likely the one it just read or edited.
 */
export function touchedMatches(p: string, inputs: unknown[], cwd: string): string[] {
  const want = path.normalize(p).replace(/^(\.\/)+/, "");
  if (!want || want.startsWith("..") || path.isAbsolute(want)) return [];
  const out: string[] = [];
  for (let i = inputs.length - 1; i >= 0; i--) {
    const input = inputs[i] as Record<string, unknown> | undefined;
    for (const k of FILE_KEYS) {
      const v = input?.[k];
      if (typeof v !== "string" || !v) continue;
      const abs = path.isAbsolute(v) ? path.normalize(v) : path.join(cwd, v);
      if ((abs === want || abs.endsWith(path.sep + want)) && !out.includes(abs)) out.push(abs);
    }
  }
  return out;
}

/** `p` as a literal glob: VS Code's glob syntax gives `[]{}*?` meanings of their own. */
export const globLiteral = (p: string): string => p.replace(/[[\]{}*?]/g, (c) => `[${c}]`);
