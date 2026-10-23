// What went with a message, as rows under it (decisions 58, 60; Claude
// Code's "rows under a message that open to the terminal output … and
// selected code sent with it"): the editor's selection and a terminal's
// output open to their text, the open file opens in the editor.

import type { ContextItem } from "../../src/wire/message";
import { Link } from "../shared/link";
import type { ToolCtx } from "./tools";

const rel = (p: string, cwd: string) => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p);
const lines = (t: string) => t.replace(/\n$/, "").split("\n").length;

export function ContextRows({ items, ctx }: { items: ContextItem[]; ctx: ToolCtx }) {
  return (
    <div class="ctx-rows">
      {items.map((c, i) =>
        c.kind === "file" ? (
          <div key={i} class="ctx-row">
            <span class="ctx-kind">Open file</span>
            <Link onOpen={() => ctx.openFile(c.path)} title={c.path}>
              {rel(c.path, ctx.cwd)}
            </Link>
          </div>
        ) : (
          <details key={i} class="ctx-row">
            <summary>
              <span class="ctx-kind">{c.kind === "selection" ? "Selection" : "Terminal"}</span>
              {c.kind === "selection" ? `${rel(c.path, ctx.cwd)}#L${c.startLine}${c.endLine > c.startLine ? `-${c.endLine}` : ""}` : c.name}
              <span class="muted"> · {lines(c.text)} line{lines(c.text) > 1 ? "s" : ""}</span>
            </summary>
            <pre>{c.text}</pre>
            {c.kind === "selection" && (
              <Link onOpen={() => ctx.openFile(c.path, c.startLine)} title={c.path}>
                Open in the editor
              </Link>
            )}
          </details>
        ),
      )}
    </div>
  );
}
