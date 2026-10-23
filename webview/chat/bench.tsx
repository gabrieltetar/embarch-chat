// Bench results as cards (decision 15): an embarch-api build, flash,
// bootload, study or serial_log result becomes pass or fail, the board, the
// first error, steps passed and a link into embarch-ui — read from the tool
// result already in the stream, nothing polled. The result shapes are
// embarch-api's own (its interfaces/tools-*.md): one JSON object as text, or
// prose for an error raised before there was an object.

import { Link } from "../shared/link";
import type { ToolCtx, ToolRenderer } from "./tools";
import { BenchCardData, benchCard, benchTool } from "./benchcard";

export { benchCard, benchTool, firstError } from "./benchcard";
export type { BenchCardData } from "./benchcard";

export function BenchCard({ c, uiUrl, ctx }: { c: BenchCardData; uiUrl: string; ctx: ToolCtx }) {
  const mark = c.ok === null ? "…" : c.ok ? "PASS" : "FAIL";
  return (
    <div class={`bench ${c.ok === null ? "run" : c.ok ? "pass" : "fail"}`}>
      <div class="bench-head">
        <span class="bench-mark">{mark}</span>
        <span class="bench-title">{c.title}</span>
        {c.board && <span class="bench-board">{c.board}</span>}
        {c.steps && <span class="muted">{c.steps}</span>}
        {c.link && uiUrl && (
          <Link class="bench-link" onOpen={() => ctx.openLink(`${uiUrl.replace(/\/?$/, "/")}#${c.link!.hash}`)}>
            {c.link.label} ↗
          </Link>
        )}
      </div>
      {c.error && <div class="bench-error">{c.error}</div>}
      {c.detail.length > 0 && <div class="muted bench-detail">{c.detail.join(" · ")}</div>}
      {c.log && c.log.length > 0 && <pre class="out">{c.log.join("\n")}</pre>}
    </div>
  );
}

/** Registered with the tool view: a bench tool's body is its card. */
export function benchRenderer(uiUrl: () => string): ToolRenderer {
  return (t, ctx) => {
    const tool = benchTool(t.name);
    if (!tool) return null;
    const c = benchCard(tool, t);
    return c ? <BenchCard c={c} uiUrl={uiUrl()} ctx={ctx} /> : null;
  };
}
