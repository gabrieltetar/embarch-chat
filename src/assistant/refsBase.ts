// The linker's shared parts (decision 112): what a source gives the matcher
// (an entry, as embarch-promptu's contract 15.1 fixes it) and the text helpers
// every source writes its lines with. Pure, so the node tests run it.

import { stripInvisible } from "../wire/message";

const TITLE_CAP = 90;

/** One line a source may offer. */
export interface RefEntry {
  /** `issue`, `pr`, ... : the tag on its line and the unit of the per-kind cap. */
  kind: string;
  /** Unique within its kind. */
  key: string;
  /** What the entry is matched on (a title's significant words, a name, labels). */
  words: Set<string>;
  /** Exact strings a draft may use for it: such a name offers the entry with no cue word. */
  names: string[];
  /** The text the block shows after `[r<n>] <kind>: `: one line, no `<`, `>` or unseen character (`clipTitle`). */
  line: string;
  /** What replaces the phrase a card names, written here from the entry, never from the model's words. */
  text(find: string): string;
  /** Free text the entry carries that a card may not copy into a draft (copiesTitle). */
  titles?: string[];
  /** The scoring group when it is not the kind: a word's rarity counts among the group's entries. */
  pool?: string;
  /** Other entries this line already shows (`kind:key`), so they are not offered again. */
  covers?: string[];
  /** The entry to offer in its place when the matched one belongs on another's line and that is not shown yet. */
  lead?: () => RefEntry | null;
  /** The desk kinds' own: the issue and PRs the line shows. */
  issue?: import("../desk/client").IndexIssue;
  prs?: import("../desk/client").IndexPr[];
}

/** A source of one or more kinds, one file each (decision 112). */
export interface RefSource {
  entries: RefEntry[];
  /** Set: the source is gated and offers by words only when the draft carries one of these (whole word, any case). */
  cues?: string[];
  /** Entries the draft names in a way `names` cannot say (a key's case, "PR 36"), in the draft's order. */
  find?(draft: string): RefEntry[];
  /** Entries that find nothing by words: the chat's own, already in the prompt. */
  skip?(e: RefEntry): boolean;
  /** A factor on an entry's score, from the draft ("PR" favours PRs). */
  boost?(draft: string): (e: RefEntry) => number;
}

/** Function words and the words a request is written in: never what tells one title from another. */
const STOP = new Set(
  `a an the and or but nor so yet for of to in on at by with from into onto over under about after before than then
  this that these those it its is are was were be been being am do does did done doing have has had having
  i me my we us our you your he she they them their his her
  can could would should will shall may might must need needs let lets please just like same similar also too
  what when where which who whom whose why how all any some each every both more most other such only own very
  not no yes now here there again once still even ever already
  make made get got put set use used using want see look go went way thing things stuff something
  include add fix create update remove implement write check run try keep follow start finish change move
  pr prs pull request requests issue issues ticket tickets linear github card item work`
    .split(/\s+/)
    .filter(Boolean),
);

/** A word as titles and drafts are compared: lower case, no possessive, a plural as its singular. */
function norm(w: string): string {
  let s = w.toLowerCase().replace(/['’]s$/, "").replace(/['’]/g, "");
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** The significant words of a text, once each. */
export function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9'’]+/)) {
    const w = norm(raw);
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** A title as the prompt and the draft carry it: one line, no `<`/`>` to close a block with, no quote to end its own, nothing unseen, clipped. */
export function clipTitle(t: string): string {
  const s = stripInvisible(t)
    .text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return s.length <= TITLE_CAP ? s : s.slice(0, TITLE_CAP - 1) + "…";
}

