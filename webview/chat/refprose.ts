// Bare references in Claude's prose become links (embarch-chat decision 88)
// — `ABC-154`, `owner/repo#36`, and `PR #36` or "pull request #36", any
// case, in the chat's own folder's repo — only when the desk's index knows
// them (refs.ts), the way atlas citations are links only in a repo with an
// atlas (decision 16): nothing that merely looks like a key is turned into
// one. A bare `#3` never is: "step #3" is no PR, and that one PR in the
// index has the number does not make it the one meant. An issue opens
// Linear, a PR GitHub, each only as https to that host (subjects.ts'
// outsideLink). Never inside a code span or block, nor inside a link's own
// text: markdown hands its hooks plain text alone. Pure, so the node tests
// run it; reflinks.tsx draws it.

import { chatRepo, hasRefs, issueRef, prRef } from "./refs";
import { outsideLink } from "./subjects";

export interface ProseRef {
  /** The text as Claude wrote it. */
  label: string;
  url: string;
  /** What the hover says: the thing by name and title, its state, where it opens. */
  title: string;
}

// `owner/repo#36`; an issue key in capitals (`UTF-8` is one only if the index has it); `PR #36`, `pull request #36`, any case.
const RE =
  /(?<![\w./-])([A-Za-z0-9][\w.-]*\/[\w.-]+)#(\d{1,7})(?![\w-])|(?<![\w/.-])([A-Z][A-Z0-9]{0,9}-\d{1,7})(?![\w-])|(?<![\w/.#-])(?:[Pp][Rr]|[Pp]ull [Rr]equest) ?#(\d{1,7})(?![\w-])/g;

function one(m: RegExpExecArray, repo: string | null): ProseRef | null {
  if (m[3]) {
    const i = issueRef(m[3]);
    const url = outsideLink("linear", i?.url);
    return i && url ? { label: m[0], url, title: `${i.key} ${i.title}${i.state ? ` · ${i.state}` : ""}\nOpens in Linear: ${url}` } : null;
  }
  const r = m[1] ?? repo;
  const p = r ? prRef(Number(m[2] ?? m[4]), r) : null;
  const url = outsideLink("github", p?.url);
  return p && url ? { label: m[0], url, title: `${p.repo}#${p.number} ${p.title} · ${p.draft && p.state === "open" ? "draft" : p.state}\nOpens in GitHub: ${url}` } : null;
}

/** The text with the references the index knows as links; null when it holds none. `repo`: the chat's folder's, for `PR #36`. */
export function proseRefs(text: string, repo: string | null = chatRepo()): Array<string | ProseRef> | null {
  if (!hasRefs()) return null;
  const out: Array<string | ProseRef> = [];
  let last = 0;
  let found = false;
  const re = new RegExp(RE.source, "g");
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const r = one(m, repo);
    if (!r) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(r);
    last = re.lastIndex;
    found = true;
  }
  if (!found) return null;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
