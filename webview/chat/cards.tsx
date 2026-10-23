// What waits on the owner (decision 8): a permission prompt with allow and
// deny; Claude's question as a form with options and previews; a plan with
// approve and keep planning. On the wire all three are `can_use_tool`.

import { useState } from "preact/hooks";
import type { Pending } from "../../src/wire/reducer";
import { Markdown } from "../shared/markdown";
import { vscodeApi } from "../shared/vscode";
import { DiffView, ToolCtx, toolLabel, toolSummary } from "./tools";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** What "always allow" would add, from the CLI's own permission suggestions. */
function alwaysLabel(s: unknown[] | undefined): string | null {
  if (!Array.isArray(s) || !s.length) return null;
  const x = s[0] as { type?: string; mode?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> };
  if (x.type === "setMode" && x.mode === "acceptEdits") return "Allow, and accept edits from now on";
  if (x.type === "addRules" && x.rules?.length) {
    const r = x.rules[0];
    return `Always allow ${r.toolName}${r.ruleContent ? `(${r.ruleContent.length > 40 ? r.ruleContent.slice(0, 40) + "…" : r.ruleContent})` : ""}`;
  }
  if (x.type === "addDirectories") return "Allow, and add the directory";
  return "Always allow";
}

function PermissionCard({ p, ctx }: { p: Pending; ctx: ToolCtx }) {
  const [msg, setMsg] = useState("");
  const editLike = ["Edit", "Write", "MultiEdit"].includes(p.toolName);
  const always = alwaysLabel(p.suggestions);
  return (
    <div class="card">
      <div class="card-title">
        Allow <b>{toolLabel(p.toolName)}</b>?
      </div>
      <div class="md">
        <code>{toolSummary(p.toolName, p.input, ctx.cwd)}</code>
        {p.description && p.description !== toolSummary(p.toolName, p.input, ctx.cwd) && <div class="muted">{p.description}</div>}
      </div>
      {editLike && <DiffView t={{ name: p.toolName, input: p.input }} onOpen={() => post({ t: "openDiff", requestId: p.requestId })} max={24} />}
      {!editLike && p.toolName !== "Bash" && <pre class="out">{JSON.stringify(p.input, null, 2).slice(0, 2000)}</pre>}
      <div class="actions">
        <button class="primary" onClick={() => post({ t: "allow", requestId: p.requestId })}>
          Allow
        </button>
        {always && <button onClick={() => post({ t: "allow", requestId: p.requestId, always: true })}>{always}</button>}
        <button onClick={() => post({ t: "deny", requestId: p.requestId, message: msg })}>Deny</button>
        <input
          placeholder="or tell Claude what to do instead"
          value={msg}
          onInput={(e) => setMsg((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && msg.trim()) post({ t: "deny", requestId: p.requestId, message: msg });
          }}
        />
      </div>
    </div>
  );
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string; preview?: string }>;
}

function QuestionCard({ p, ctx }: { p: Pending; ctx: ToolCtx }) {
  const qs = (Array.isArray(p.input.questions) ? p.input.questions : []) as Question[];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [hover, setHover] = useState<Record<number, number>>({});
  const answerOf = (i: number) => (other[i]?.trim() ? other[i].trim() : (picked[i] ?? []).join(", "));
  const done = qs.every((_, i) => answerOf(i));
  const toggle = (i: number, label: string, multi: boolean) => {
    const cur = picked[i] ?? [];
    const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [i]: next });
    if (!multi) setOther({ ...other, [i]: "" });
  };
  const submit = () => {
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => (answers[q.question] = answerOf(i)));
    post({ t: "answer", requestId: p.requestId, answers });
  };
  return (
    <div class="card">
      <div class="card-title">Claude asks</div>
      {qs.map((q, i) => {
        const sel = picked[i] ?? [];
        const shownIdx = hover[i] ?? q.options.findIndex((o) => sel.includes(o.label));
        const preview = shownIdx >= 0 ? q.options[shownIdx]?.preview : undefined;
        return (
          <div class="q" key={i}>
            {q.header && <div class="q-head">{q.header}</div>}
            <div class="q-text">{q.question}</div>
            {q.options.map((o, n) => (
              <label
                class={`opt ${sel.includes(o.label) ? "sel" : ""}`}
                key={n}
                onMouseEnter={() => setHover({ ...hover, [i]: n })}
                onMouseLeave={() => setHover({ ...hover, [i]: -1 })}
              >
                <input type={q.multiSelect ? "checkbox" : "radio"} name={`q${i}`} checked={sel.includes(o.label)} onChange={() => toggle(i, o.label, !!q.multiSelect)} />
                <span>
                  <div>{o.label}</div>
                  {o.description && <div class="desc">{o.description}</div>}
                </span>
              </label>
            ))}
            {preview && (
              <div class="opt-preview">
                <Markdown text={preview} ctx={ctx} />
              </div>
            )}
            <input
              style="width:100%;margin-top:4px;padding:2px 6px"
              placeholder="Other…"
              value={other[i] ?? ""}
              onInput={(e) => setOther({ ...other, [i]: (e.target as HTMLInputElement).value })}
            />
          </div>
        );
      })}
      <div class="actions">
        <button class="primary" disabled={!done} onClick={submit}>
          Answer
        </button>
        <button onClick={() => post({ t: "deny", requestId: p.requestId, message: "The user chose not to answer." })}>Skip</button>
      </div>
    </div>
  );
}

function PlanCard({ p, ctx }: { p: Pending; ctx: ToolCtx }) {
  const [fb, setFb] = useState("");
  return (
    <div class="card">
      <div class="card-title">Claude's plan</div>
      <div class="plan">
        <Markdown text={String(p.input.plan ?? "")} ctx={ctx} />
      </div>
      <textarea rows={2} placeholder="What to change (for Keep planning)" value={fb} onInput={(e) => setFb((e.target as HTMLTextAreaElement).value)} />
      <div class="actions">
        <button class="primary" onClick={() => post({ t: "allow", requestId: p.requestId })}>
          Approve
        </button>
        <button onClick={() => post({ t: "deny", requestId: p.requestId, message: fb.trim() || "Keep planning." })}>Keep planning</button>
      </div>
    </div>
  );
}

export function PendingCards({ pending, ctx, readOnly }: { pending: Pending[]; ctx: ToolCtx; readOnly: boolean }) {
  if (!pending.length || readOnly) return null;
  return (
    <div class="cards">
      {pending.map((p) =>
        p.form === "question" ? <QuestionCard key={p.requestId} p={p} ctx={ctx} /> : p.form === "plan" ? <PlanCard key={p.requestId} p={p} ctx={ctx} /> : <PermissionCard key={p.requestId} p={p} ctx={ctx} />,
      )}
    </div>
  );
}
