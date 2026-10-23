// What waits on the owner (decision 8): a permission prompt with allow and
// deny; Claude's question as a form with options and previews; a plan with
// approve and keep planning. On the wire all three are `can_use_tool`; the
// CLI's own dialogs and MCP elicitations are dialogs.tsx's (decision 66).
// And the compaction's card, which stays in the timeline (76).
//
// A card never takes focus, and nothing typed in the input answers one. One
// that comes while the owner types waits as a quiet line until the draft is
// sent or cleared, the input is left, or the typing pauses (decision 55).

import { useEffect, useRef, useState } from "preact/hooks";
import type { NoteEntry, Pending } from "../../src/wire/reducer";
import { Markdown, MdCtx } from "../shared/markdown";
import { vscodeApi } from "../shared/vscode";
import { ownerTyping } from "./composer";
import { DialogCard, dialogLine } from "./dialogs";
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
      {p.kept && <div class="muted">{p.kept} in the diff tab — Allow sends only those</div>}
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

/**
 * A plan (decision 77), with Claude Code's three answers: approve into auto
 * mode — the first, as in its terminal — or into ask mode, or keep planning.
 * "Open to comment" opens the plan as a document whose lines take comments;
 * once there are some, they are listed here with × and the plan can only go
 * back with them, as in Claude Code.
 */
function PlanCard({ p, ctx }: { p: Pending; ctx: ToolCtx }) {
  const [fb, setFb] = useState("");
  const comments = p.comments ?? [];
  const commented = comments.length > 0;
  return (
    <div class="card plan-card">
      <div class="card-title row">
        <span>{commented ? "Continue planning" : "Claude's plan"}</span>
        <button class="secondary" title="Open the plan in a tab and comment on its lines" onClick={() => post({ t: "openPlan", requestId: p.requestId })}>
          Open to comment
        </button>
      </div>
      <div class="plan">
        <Markdown text={String(p.input.plan ?? "")} ctx={ctx} />
      </div>
      {commented && (
        <div class="plan-comments">
          <div class="muted">
            {comments.length} comment{comments.length === 1 ? "" : "s"} will go back as feedback
          </div>
          {comments.map((c) => (
            <div class="plan-comment" key={c.id}>
              <div class="body">
                <div class="quote">"{c.selectedText.length > 80 ? c.selectedText.slice(0, 80) + "…" : c.selectedText}"</div>
                <div>{c.comment}</div>
              </div>
              <button class="icon" title="Remove the comment" onClick={() => post({ t: "removePlanComment", requestId: p.requestId, id: c.id })}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea rows={2} placeholder="Tell Claude what to do instead" value={fb} onInput={(e) => setFb((e.target as HTMLTextAreaElement).value)} />
      <div class="actions">
        {!commented && (
          <button class="primary" title="Approve, and switch this chat to auto mode" onClick={() => post({ t: "allow", requestId: p.requestId, mode: "auto" })}>
            Yes, and use auto mode
          </button>
        )}
        {!commented && (
          <button title="Approve, and ask before each edit" onClick={() => post({ t: "allow", requestId: p.requestId, mode: "default" })}>
            Yes, and manually approve edits
          </button>
        )}
        <button class={commented ? "primary" : undefined} onClick={() => post({ t: "deny", requestId: p.requestId, message: fb })}>
          {commented ? "Send feedback and keep planning" : "No, keep planning"}
        </button>
      </div>
    </div>
  );
}

/** A card that came while the owner typed (55): one line of what waits, nothing in it answers. */
function HeldCard({ p, ctx, onShow }: { p: Pending; ctx: ToolCtx; onShow: () => void }) {
  const qs = (Array.isArray(p.input.questions) ? p.input.questions : []) as Question[];
  const what =
    p.form === "question"
      ? `Claude asks: ${qs[0]?.question ?? ""}${qs.length > 1 ? ` (+${qs.length - 1})` : ""}`
      : p.form === "plan"
        ? "Claude's plan is ready"
        : p.form === "dialog" || p.form === "elicitation"
          ? dialogLine(p)
          : `Allow ${toolLabel(p.toolName)}? ${toolSummary(p.toolName, p.input, ctx.cwd)}`;
  return (
    <div class="card held" role="status" title="Waits while you type: it opens once you send or clear the draft, leave the input, or pause">
      <span class="held-what">{what}</span>
      <span class="muted">after your draft</span>
      <button onClick={onShow}>Show</button>
    </div>
  );
}

export function PendingCards({ pending, ctx, readOnly, recall = () => {} }: { pending: Pending[]; ctx: ToolCtx; readOnly: boolean; recall?: () => void }) {
  // The owner's typing, read as each card first shows (55): it re-renders when that ends.
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener("embarch-typing", on);
    return () => window.removeEventListener("embarch-typing", on);
  }, []);
  const seen = useRef(new Set<string>());
  const held = useRef(new Set<string>());
  const typing = ownerTyping();
  const ids = new Set(pending.map((p) => p.requestId));
  for (const id of [...seen.current]) if (!ids.has(id)) seen.current.delete(id);
  for (const p of pending) {
    if (seen.current.has(p.requestId)) continue;
    seen.current.add(p.requestId);
    if (typing) held.current.add(p.requestId);
  }
  // Held until the typing ends, and once shown a card stays shown.
  for (const id of [...held.current]) if (!typing || !ids.has(id)) held.current.delete(id);
  if (!pending.length || readOnly) return null;
  const show = (id: string) => {
    held.current.delete(id);
    bump((n) => n + 1);
  };
  return (
    <div class="cards">
      {pending.map((p) =>
        held.current.has(p.requestId) ? (
          <HeldCard key={`held:${p.requestId}`} p={p} ctx={ctx} onShow={() => show(p.requestId)} />
        ) : p.form === "question" ? (
          <QuestionCard key={p.requestId} p={p} ctx={ctx} />
        ) : p.form === "plan" ? (
          <PlanCard key={p.requestId} p={p} ctx={ctx} />
        ) : p.form === "dialog" || p.form === "elicitation" ? (
          <DialogCard key={p.requestId} p={p} ctx={ctx} recall={recall} />
        ) : (
          <PermissionCard key={p.requestId} p={p} ctx={ctx} />
        ),
      )}
    </div>
  );
}

/**
 * A compaction (decision 76), as Claude Code's card has it: one folded line —
 * "Compacted chat · manual · 12k tokens freed" — and inside it the summary
 * the conversation goes on from, so the owner can check what it kept (the
 * board, the port, a pin) before the next step.
 */
export function CompactCard({ e, ctx }: { e: NoteEntry; ctx: MdCtx }) {
  return (
    <details class="compacted">
      <summary>{e.text}</summary>
      <div class="compact-summary">{e.summary ? <Markdown text={e.summary} ctx={ctx} /> : <p class="muted">Conversation was compacted to free up context.</p>}</div>
    </details>
  );
}
