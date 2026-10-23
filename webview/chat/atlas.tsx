// Atlas citations become links (decision 16). atlas-use cites every
// hardware fact as `<doc_id> p<N>`, or `<board>:<ref>` for wiring; with the
// chat's repo's atlas known (its doc ids and board labels, from the host),
// each citation in Claude's prose opens that page's text or the board's
// entry. A repo without an atlas gets no links, so nothing that merely looks
// like a citation is turned into one.

import type { ComponentChildren } from "preact";
import { Link } from "../shared/link";
import { MdCtx, inlineHooks } from "../shared/markdown";
import { vscodeApi } from "../shared/vscode";

export interface AtlasInfo {
  docs: string[];
  boards: string[];
}

let atlas: AtlasInfo | null = null;
let re: RegExp | null = null;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function setAtlas(info: AtlasInfo | null): void {
  atlas = info && (info.docs.length || info.boards.length) ? info : null;
  if (!atlas) {
    re = null;
    return;
  }
  const alts: string[] = [];
  if (atlas.docs.length) alts.push(`(${atlas.docs.map(esc).sort((a, b) => b.length - a.length).join("|")})\\s+p\\.?\\s?(\\d{1,4})\\b`);
  if (atlas.boards.length) alts.push(`(?<![\\w:/\\\\])(${atlas.boards.map(esc).join("|")}):([A-Za-z][\\w.+/-]*[\\w+])`);
  re = new RegExp(alts.join("|"), "g");
}

/** The hook markdown runs over plain text: citations out, the rest left to it. */
function citations(text: string, _ctx: MdCtx): ComponentChildren[] | null {
  if (!re) return null;
  const r = new RegExp(re.source, "g");
  const out: ComponentChildren[] = [];
  let last = 0;
  let n = 0;
  const docAlt = atlas!.docs.length > 0;
  for (let m: RegExpExecArray | null; (m = r.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const doc = docAlt ? m[1] : undefined;
    const page = docAlt ? m[2] : undefined;
    const boardLabel = docAlt ? m[3] : m[1];
    const ref = docAlt ? m[4] : m[2];
    const label = m[0];
    out.push(
      <Link
        key={`cite${n++}`}
        class="cite"
        title={doc ? `Open ${doc}, page ${page}` : `Open board ${boardLabel}'s entry for ${ref}`}
        onOpen={() => vscodeApi.postMessage(doc ? { t: "atlas", doc, page: Number(page) } : { t: "atlas", board: boardLabel, ref })}
      >
        {label}
      </Link>,
    );
    last = r.lastIndex;
  }
  if (!n) return null;
  if (last < text.length) out.push(text.slice(last));
  // Line breaks inside the run stay line breaks.
  return out.flatMap((x, i) =>
    typeof x === "string" && x.includes("\n") ? x.split("\n").flatMap((p, k) => (k ? [<br key={`cb${i}-${k}`} />, p] : [p])) : [x],
  );
}

inlineHooks.push(citations);
