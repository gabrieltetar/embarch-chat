// The linker's atlas sources (decisions 114, 115): every section of every
// translated document, every Kconfig symbol and every devicetree node the
// repo's embarch-atlas holds, read
// with `embarch-atlas refs --json` (embarch-atlas's `atlas_refs` document) in
// the chat's folder. Gated: offered by words only when the draft carries a cue
// word, or names a document's part (then that document's sections alone); the
// symbols and nodes are gated by their own cue words (115). The
// verb is run again only when the atlas's `current.json`, `atlases/` or `docs/`
// changed since, checked by a stat before a cards call. The parsing and the
// source are pure, so the node tests run them.

import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import { atlasRoot } from "../atlas";
import { findBinary } from "../promptu/cli";
import { chatEnv } from "../wire/process";
import { RefEntry, RefSource, clipTitle, significantWords } from "./refsBase";

/** The verb gets this long. */
export const ATLAS_TIMEOUT_MS = 10_000;
/** Sections read: a larger atlas is cut, not slowed. */
export const SECTIONS_MAX = 20_000;
/** The verb's output is read to this size. */
const OUT_CAP = 64 * 1024 * 1024;
/** The longest page a citation link matches (`webview/chat/atlas.tsx`). */
const PAGE_MAX = 9999;
/** A doc id or section id longer than this, or one writing would change, is not offered. */
const ID_CAP = 120;
/** A node's path longer than this is not offered. */
const PATH_CAP = 200;
/** What a symbol's or node's card says when the atlas is at an older commit than the repo's (`stale` not empty). */
export const STALE_NOTE = "the atlas is at an older commit";

/** The words that open the gate (whole word, any case; a phrase is matched whole). */
export const ATLAS_CUES = ["datasheet", "spec", "specification", "standard", "section", "chapter", "table", "manual", "errata", "app note"];

export interface AtlasSection {
  doc: string;
  part: string | null;
  id: string;
  title: string;
  page: number;
}

export interface AtlasSymbol {
  name: string;
  prompt: string | null;
}

export interface AtlasNode {
  path: string;
  labels: string[];
  compats: string[];
  aliases: string[];
}

/** What `embarch-atlas refs --json` holds, as far as the linker reads it. */
export interface AtlasDoc {
  sections: AtlasSection[];
  symbols: AtlasSymbol[];
  nodes: AtlasNode[];
  /** Whether an atlas is built: symbols and nodes come from it alone, sections from the documents. */
  built: boolean;
  /** Why the atlas is behind the repo; empty when it is not. */
  stale: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(s)}(?![\\p{L}\\p{N}_])`, "iu");

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** An `atlas_refs` document; null when it is not one. A section with no doc, id, title or page, a symbol with no name and a node with no path is dropped. */
export function parseRefs(out: string): AtlasDoc | null {
  let doc: unknown;
  try {
    doc = JSON.parse(out);
  } catch {
    return null;
  }
  const d = doc as { atlas_refs?: unknown; sections?: unknown; symbols?: unknown; nodes?: unknown; atlas?: unknown; stale?: unknown };
  if (!d || typeof d !== "object" || d.atlas_refs !== 1 || !Array.isArray(d.sections)) return null;
  const sections: AtlasSection[] = [];
  for (const s of d.sections.slice(0, SECTIONS_MAX)) {
    if (!s || typeof s !== "object") continue;
    const { doc: id, part, id: sec, title, page } = s as Record<string, unknown>;
    if (typeof id !== "string" || typeof sec !== "string" || typeof title !== "string" || typeof page !== "number") continue;
    sections.push({ doc: id, part: typeof part === "string" && part ? part : null, id: sec, title, page });
  }
  const symbols: AtlasSymbol[] = [];
  for (const s of Array.isArray(d.symbols) ? d.symbols.slice(0, SECTIONS_MAX) : []) {
    const { name, prompt } = (s ?? {}) as Record<string, unknown>;
    if (typeof name === "string" && name) symbols.push({ name, prompt: typeof prompt === "string" && prompt ? prompt : null });
  }
  const nodes: AtlasNode[] = [];
  for (const n of Array.isArray(d.nodes) ? d.nodes.slice(0, SECTIONS_MAX) : []) {
    const { path: p, labels, compats, aliases } = (n ?? {}) as Record<string, unknown>;
    if (typeof p === "string" && p) nodes.push({ path: p, labels: strings(labels), compats: strings(compats), aliases: strings(aliases) });
  }
  return { sections, symbols, nodes, built: typeof d.atlas === "string" && !!d.atlas, stale: strings(d.stale) };
}

/** The `sections` of an `atlas_refs` document; null when it is not one. */
export function parseSections(out: string): AtlasSection[] | null {
  return parseRefs(out)?.sections ?? null;
}

/** A doc id or section id exactly as the atlas has it, or null when writing it would change it. */
const exact = (s: string): string | null => (s && clipTitle(s, ID_CAP) === s && !/\s/.test(s) ? s : null);

const cueWords = new Set(ATLAS_CUES.filter((c) => !c.includes(" ")));

/** The sections as a source: `<doc_id> p<page> §<id> "<title>"`, the head being what decision 16's citation links match. Gated. */
export function atlasSource(sections: AtlasSection[] | null, draft: string): RefSource | null {
  if (!sections?.length) return null;
  const cued = ATLAS_CUES.some((c) => word(c).test(draft));
  const named = new Set(sections.filter((s) => s.part && word(s.part).test(draft)).map((s) => s.doc));
  const pool = cued ? sections : sections.filter((s) => named.has(s.doc));
  const entries: RefEntry[] = [];
  for (const s of pool) {
    const doc = exact(s.doc);
    const id = exact(s.id);
    const title = clipTitle(s.title);
    if (!doc || !id || !title || !Number.isInteger(s.page) || s.page < 1 || s.page > PAGE_MAX) continue;
    const text = `${doc} p${s.page} §${id} "${title}"`;
    const words = new Set([...significantWords(`${title} ${id.split(/[^A-Za-z0-9]+/).join(" ")}`)].filter((w) => !cueWords.has(w)));
    entries.push({ kind: "section", key: `${s.doc}#${s.id}`, words, names: [], line: text, text: () => text, titles: [title] });
  }
  // Named but no cue word: the document's part opened the gate, so its words match without one.
  return entries.length ? { entries, ...(cued ? { cues: ATLAS_CUES } : {}) } : null;
}

/** The words that open the symbols' gate (whole word, any case); a symbol's own name opens it alone. */
export const KCONFIG_CUES = ["kconfig", "config", "option", "symbol", "setting", "prj.conf", "menuconfig"];
/** The words that open the nodes' gate. */
export const DT_CUES = ["devicetree", "dt", "node", "overlay", "dts", "binding", "compatible", "alias", "chosen"];

const wordsOf = (cues: string[]) => new Set(cues.filter((c) => !c.includes(".")));
const kconfigCueWords = wordsOf(KCONFIG_CUES);
const dtCueWords = wordsOf(DT_CUES);
const SYMBOL_NAME = /^[A-Za-z0-9_]+$/;
/** A Kconfig name a draft writes bare: capitals with an underscore, at its word's edges. */
const BARE_SYMBOL = /(?<![\p{L}\p{N}_])[A-Z][A-Z0-9]*_[A-Z0-9_]*(?![\p{L}\p{N}_])/gu;

/** The entries of a doc's symbols or nodes depend on the doc alone, so they are built once per read: the matcher's word counts are kept per array. */
const built = new WeakMap<AtlasDoc, { symbols?: RefEntry[]; nodes?: RefEntry[] }>();
const cache = (doc: AtlasDoc, kind: "symbols" | "nodes", make: () => RefEntry[]): RefEntry[] => {
  const slot = built.get(doc) ?? {};
  built.set(doc, slot);
  return (slot[kind] ??= make());
};

/** The symbols as a source: `CONFIG_<NAME> ("<prompt>")`, no value (the atlas's is its commit's). Gated; the bare `<NAME>` in capitals with an underscore, or `CONFIG_<NAME>`, offers it with no cue word. */
export function kconfigSource(doc: AtlasDoc | null): RefSource | null {
  if (!doc?.built || !doc.symbols.length) return null;
  const note = doc.stale.length ? STALE_NOTE : undefined;
  const entries = cache(doc, "symbols", () => {
    const out: RefEntry[] = [];
    for (const s of doc.symbols) {
      const name = s.name.replace(/^CONFIG_/, "");
      if (!name || name.length > ID_CAP || !SYMBOL_NAME.test(name)) continue;
      const prompt = s.prompt ? clipTitle(s.prompt) : "";
      const text = prompt ? `CONFIG_${name} ("${prompt}")` : `CONFIG_${name}`;
      const words = new Set([...significantWords(prompt)].filter((w) => !kconfigCueWords.has(w)));
      out.push({ kind: "symbol", key: name, words, names: [`CONFIG_${name}`], line: text, text: () => text, ...(prompt ? { titles: [prompt] } : {}), ...(note ? { note } : {}) });
    }
    return out;
  });
  const byName = new Map(entries.map((e) => [e.key, e]));
  const find = (d: string) => {
    const hit: RefEntry[] = [];
    for (const m of d.matchAll(BARE_SYMBOL)) {
      const e = byName.get(m[0]);
      if (e && !hit.includes(e)) hit.push(e);
    }
    return hit;
  };
  return entries.length ? { entries, cues: KCONFIG_CUES, find } : null;
}

/** The last part of a node's path with its unit address dropped: `/soc/i2c@40004000` is `i2c`. */
const nodeName = (p: string) => (p.split("/").pop() ?? "").split("@")[0];

/** The nodes as a source: `&<label> (<path>, <compatible>)`, the path alone when the node has no label. Gated; a label (bare or `&`), an alias or a path the draft names offers it with no cue word. */
export function dtSource(doc: AtlasDoc | null): RefSource | null {
  if (!doc?.built || !doc.nodes.length) return null;
  const note = doc.stale.length ? STALE_NOTE : undefined;
  const entries = cache(doc, "nodes", () => {
    const out: RefEntry[] = [];
    for (const n of doc.nodes) {
      const p = clipTitle(n.path, PATH_CAP);
      const label = n.labels.map((l) => exact(l)).find((l) => l) ?? null;
      const compat = n.compats.map((c) => clipTitle(c, ID_CAP)).find((c) => c) ?? "";
      if (!p || p !== n.path || /\s/.test(p)) continue;
      const text = label ? `&${label} (${[p, compat].filter(Boolean).join(", ")})` : p;
      const raw = [...n.labels, nodeName(n.path), ...n.compats.flatMap((c) => c.split(/[,-]/))].join(" ");
      const words = new Set([...significantWords(raw)].filter((w) => !dtCueWords.has(w)));
      const names = [...n.labels.flatMap((l) => (exact(l) ? [`&${l}`, l] : [])), ...n.aliases.filter((a) => exact(a)), n.path];
      out.push({ kind: "node", key: n.path, words, names, line: text, text: () => text, ...(note ? { note } : {}) });
    }
    return out;
  });
  return entries.length ? { entries, cues: DT_CUES } : null;
}

interface Read {
  /** The atlas's change stamp when the verb last ran. */
  stamp: string;
  doc: AtlasDoc | null;
  /** The cause last logged: the same cause is logged once. */
  logged: string | null;
}

/** What changes when the atlas does: the mtimes of `current.json`, `atlases/` and `docs/`. */
function stamp(root: string): string {
  return ["current.json", "atlases", "docs"]
    .map((n) => {
      try {
        return fs.statSync(path.join(root, n)).mtimeMs;
      } catch {
        return "-";
      }
    })
    .join("/");
}

type RunResult = { ok: true; out: string } | { ok: false; error: string };

function run(bin: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(bin, ["refs", "--json"], { cwd, env: chatEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: `could not start: ${(e as Error).message}` });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: `took over ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (e) => finish({ ok: false, error: `could not start: ${e.message}` }));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      out += d;
      if (out.length > OUT_CAP) {
        child.kill();
        finish({ ok: false, error: "printed more than it is read" });
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (err = (err + d).slice(-2000)));
    child.on("close", (code) => {
      if (code !== 0) return finish({ ok: false, error: `failed (exit ${code ?? "killed"})${err.trim() ? `: ${err.trim().split("\n")[0]}` : ""}` });
      finish({ ok: true, out });
    });
  });
}

/** Reads the repo's atlas sections, again only when the atlas changed; no binary, no atlas or a failed run leaves the kind empty and logs once per cause. */
export class AtlasRefs {
  private reads = new Map<string, Read>();
  private busy = new Map<string, Promise<void>>();
  /** Runs of the verb, for the tests: two cards calls with no change make one. */
  spawns = 0;

  /** The last read for a folder; null before the first or after a failed one. */
  get(folder: string): AtlasSection[] | null {
    return this.reads.get(folder)?.doc?.sections ?? null;
  }

  /** The last read, whole: sections, symbols and nodes. */
  doc(folder: string): AtlasDoc | null {
    return this.reads.get(folder)?.doc ?? null;
  }

  /** Reads when the atlas changed since the last read; calls in the meantime wait for the one running. */
  refresh(folder: string, bin: string, log: (s: string) => void, timeoutMs = ATLAS_TIMEOUT_MS): Promise<void> {
    if (!folder) return Promise.resolve();
    const running = this.busy.get(folder);
    if (running) return running;
    const p = this.read(folder, bin, log, timeoutMs).finally(() => this.busy.delete(folder));
    this.busy.set(folder, p);
    return p;
  }

  private async read(folder: string, bin: string, log: (s: string) => void, timeoutMs: number): Promise<void> {
    const prev = this.reads.get(folder);
    const fail = (cause: string, why: string, st: string) => {
      if (prev?.logged !== cause) log(`references: ${why}; nothing from the atlas is offered`);
      this.reads.set(folder, { stamp: st, doc: null, logged: cause });
    };
    const root = atlasRoot(folder);
    if (!root) return fail("no-atlas", `no atlas for ${folder}`, "");
    const st = stamp(root);
    const exe = findBinary(bin);
    // A stamp unchanged and the last read good (or failed for the same atlas and binary) is not read again.
    if (prev && prev.stamp === `${st}|${exe ?? ""}`) return;
    const key = `${st}|${exe ?? ""}`;
    if (!exe) return fail("no-binary", `embarch-atlas is not installed here (${bin}): set embarchChat.atlasPath, or put it on PATH`, key);
    this.spawns++;
    const r = await run(exe, folder, timeoutMs);
    if (!r.ok) return fail(`run:${r.error}`, `embarch-atlas refs ${r.error}`, key);
    const doc = parseRefs(r.out);
    if (!doc) return fail("bad-json", "embarch-atlas refs printed no atlas_refs document", key);
    this.reads.set(folder, { stamp: key, doc, logged: null });
  }
}
