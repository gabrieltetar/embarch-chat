// The linker's bench-instrument source (decision 116): the instruments the
// bench declares to Core, read with `embarch-api --json list-instruments`
// (`ApiRunner`). A declaration holds a name and a protocol and nothing a draft
// could be matched on, so the source is not matched by words: a draft that
// names an instrument is offered that one, and a draft with an instrument word
// is offered every one. The parsing and the source are pure.

import { RefEntry, RefSource, clipTitle } from "./refsBase";

/** The verb the instruments are read with. */
export const INSTRUMENTS_VERB = "list-instruments";

/** The words that open the gate (whole word, any case). */
export const INSTRUMENT_CUES = ["instrument", "supply", "PSU", "load", "meter", "multimeter", "DMM", "scope", "oscilloscope", "analyzer", "SMU"];

/** More declared instruments than this are not read. */
const INSTRUMENTS_MAX = 100;
const NAME_CAP = 60;

export interface Instrument {
  name: string;
  protocol: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(s)}(?![\\p{L}\\p{N}_])`, "iu");

/** `{success, instruments}`; null when it is not that or says it failed. An instrument with no clean name or protocol is dropped. */
export function parseInstruments(json: unknown): Instrument[] | null {
  const d = json as { success?: unknown; instruments?: unknown } | null;
  if (!d || typeof d !== "object" || d.success === false || !Array.isArray(d.instruments)) return null;
  const out: Instrument[] = [];
  for (const i of d.instruments.slice(0, INSTRUMENTS_MAX)) {
    const name = typeof i?.name === "string" ? i.name : "";
    const protocol = typeof i?.protocol === "string" ? i.protocol : "";
    // A name or protocol cleaning would change is not offered rather than offered cut.
    if (!name || !protocol || clipTitle(name, NAME_CAP) !== name || clipTitle(protocol, NAME_CAP) !== protocol) continue;
    out.push({ name, protocol });
  }
  return out;
}

/** The instruments as a source; null with none. */
export function instrumentSource(list: Instrument[] | null, draft: string): RefSource | null {
  if (!list?.length) return null;
  const entries: RefEntry[] = list.map((i) => {
    const text = `instrument "${i.name}" (${i.protocol})`;
    return { kind: "instrument", key: i.name, words: new Set<string>(), names: [i.name], line: text, text: () => text, titles: [] };
  });
  const cued = INSTRUMENT_CUES.some((c) => word(c).test(draft));
  return { entries, find: () => (cued ? entries : []) };
}
