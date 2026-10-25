// Keys and PR numbers in Claude's prose as links (decision 88): the hook
// markdown runs over plain text, beside atlas citations (decision 16). What
// counts as one is refprose.ts'; a click opens it once, through the
// extension's own link path (`openLink`, http(s) only).

import type { ComponentChildren } from "preact";
import { Link } from "../shared/link";
import { MdCtx, inlineHooks } from "../shared/markdown";
import { proseRefs } from "./refprose";

function references(text: string, ctx: MdCtx, key: string): ComponentChildren[] | null {
  const parts = proseRefs(text);
  if (!parts) return null;
  return parts.map((p, n) =>
    typeof p === "string" ? (
      p
    ) : (
      <Link key={`${key}r${n}`} class="ref" title={p.title} onOpen={() => ctx.openLink(p.url)}>
        {p.label}
      </Link>
    ),
  );
}

inlineHooks.push(references);
