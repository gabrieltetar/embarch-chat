// Promptu's dialog (decision 96): a modal over the chat that asks what the
// first prompt of a task leaves open, drawn natively from `promptu prep`'s
// pages — no model call here — one page at a time as `promptu next` plans
// them. Each question's recommended option is picked already, so Enter
// takes the page as it shows; "Accept all recommendations" (Ctrl+Enter)
// takes every recommendation left; Esc stops — the answers given count and
// what is left becomes assumptions the prompt tells Claude to state. The
// host runs every command and holds the run (src/promptu/runs.ts); the
// prompt lands in the draft and is not sent.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AskPage, AskQuestion, PrepOut } from "../../src/promptu/cli";
import type { PromptuView } from "../../src/promptu/runs";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** AskUserQuestion's mark on the option Promptu recommends (contract §7.8). */
export const REC = " (Recommended)";
const isRec = (label: string) => label.endsWith(REC);
const plain = (label: string) => (isRec(label) ? label.slice(0, -REC.length) : label);

type Answer = string | string[] | { other: string } | { labels: string[]; other?: string };

/** The options a question starts with picked: its recommendation (one, or for a multi every one). */
export function preselected(q: AskQuestion): string[] {
  const rec = q.options.filter((o) => isRec(o.label)).map((o) => o.label);
  return q.multiSelect ? rec : rec.slice(0, 1);
}

/** A question's answer as the page shows it, or null when it has none yet (contract §8.1's forms). */
export function answerOf(q: AskQuestion, picked: string[], other: string): Answer | null {
  const typed = other.trim();
  if (q.multiSelect) return typed ? { labels: picked, other: typed } : picked;
  if (typed) return { other: typed };
  return picked[0] ?? null;
}

/** The page on screen: the chip row first while it is open, then the plan's first page. */
export function pageOf(step: PrepOut): { page: AskPage; choose: boolean } | null {
  if (step.choose && step.choose.questions.length) return { page: step.choose, choose: true };
  const p = step.pages?.[0];
  return p && p.questions.length ? { page: p, choose: false } : null;
}

function what(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : "nothing";
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v ?? "");
}

const SOURCE: Record<string, string> = { prompt: "your prompt", desk: "the work item", memory: "memory", last: "last time", context: "the checkout" };

function Working({ view }: { view: PromptuView }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const reading = view.doing === "prep";
  const label = reading ? (view.origin === "start" ? "Promptu is reading the issue…" : view.origin === "handoff" ? "Promptu is setting up the handoff…" : "Promptu is reading your prompt…") : view.doing === "render" ? "Writing the prompt…" : "…";
  return (
    <div class="dialog-back promptu-back">
      <div
        class="dialog promptu working"
        ref={box}
        role="dialog"
        aria-label="Promptu"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          // Only while it reads the prompt: a page already answered is past stopping.
          if (reading) post({ t: "promptu", op: "cancel", seq: view.seq });
        }}
      >
        <div class="dialog-title">
          <span class="spinner" /> {label}
        </div>
        <div class="promptu-rough muted">{view.rough}</div>
        {reading && <div class="promptu-hint muted">Esc: skip it — your draft stays as typed and Enter sends it.</div>}
      </div>
    </div>
  );
}

function Page({ view, step, page, choose }: { view: PromptuView; step: PrepOut; page: AskPage; choose: boolean }) {
  const qs = page.questions;
  const [picked, setPicked] = useState<string[][]>(() => qs.map(preselected));
  const [other, setOther] = useState<string[]>(() => qs.map(() => ""));
  /** The questions the owner touched on this page: what Esc keeps of it. */
  const [touched, setTouched] = useState<boolean[]>(() => qs.map(() => false));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLInputElement>("input:checked, input")?.focus();
  }, []);
  const answers = qs.map((q, i) => answerOf(q, picked[i], other[i]));
  const complete = answers.every((a) => a !== null);
  const touch = (i: number) => setTouched((t) => t.map((x, k) => x || k === i));
  const toggle = (i: number, label: string, multi: boolean) => {
    touch(i);
    setPicked((all) => all.map((cur, k) => (k !== i ? cur : multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label])));
    if (!multi) setOther((all) => all.map((o, k) => (k === i ? "" : o)));
  };
  /** By id, `only` the questions that count: every answered one, or the touched ones for Esc. */
  const input = (only: (i: number) => boolean) => {
    if (choose) {
      const a = answers[0];
      return only(0) && typeof a === "string" ? { pattern: plain(a) } : {};
    }
    const out: Record<string, Answer> = {};
    page.ids.forEach((id, i) => {
      const a = answers[i];
      if (a !== null && only(i)) out[id] = a;
    });
    return { answers: out };
  };
  const next = () => complete && post({ t: "promptu", op: "answer", seq: view.seq, input: input(() => true) });
  const acceptAll = () => post({ t: "promptu", op: "finish", seq: view.seq, rest: "recommended", input: input((i) => answers[i] !== null) });
  const stop = () => post({ t: "promptu", op: "finish", seq: view.seq, rest: "assume", input: input((i) => touched[i]) });
  const left = step.pages.length + (choose ? 1 : 0) - 1;
  const p = step.pattern;
  const how = p ? (p.start_default ? "Start work's default" : p.picked_by === "model" ? `picked from your prompt${p.confidence !== null ? ` (${Math.round(p.confidence * 100)}%)` : ""}` : p.picked_by === "regex" ? "picked by keywords" : p.picked_by === "owner" ? "your pick" : "as asked") : "no pattern yet";
  const filled = step.filled ?? [];
  const defaults = step.defaults ?? [];
  return (
    <div class="dialog-back promptu-back">
      <div
        class="dialog promptu"
        ref={box}
        role="dialog"
        aria-label="Promptu"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            stop();
            return;
          }
          if (e.key !== "Enter" || e.isComposing) return;
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            acceptAll();
            return;
          }
          // Shift+Enter breaks a line in Other; a button takes its own Enter.
          if (e.shiftKey || e.target instanceof HTMLButtonElement) return;
          e.preventDefault();
          next();
        }}
      >
        <div class="dialog-title promptu-title">
          <span>Promptu{p ? ` · ${p.id}` : ""}</span>
          <span class="muted">{choose ? "which kind of task?" : how}</span>
        </div>
        <div class="promptu-rough muted" title={view.rough}>
          {view.rough}
        </div>
        {step.offline && <div class="warn">Offline: {step.offline_reason ?? "the pass did not run"} — picked without the model, nothing pre-filled.</div>}
        {(step.warnings ?? []).map((w, i) => (
          <div key={i} class="warn">
            {w}
          </div>
        ))}
        {!choose && (filled.length > 0 || defaults.length > 0) && (
          <details class="promptu-filled">
            <summary>
              Already answered ({filled.length}){defaults.length ? ` · defaults (${defaults.length})` : ""}
            </summary>
            {filled.map((f) => (
              <div key={`f:${f.q}`} class="promptu-fill" title={f.evidence ?? undefined}>
                <span class="q-head">{f.header || f.q}</span> {what(f.value)} <span class="muted">— from {SOURCE[f.source] ?? f.source}</span>
              </div>
            ))}
            {defaults.map((d) => (
              <div key={`d:${d.q}`} class="promptu-fill">
                <span class="q-head">{d.header || d.q}</span> {what(d.value)} <span class="muted">— default, not asked</span>
              </div>
            ))}
          </details>
        )}
        {qs.map((q, i) => (
          <div class="q" key={`${page.ids[i]}:${i}`}>
            {q.header && <div class="q-head">{q.header}</div>}
            <div class="q-text">{q.question}</div>
            {q.options.map((o, n) => (
              <label class={`opt ${picked[i].includes(o.label) ? "sel" : ""}`} key={n}>
                <input type={q.multiSelect ? "checkbox" : "radio"} name={`pq${i}`} checked={picked[i].includes(o.label)} onChange={() => toggle(i, o.label, q.multiSelect)} />
                <span>
                  <div>{o.label}</div>
                  {o.description && <div class="desc">{o.description}</div>}
                </span>
              </label>
            ))}
            {!choose && (
              <textarea
                class="other"
                rows={1}
                placeholder="Other…"
                value={other[i]}
                onInput={(e) => {
                  const v = (e.target as HTMLTextAreaElement).value;
                  touch(i);
                  setOther((all) => all.map((o, k) => (k === i ? v : o)));
                  // One answer only: text in Other takes the place of the option picked.
                  if (!q.multiSelect && v.trim()) setPicked((all) => all.map((cur, k) => (k === i ? [] : cur)));
                }}
              />
            )}
          </div>
        ))}
        <div class="dialog-buttons">
          <button class="primary" disabled={!complete} onClick={next} title="Enter">
            {left > 0 || choose ? "Next" : "Done"}
          </button>
          <button onClick={acceptAll} title="Ctrl+Enter: every question left takes its recommendation">
            Accept all recommendations
          </button>
          <button class="secondary" onClick={stop} title="Esc: the answers given count; what is left becomes assumptions the prompt asks Claude to state">
            Stop here
          </button>
        </div>
        <div class="promptu-hint muted">
          {left > 0 ? `${left} more page${left > 1 ? "s" : ""} after this one, as planned now. ` : ""}The prompt goes into your draft; nothing is sent.
        </div>
      </div>
    </div>
  );
}

/** The dialog for the chat on screen: working, or a page to answer. Quick mode shows none (95). */
export function PromptuDialog({ view }: { view: PromptuView }) {
  const step = view.phase === "ask" ? view.step : undefined;
  const shown = useMemo(() => (step ? pageOf(step) : null), [step]);
  if (view.quick && view.phase === "working") return null;
  if (!step || !shown) return <Working view={view} />;
  // A new page is a new form: its picks start from its recommendations.
  const key = `${view.seq}:${step.run}:${shown.choose ? "_pattern" : shown.page.ids.join(",")}:${step.pages.length}`;
  return <Page key={key} view={view} step={step} page={shown.page} choose={shown.choose} />;
}
