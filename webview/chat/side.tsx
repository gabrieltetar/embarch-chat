// Side questions (decision 57), Claude Code's /btw: asked while Claude
// works, answered from the conversation and the turn in progress, and kept
// here, above the input — never in the timeline, never sent to the
// conversation. Clear drops the answered ones.

import type { SideQuestion } from "../../src/wire/reducer";
import { Markdown } from "../shared/markdown";
import { vscodeApi } from "../shared/vscode";
import type { ToolCtx } from "./tools";

export function SideQuestions({ items, ctx }: { items: SideQuestion[]; ctx: ToolCtx }) {
  if (!items.length) return null;
  return (
    <div class="side" title="Side questions: Claude answers from the conversation so far; neither the question nor the answer joins it">
      <div class="side-head">
        <span>Side questions</span>
        <span class="muted">not part of the conversation</span>
        <span class="spacer" />
        <button class="icon" title="Clear side questions" disabled={items.every((q) => q.pending)} onClick={() => vscodeApi.postMessage({ t: "sideClear" })}>
          Clear
        </button>
      </div>
      {items.map((q) => (
        <div key={q.id} class="side-q">
          <div class="side-ask">{q.question}</div>
          {q.pending ? (
            <span class="spinner" />
          ) : q.error ? (
            <div class="err">{q.error}</div>
          ) : q.response ? (
            <Markdown text={q.response} ctx={ctx} />
          ) : (
            <div class="muted">Claude didn't return an answer for this side question.</div>
          )}
        </div>
      ))}
    </div>
  );
}
