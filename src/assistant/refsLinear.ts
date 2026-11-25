// The linker's Linear project and document sources (decision 117): the
// projects and documents of the desk's reference index (`GET /refs`), mirrored
// by the host like its issues and PRs, so nothing is fetched here and nothing
// runs on a keystroke. A project's name and a document's title are anyone's to
// write: each is clipped and quoted, and rides in `titles` so a card other
// than a reference card cannot copy it into a draft. Pure.

import type { IndexDocument, IndexProject, RefIndex } from "../desk/client";
import { RefEntry, RefSource, clipTitle, significantWords } from "./refsBase";

/** The words that open the documents' gate (whole word, any case); a document's URL opens it alone. */
export const DOCUMENT_CUES = ["doc", "docs", "document", "documents", "notes", "write-up", "spec", "specs", "design", "RFC", "page", "pages"];

const URL_CAP = 300;
const NAME_CAP = 90;

const cueWords = significantWords(DOCUMENT_CUES.join(" "));

/** A link exactly as the desk has it, or null when writing it would change it or it is not a web link. */
const link = (u: string): string | null => (/^https:\/\/\S+$/.test(u) && u.length <= URL_CAP && clipTitle(u, URL_CAP) === u && !u.includes("'") ? u : null);

/** Cached per index array: entries and word counts depend on the index alone. */
const projectsBuilt = new WeakMap<IndexProject[], RefEntry[]>();
const documentsBuilt = new WeakMap<IndexDocument[], RefEntry[]>();

function projectEntries(list: IndexProject[]): RefEntry[] {
  const got = projectsBuilt.get(list);
  if (got) return got;
  const out: RefEntry[] = [];
  for (const p of list) {
    const name = clipTitle(p.name, NAME_CAP);
    const url = link(p.url);
    if (!name || !url) continue;
    const text = `Linear project "${name}" (${url})`;
    out.push({ kind: "project", key: p.id, words: significantWords(name), names: [url], line: text, text: () => text, titles: [name] });
  }
  projectsBuilt.set(list, out);
  return out;
}

function documentEntries(list: IndexDocument[]): RefEntry[] {
  const got = documentsBuilt.get(list);
  if (got) return got;
  const out: RefEntry[] = [];
  for (const d of list) {
    const title = clipTitle(d.title, NAME_CAP);
    const project = clipTitle(d.project_name ?? "", NAME_CAP);
    const url = link(d.url);
    if (!title || !url) continue;
    const text = `Linear doc "${title}" (${project ? `${project}, ` : ""}${url})`;
    // The cue words are no part of an entry's own words, as 114 does: "notes" in the draft opens the gate, it does not find every "notes" title.
    const words = new Set([...significantWords(`${title} ${project}`)].filter((w) => !cueWords.has(w)));
    out.push({ kind: "document", key: d.id, words, names: [url], line: text, text: () => text, titles: [title, ...(project ? [project] : [])] });
  }
  documentsBuilt.set(list, out);
  return out;
}

/** The desk's Linear projects as a source: words from the name, not gated (a desk's scope holds few); a project's URL offers it. Null with none. */
export function projectSource(index: RefIndex | null): RefSource | null {
  const entries = index?.projects?.length ? projectEntries(index.projects) : [];
  return entries.length ? { entries } : null;
}

/** The desk's Linear documents as a source: words from the title and its project's name, gated on `DOCUMENT_CUES` or a document's URL in the draft. Null with none. */
export function documentSource(index: RefIndex | null): RefSource | null {
  const entries = index?.documents?.length ? documentEntries(index.documents) : [];
  if (!entries.length) return null;
  return { entries, cues: DOCUMENT_CUES };
}
