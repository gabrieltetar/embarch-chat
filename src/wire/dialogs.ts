// What the CLI asks the panel besides permission prompts (decision 66). A
// control request the CLI sends waits for an answer, and the turn waits with
// it: one the panel cannot show is answered at once, never left unanswered.
//
// Measured on CLI 2.1.287: an MCP server's `elicitation` comes to any
// stream-json client that answers permission prompts (`--permission-prompt-
// tool=stdio`), unasked; a `request_user_dialog` comes only for a kind some
// client declared in `initialize.supportedDialogKinds` — undeclared, the CLI
// takes its no-dialog path instead (auto mode goes on; a flagged message ends
// the turn with the refusal error).

/**
 * The dialog kinds this panel renders, declared in `initialize`. Claude
 * Code's own panel (2.1.309) declares these two and one for a model the owner
 * never uses; `auto_mode_outside_reads`, which the CLI also knows, it does not.
 */
export const DIALOG_KINDS = ["auto_mode_server_fallback", "refusal_fallback_prompt"];

/** The subtypes `reduce` folds into what waits on the owner; any other is answered with an error. */
export function answerable(request: { subtype?: string; dialog_kind?: string } | undefined): boolean {
  if (!request) return false;
  if (request.subtype === "can_use_tool" || request.subtype === "elicitation") return true;
  return request.subtype === "request_user_dialog" && DIALOG_KINDS.includes(String(request.dialog_kind));
}

/** A dialog's answer: the owner's choice, or cancelled (closed, or a kind not declared — Claude Code's own panel answers those so). */
export const dialogChoice = (result: string) => ({ behavior: "completed", result });
export const DIALOG_CANCELLED = { behavior: "cancelled" };

/** The one-line note for a request the panel answered without showing it. */
export function unansweredNote(request: { subtype?: string; dialog_kind?: string; mcp_server_name?: string } | undefined): string {
  const what = request?.subtype === "request_user_dialog" ? `a "${request.dialog_kind}" dialog` : `"${request?.subtype ?? "unknown"}"`;
  return `Claude Code asked this panel for ${what}, which it cannot show: declined.`;
}

/** The auto-mode notice's words when its payload brings none (Claude Code's own). */
export const AUTO_MODE_FALLBACK_TEXT =
  "Auto mode is using Claude Code's built-in classifier in this session, and those classifier requests are billed. Continue to keep going in auto mode, or Stop to end this turn.";

/** A help link the notice may show: https on claude.com or anthropic.com only, as Claude Code's panel allows. */
export function helpUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" && ["claude.com", "anthropic.com"].some((h) => hostname === h || hostname.endsWith(`.${h}`)) ? u : null;
  } catch {
    return null;
  }
}

/** A refused message's words, as Claude Code's panel puts them. */
export function refusalText(originalModel: string, fallbackModel: string): string {
  return `${originalModel}'s safeguards flagged this message. This sometimes happens with safe, normal conversations. Edit and retry, or continue with ${fallbackModel}.`;
}

/** One field of an elicitation form: the flat primitives MCP allows. */
export interface FormField {
  name: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  options?: string[];
  required: boolean;
  default?: unknown;
}

/** The fields of an elicitation's requested schema; null when it holds one this panel cannot render. */
export function formFields(schema: Record<string, unknown> | undefined): FormField[] | null {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema!.required as string[]) : []);
  const out: FormField[] = [];
  for (const [name, p] of Object.entries(props)) {
    if (!p || typeof p !== "object") return null;
    const options = Array.isArray(p.enum) ? p.enum.map(String) : Array.isArray(p.oneOf) ? (p.oneOf as Array<{ const?: unknown }>).map((o) => String(o.const)) : null;
    const type = options ? "enum" : p.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "enum") return null;
    out.push({
      name,
      title: typeof p.title === "string" ? p.title : name,
      description: typeof p.description === "string" ? p.description : undefined,
      type,
      ...(options ? { options } : {}),
      required: required.has(name),
      ...(p.default !== undefined ? { default: p.default } : {}),
    });
  }
  return out;
}

/** A form's values as the schema's types, or the first field that is missing or wrong. */
export function formContent(fields: FormField[], values: Record<string, string | boolean>): { content: Record<string, unknown> } | { error: string } {
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === "boolean") {
      content[f.name] = v === true;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) {
      if (f.required) return { error: `${f.title} is required` };
      continue;
    }
    if (f.type === "number" || f.type === "integer") {
      const n = Number(s);
      if (!Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) return { error: `${f.title} must be ${f.type === "integer" ? "a whole number" : "a number"}` };
      content[f.name] = n;
    } else content[f.name] = s;
  }
  return { content };
}

/**
 * A link an MCP server's elicitation may open (decision 66): https, to a
 * host that is not this machine — a server must not get a click that
 * reaches a local service (the desk, embarch-ui) or a plain-http page.
 */
export function elicitedUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // The URL parser has already turned 127.1, 2130706433 and [::ffff:127.0.0.1] into their plain forms.
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (u.protocol !== "https:" || !host) return false;
  return !(host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "0.0.0.0" || host === "::1" || host === "::" || /^::ffff:7f/.test(host));
}
