// The linker's study-capture source (decision 119): the taps of the studies
// Core retains, read with `embarch-api --json list-studies --limit 20`
// (`ApiRunner`). A tap is a study's capture; one whose encoding is an outpost
// trace is a `trace`, any other a `capture`. A tap and a study carry names
// anyone can write, so each is clipped and quoted and rides in `titles`. The
// gate and the matching are the source's own (`find`): the entries hold no
// words for the matcher. Pure.

import { RefEntry, RefSource, clipTitle, significantWords } from "./refsBase";

/** The verb the studies are read with: one verb to the runner, one cache rule with `list-instruments` (116). */
export const STUDIES_VERB = "list-studies --limit 20";

/** The words that name a trace (whole word, any case). */
export const TRACE_CUES = ["trace", "traces"];
/** The words that name a capture: with one, a draft that matches nothing is offered the newest taps. */
export const CAPTURE_CUES = ["capture", "captures", "recording", "recordings", "stream", "streams", "tap", "taps", "samples", "sample"];
/** The words that open the gate for a match on a name alone (whole word, any case). */
export const STUDY_CUES = [...TRACE_CUES, ...CAPTURE_CUES, "study", "studies", "run", "runs", "log", "logs"];
/** The words that ask for the newer study. */
export const RECENCY_CUES = ["last", "latest", "yesterday", "today"];

/** A draft that matches nothing is offered at most this many of the newest taps. */
const NEWEST_MAX = 4;
const STUDIES_MAX = 50;
const TAPS_MAX = 50;
const NAME_CAP = 60;

export interface StudyTap {
  name: string;
  /** `raw`, `text`, `samples`, `gatt_transcript`, `outpost_trace`, `struct`. */
  encoding_kind: string;
  /** False only when the tap says so. */
  rendered: boolean;
}

export interface Study {
  id: string;
  name: string;
  /** UTC milliseconds; null when the study has none. */
  started_ms: number | null;
  /** Null when Core could not read them. */
  taps: StudyTap[] | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(s)}(?![\\p{L}\\p{N}_])`, "iu");
const has = (cues: string[], draft: string) => cues.some((c) => word(c).test(draft));
const cueWords = significantWords(STUDY_CUES.join(" "));

/** `{success, studies}`, as the verb sorts it (newest first); null when it is not that or says it failed. A study with no clean id is dropped, a tap with no name or encoding too. */
export function parseStudies(json: unknown): Study[] | null {
  const d = json as { success?: unknown; studies?: unknown } | null;
  if (!d || typeof d !== "object" || d.success === false || !Array.isArray(d.studies)) return null;
  const out: Study[] = [];
  for (const s of d.studies.slice(0, STUDIES_MAX)) {
    const id = typeof s?.study_id === "string" ? s.study_id : "";
    // An id written as it is, never cut: it is what the draft names the study by.
    if (!id || clipTitle(id, NAME_CAP) !== id || /\s/.test(id)) continue;
    const taps: StudyTap[] | null = Array.isArray(s.taps)
      ? s.taps
          .slice(0, TAPS_MAX)
          .filter((t: { name?: unknown; encoding_kind?: unknown }) => typeof t?.name === "string" && t.name && typeof t.encoding_kind === "string" && t.encoding_kind)
          .map((t: { name: string; encoding_kind: string; rendered?: unknown }) => ({ name: t.name, encoding_kind: t.encoding_kind, rendered: t.rendered !== false }))
      : null;
    out.push({
      id,
      name: typeof s.study_name === "string" ? s.study_name : "",
      started_ms: typeof s.started_utc_ms === "number" && Number.isFinite(s.started_utc_ms) ? s.started_utc_ms : null,
      taps,
    });
  }
  return out;
}

const day = (ms: number | null): string => {
  const d = ms === null ? null : new Date(ms);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "";
};

interface Built {
  e: RefEntry;
  /** The significant words of the tap's and the study's names, the cue words left out. */
  words: Set<string>;
}

function build(list: Study[]): Built[] {
  const out: Built[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const studyName = clipTitle(s.name, NAME_CAP);
    for (const t of s.taps ?? []) {
      const tap = clipTitle(t.name, NAME_CAP);
      const key = `${s.id}/${tap}`;
      if (!tap || seen.has(key)) continue;
      seen.add(key);
      const trace = t.encoding_kind === "outpost_trace";
      const date = day(s.started_ms);
      const detail = [trace ? "OutpostTrace" : clipTitle(t.encoding_kind, NAME_CAP), date].filter(Boolean).join(", ");
      const text = `${trace ? "trace" : "capture"} "${tap}" of study ${s.id}${studyName ? ` "${studyName}"` : ""} (${detail})${t.rendered ? "" : " not rendered"}`;
      const words = new Set([...significantWords(`${tap} ${studyName}`)].filter((w) => !cueWords.has(w)));
      out.push({ e: { kind: trace ? "trace" : "capture", key, words: new Set<string>(), names: [s.id], line: text, text: () => text, titles: [tap, ...(studyName ? [studyName] : [])] }, words });
    }
  }
  return out;
}

/**
 * The studies' taps as a source, newest study first; null with none. The gate:
 * a study's id in the draft offers its taps with no cue word; otherwise one of
 * `STUDY_CUES` must be in it. Gated, a tap is offered when its name or its
 * study's shares a word with the draft, most shared first, newest first among
 * equals, or newest first alone when the draft carries a recency word (last,
 * latest, yesterday, today). A draft that shares no word but carries a trace
 * or capture word is offered the newest traces, or the newest taps.
 */
export function studySource(list: Study[] | null): RefSource | null {
  const built = list?.length ? build(list) : [];
  if (!built.length) return null;
  const entries = built.map((b) => b.e);
  return {
    entries,
    find: (d) => {
      if (!has(STUDY_CUES, d)) return [];
      const want = significantWords(d);
      const recent = has(RECENCY_CUES, d);
      const hits = built
        .map((b, i) => ({ b, i, n: [...b.words].filter((w) => want.has(w)).length }))
        .filter((h) => h.n > 0)
        .sort((a, b) => (recent ? 0 : b.n - a.n) || a.i - b.i);
      if (hits.length) return hits.map((h) => h.b.e);
      const trace = has(TRACE_CUES, d);
      if (!trace && !has(CAPTURE_CUES, d)) return [];
      // "trace" alone asks for traces; a capture word with it, or alone, for any tap.
      const pool = trace && !has(CAPTURE_CUES, d) ? entries.filter((e) => e.kind === "trace") : entries;
      return pool.slice(0, NEWEST_MAX);
    },
  };
}
