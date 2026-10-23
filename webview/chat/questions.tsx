// An answered question as it stays in the conversation (decision 79), as
// Claude Code's "Questions" row has it: each question with every option,
// the owner's picks marked and the rest dimmed, and what was typed in Other.
// Later in the chat the owner can see which board or port was chosen. The
// picks come from the CLI's own record of the answers, else its result text.

import type { ToolEntry } from "../../src/wire/reducer";
import { questionAnswers, questionsOf, splitAnswer } from "../../src/wire/cards";

const STATUS: Record<ToolEntry["status"], string> = {
  running: "Asked",
  awaiting: "Asked",
  done: "Answered",
  error: "No answer",
  denied: "Skipped",
};

/** The row's line: "Questions", then "Answered · 2 questions". */
export function QuestionsLine({ t }: { t: ToolEntry }) {
  const n = questionsOf(t.input).length;
  return (
    <>
      <span class="name">{n === 1 ? "Question" : "Questions"}</span>
      <span class="summary">
        {STATUS[t.status]}
        {n > 0 && ` · ${n} question${n === 1 ? "" : "s"}`}
      </span>
    </>
  );
}

export function QuestionsBody({ t }: { t: ToolEntry }) {
  const qs = questionsOf(t.input);
  const answers = t.status === "done" ? questionAnswers(t) : null;
  return (
    <div class="qa">
      {qs.map((q, i) => {
        const a = answers?.[q.question];
        const { picked, other } = a === undefined ? { picked: [] as string[], other: undefined } : splitAnswer(q, a);
        const answered = a !== undefined;
        const mark = (on: boolean) => (q.multiSelect ? (on ? "☑" : "☐") : on ? "◉" : "○");
        return (
          <div class="q" key={i}>
            {q.header && <div class="q-head">{q.header}</div>}
            <div class="q-text">{q.question}</div>
            {q.options.map((o, k) => {
              const on = picked.includes(o.label);
              return (
                <div key={k} class={`qa-opt ${on ? "picked" : answered ? "dim" : ""}`}>
                  <span class="mark">{mark(on)}</span>
                  <span>
                    <div>{o.label}</div>
                    {o.description && <div class="desc">{o.description}</div>}
                  </span>
                </div>
              );
            })}
            {other !== undefined && (
              <div class="qa-opt picked">
                <span class="mark">{mark(true)}</span>
                <span>
                  <div>Other</div>
                  <div class="typed">{other}</div>
                </span>
              </div>
            )}
          </div>
        );
      })}
      {t.status !== "done" && t.result && <div class="muted">{t.result}</div>}
    </div>
  );
}
