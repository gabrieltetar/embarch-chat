// What the CLI asks besides permission prompts (decision 66): its own
// dialogs — auto mode falling back to billed classifier requests, a message
// its model's safeguards flagged — and an MCP server's elicitation, a form
// or a link. Each answers in the shape the CLI's schema names; the words and
// the buttons are Claude Code's own panel's. They wait as any card does,
// quiet while the owner types (55).

import { useState } from "preact/hooks";
import type { Pending } from "../../src/wire/reducer";
import { DIALOG_CANCELLED, AUTO_MODE_FALLBACK_TEXT, FormField, dialogChoice, formContent, formFields, helpUrl, refusalText } from "../../src/wire/dialogs";
import { Link } from "../shared/link";
import { vscodeApi } from "../shared/vscode";
import type { ToolCtx } from "./tools";

const post = (m: unknown) => vscodeApi.postMessage(m);
const respond = (p: Pending, response: Record<string, unknown>) => post({ t: "respond", requestId: p.requestId, response });

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** "claude-opus-5-5" as "Opus 5.5"; anything else as it came. */
export function modelName(id: string): string {
  const m = /(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}` : id;
}

/** A paragraph with the notice's help link, if it names it, as a link (Claude Code links only that one). */
function Para({ text, url, ctx }: { text: string; url: string | null; ctx: ToolCtx }) {
  const at = url ? text.indexOf(url) : -1;
  if (!url || at < 0) return <p>{text}</p>;
  return (
    <p>
      {text.slice(0, at)}
      <Link onOpen={() => ctx.openLink(url)}>{url}</Link>
      {text.slice(at + url.length)}
    </p>
  );
}

/** Auto mode's classifier fell back to billed requests: Continue, or Stop the turn. */
function AutoModeCard({ p, ctx }: { p: Pending; ctx: ToolCtx }) {
  const title = str(p.input.title).trim();
  const paras = Array.isArray(p.input.paragraphs) ? (p.input.paragraphs as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  const help = helpUrl(p.input.helpUrl);
  return (
    <div class="card dialog-card">
      {title && <div class="card-title">{title}</div>}
      {paras.length ? paras.map((t, i) => <Para key={i} text={t} url={help} ctx={ctx} />) : <p>{AUTO_MODE_FALLBACK_TEXT}</p>}
      {help && !paras.some((t) => t.includes(help)) && (
        <p>
          <Link onOpen={() => ctx.openLink(help)}>Learn more</Link>
        </p>
      )}
      <div class="actions">
        <button class="primary" onClick={() => respond(p, dialogChoice("continue"))}>
          Continue
        </button>
        <button onClick={() => respond(p, dialogChoice("interrupt"))}>Stop</button>
      </div>
    </div>
  );
}

/** The model's safeguards flagged a message: go on with the fallback model, or edit it and retry. */
function RefusalCard({ p, recall }: { p: Pending; recall: () => void }) {
  const from = modelName(str(p.input.originalModel));
  const to = modelName(str(p.input.fallbackModel));
  return (
    <div class="card dialog-card">
      <div class="card-title row">
        <span>Session paused</span>
        <button class="icon close" title="Close" onClick={() => respond(p, DIALOG_CANCELLED)}>
          ×
        </button>
      </div>
      <p>{refusalText(from, to)}</p>
      <div class="actions">
        <button class="primary" onClick={() => respond(p, dialogChoice("retry_fallback"))}>
          Switch to {to}
        </button>
        <button
          onClick={() => {
            // The message comes back to the draft, as Claude Code's panel recalls it.
            recall();
            respond(p, dialogChoice("edit_prompt"));
          }}
        >
          Edit prompt and retry with {from}
        </button>
      </div>
    </div>
  );
}

function Field({ f, value, set }: { f: FormField; value: string | boolean | undefined; set: (v: string | boolean) => void }) {
  const label = (
    <span class="field-label">
      {f.title}
      {f.required && <span class="muted"> (required)</span>}
    </span>
  );
  if (f.type === "boolean") {
    return (
      <label class="field check">
        <input type="checkbox" checked={value === true} onChange={(e) => set((e.target as HTMLInputElement).checked)} />
        {label}
        {f.description && <span class="desc">{f.description}</span>}
      </label>
    );
  }
  return (
    <label class="field">
      {label}
      {f.type === "enum" ? (
        <select value={typeof value === "string" ? value : ""} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
          {!f.required || typeof value !== "string" || !value ? <option value="">—</option> : null}
          {f.options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          inputMode={f.type === "string" ? undefined : "decimal"}
          placeholder={f.description}
          value={typeof value === "string" ? value : ""}
          onInput={(e) => set((e.target as HTMLInputElement).value)}
        />
      )}
    </label>
  );
}

/**
 * Where an MCP server's link goes, and whether its card opens it: https to
 * another machine only. A link to this one — embarch-ui, the desk — or over
 * plain http is shown and never opened from the card: one click would be
 * a GET's side effect, or a page passing for someone else's.
 */
function linkTarget(url: string): { host: string; open: boolean; why?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { host: url, open: false, why: "it is not a link this panel can read" };
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^(127\.|::ffff:(7f|127\.))/.test(h)) return { host: u.host, open: false, why: "it goes to this machine" };
  if (u.protocol !== "https:") return { host: u.host, open: false, why: "it is not https" };
  return { host: u.host, open: true };
}

/**
 * An MCP server's elicitation: a form of flat fields, or a link to open.
 * Accept sends the values, typed as the schema asks; Decline says no;
 * closing the card cancels. A schema with a field the panel cannot render
 * offers only Decline. The server goes by the name it has in the owner's
 * MCP config, not the display name it gives itself, and a link says where
 * it goes.
 */
function ElicitationCard({ p, ctx }: { p: Pending; ctx: ToolCtx }) {
  const server = p.toolName || str(p.input.display_name);
  const url = p.input.mode === "url" ? str(p.input.url) : "";
  const target = url ? linkTarget(url) : null;
  const fields = url ? [] : formFields(p.input.requested_schema as Record<string, unknown> | undefined);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries((fields ?? []).filter((f) => f.default !== undefined).map((f) => [f.name, f.type === "boolean" ? f.default === true : String(f.default)])),
  );
  const [err, setErr] = useState<string | null>(null);
  const accept = () => {
    if (target) {
      if (!target.open) return;
      ctx.openLink(url);
      respond(p, { action: "accept" });
      return;
    }
    const r = formContent(fields ?? [], values);
    if ("error" in r) setErr(r.error);
    else respond(p, { action: "accept", content: r.content });
  };
  return (
    <div class="card dialog-card elicitation">
      <div class="card-title row">
        <span>{str(p.input.title) || `${server} asks`}</span>
        <button class="icon close" title="Close: cancel" onClick={() => respond(p, { action: "cancel" })}>
          ×
        </button>
      </div>
      <p>{str(p.input.message)}</p>
      {target && (
        <div class="url-host">
          {server} asks to open <b>{target.host}</b>
        </div>
      )}
      {url && <div class="muted url">{url}</div>}
      {target && !target.open && <div class="muted">Not opened from here: {target.why}. Decline it, or open it yourself if you trust it.</div>}
      {fields && fields.length > 0 && (
        <div class="fields">
          {fields.map((f) => (
            <Field key={f.name} f={f} value={values[f.name]} set={(v) => (setValues({ ...values, [f.name]: v }), setErr(null))} />
          ))}
        </div>
      )}
      {!fields && <div class="muted">This form asks for something this panel cannot show; decline it, or answer it in a terminal.</div>}
      <div class="actions">
        {fields && (!target || target.open) && (
          <button class="primary" onClick={accept}>
            {url ? "Open" : "Accept"}
          </button>
        )}
        <button onClick={() => respond(p, { action: "decline" })}>Decline</button>
        {err && <span class="err">{err}</span>}
      </div>
    </div>
  );
}

/** The card for a dialog or an elicitation. */
export function DialogCard({ p, ctx, recall }: { p: Pending; ctx: ToolCtx; recall: () => void }) {
  if (p.form === "elicitation") return <ElicitationCard p={p} ctx={ctx} />;
  if (p.toolName === "refusal_fallback_prompt") return <RefusalCard p={p} recall={recall} />;
  return <AutoModeCard p={p} ctx={ctx} />;
}

/** A dialog's or an elicitation's one line, while it waits on the owner's typing (55). */
export function dialogLine(p: Pending): string {
  if (p.form === "elicitation") return `${p.toolName || str(p.input.display_name)} asks: ${str(p.input.message)}`;
  if (p.toolName === "refusal_fallback_prompt") return `Session paused: ${modelName(str(p.input.originalModel))} flagged a message`;
  return "Auto mode: Continue or Stop?";
}
