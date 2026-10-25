// What a step touched (embarch-chat decision 87): a step that reaches a
// connector — Linear, GitHub, Slack, the Desk, the bench — names the thing
// it touched, as a link: `ABC-154 Make the widget blink`, `#36 Blink`,
// `#channel`, a work item's card, a board or a study. The tool name stays
// the muted tag it was (decision 50); a folded run lists the things its
// steps touched. Pure, so the node tests run it; tools.tsx draws it.
//
// Where each name and link comes from, verified against the tools:
// - the desk plugin's `linear_*`: its routes' JSON — `linear_get_issue`
//   `{key, title, url, state, ...}`, `linear_search` `{issues: [the same]}`,
//   `linear_set_status` `{key, state}`, a draft `{draft_id, status}`
//   (embarch-desk's src/server.rs and src/linear.rs);
// - a `linear-*` MCP server: `get_issue` and `save_issue` answer
//   `{id: "ABC-123", title, url, status, ...}`, `save_comment` the comment
//   alone, so its issue is the `issueId` it was given;
// - `gh pr|issue view` piped: `title:\t…` and `url:\t…` lines (an issue's
//   has no url), `--json` and `gh api` an object, `gh pr create|comment|edit`
//   the URL it made (the first printed), `gh pr close|reopen|ready` and `gh
//   issue close|reopen` gh's status line naming it, `✓ Closed pull request
//   owner/repo#36 (Blink)` (gh 2.92's own strings, as it prints them with no
//   terminal: `merge` only its `!` warning, `review` none; none of them a
//   URL). A `gh` step's repo is the one it names — `-R`/`--repo`,
//   `GH_REPO=` — or the one its own output names; else `#36` shows alone,
//   untitled and unlinked. It is never inferred from where the shell was:
//   Claude Code's shell keeps its cwd from one Bash step to the next, and
//   the chat's folder moves with each turn's init and a reopen, so no
//   reading of `cd`s is certain — and a link to the wrong PR is worse than
//   none (decision 87);
// - a `slack_*` read: "Channel: name (ID)" and "Permalink: [link](…)";
// - the desk's `desk_*`: `{item_id, title}`, `{id}`, `{work_item: {id,
//   title}}`, `{tile: "<item>@<day>"}`, and the brief's first line
//   "Work item <id>: …";
// - `embarch-api`: `study_id` in or out, the board in or in `target`.
// Where a step carries no title or link of its own, the desk's index fills
// it (refs.ts), else the chat's own work item when it is that one; else the
// key alone shows, unlinked.
//
// A URL from outside — a tool's output, a command, the desk's index — is
// a link only as https to the connector's own host; the Desk's and the
// bench's are built here from the extension's own setting.

import type { Entry, ToolEntry } from "../../src/wire/reducer";
import { issueRef, prRef, refsVersion } from "./refs";
import { runHead } from "./runs";

export type Connector = "linear" | "github" | "slack" | "desk" | "bench";

export interface Subject {
  connector: Connector;
  /** The thing, by name: an issue key, `#36`, `#channel`, a card's title, a board, `study st-42`. */
  label: string;
  /** Its title when the label is a key or a number. */
  title?: string;
  /** Where a click goes; none, and the subject is shown, not linked. */
  url?: string;
  /** What the link opens, for its hover. */
  where?: string;
  /** The same thing touched twice is one entry in a run's list. */
  id: string;
}

/** The chat's own work item, from its header (decision 18). */
export interface OwnItem {
  itemId: string | null;
  title: string;
  issueKey?: string;
  issueUrl?: string;
}

export interface SubjectEnv {
  /** embarch-ui's address, which also serves the Desk: the extension's own setting. */
  uiUrl?: string;
  own?: OwnItem | null;
}

type Step = Pick<ToolEntry, "name" | "input" | "result">;
type Obj = Record<string, unknown>;

const KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const key = (v: unknown): string | undefined => {
  const s = str(v);
  return s && KEY.test(s) ? s.toUpperCase() : undefined;
};

function json(text: string | undefined): unknown {
  const s = text?.trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const HOSTS: Record<"linear" | "github" | "slack", (host: string) => boolean> = {
  linear: (h) => h === "linear.app",
  github: (h) => h === "github.com",
  slack: (h) => h === "slack.com" || h.endsWith(".slack.com"),
};

/** A URL from outside as a link: https to the connector's own host, no credentials or port; anything else is none. */
export function outsideLink(connector: "linear" | "github" | "slack", url: unknown): string | undefined {
  const s = str(url);
  if (!s) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
  return HOSTS[connector](u.hostname.toLowerCase()) ? u.href : undefined;
}

/** A page of embarch-ui, which serves the Desk too, at the extension's own address (decision 15). */
function uiLink(env: SubjectEnv, hash: string): string | undefined {
  const base = env.uiUrl;
  return base && /^https?:\/\//.test(base) ? `${base.replace(/\/?$/, "/")}#${hash}` : undefined;
}

// ------------------------------------------------------------ Linear

function issue(k: string, have: { title?: string; url?: string }, env: SubjectEnv): Subject {
  const ref = issueRef(k);
  const own = env.own?.issueKey?.toUpperCase() === k ? env.own : null;
  return {
    connector: "linear",
    label: k,
    title: have.title ?? ref?.title ?? own?.title ?? undefined,
    url: outsideLink("linear", have.url) ?? outsideLink("linear", ref?.url) ?? outsideLink("linear", own?.issueUrl),
    where: "Linear",
    id: `linear:${k}`,
  };
}

/** An issue a result is, when it is the one asked for (or none was named). */
function issueFrom(r: Obj | undefined, asked: string | undefined, env: SubjectEnv, idField: "key" | "id"): Subject | null {
  const got = key(r?.[idField]) ?? key(r?.identifier);
  const k = asked ?? got;
  if (!k) return null;
  return issue(k, got === k ? { title: str(r?.title), url: str(r?.url) } : {}, env);
}

/** The desk plugin's `linear_*` tools. */
function deskLinear(tool: string, input: Obj, result: string | undefined, env: SubjectEnv): Subject | null {
  const r = obj(json(result));
  switch (tool) {
    case "linear_get_issue":
    case "linear_set_status":
      return issueFrom(r, key(input.key), env, "key");
    case "linear_draft_comment":
      return issueFrom(undefined, key(input.issue_key), env, "key");
    case "linear_search": {
      const found = Array.isArray(r?.issues) ? r.issues : [];
      if (found.length === 1) return issueFrom(obj(found[0]), undefined, env, "key");
      return issueFrom(undefined, key(input.query), env, "key");
    }
    case "linear_draft_issue": {
      // Not an issue yet: the draft waits on the Desk tab for the owner's Send.
      const title = str(input.title);
      return title ? { connector: "linear", label: "New issue", title, url: uiLink(env, "desk"), where: "the Desk, where it waits", id: `linear:draft:${title}` } : null;
    }
  }
  return null;
}

/** A `linear-*` MCP server's tool: the issue it names, else what its result is, by name and link. */
function linearServer(tool: string, input: Obj, result: string | undefined, env: SubjectEnv): Subject | null {
  const r = obj(json(result));
  // `id` is an issue's only on an issue's own tools: an initiative's I-123 looks like a key too.
  const own = /^(?:get|save|share|unshare)_issue$/.test(tool);
  const asked = key(input.issueId) ?? key(input.issue) ?? (own ? key(input.id) : undefined);
  const s = issueFrom(own ? r : undefined, asked, env, "id");
  if (s) return s;
  // A project, a document: a name and a Linear link of its own.
  const name = str(r?.title) ?? str(r?.name);
  const url = outsideLink("linear", r?.url);
  return name && url ? { connector: "linear", label: name, url, where: "Linear", id: `linear:${url}` } : null;
}

// ------------------------------------------------------------ GitHub

export interface GhCall {
  kind: "pr" | "issue";
  action: string;
  number?: number;
  repo?: string;
}

/** A command line's words up to the end of its first command: quotes and escapes read, `;`, `&`, `|`, `)` and a line end stop it. */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/[;&|)\n]/.test(c)) break;
    else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Words before a command that leave it the command: `then gh …`, `sudo gh …`. */
const PREFIX = new Set(["then", "do", "else", "elif", "time", "nohup", "sudo", "env", "exec", "command", "!", "{"]);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * Each `gh` a command line runs, where its words start: only a `gh` in a
 * command's place — after the line's start, `;`, `&`, `|`, `(`, a backquote
 * or a line end, and any `NAME=value` — never one inside quotes, as in
 * `git commit -m "follow-up to gh pr view 3"`, nor one that is an argument.
 * With each, the `GH_REPO` it runs with (its own `GH_REPO=…` or an earlier
 * `export GH_REPO=…`).
 */
function ghRuns(s: string): Array<{ at: number; ghRepo?: string }> {
  const out: Array<{ at: number; ghRepo?: string }> = [];
  let q: string | null = null;
  let word = "";
  let has = false;
  let quoted = false;
  /** The next word is in a command's place. */
  let head = true;
  let exporting = false;
  let exported: string | undefined;
  let own: string | undefined;
  const end = (at: number) => {
    if (!has) return;
    const w = word;
    word = "";
    has = false;
    const isQuoted = quoted;
    quoted = false;
    const a = ASSIGN.exec(w);
    if (head) {
      if (a) {
        if (a[1] === "GH_REPO") own = a[2];
        return;
      }
      if (PREFIX.has(w) && !isQuoted) return;
      head = false;
      if (isQuoted) return;
      if (w === "gh") out.push({ at, ghRepo: own ?? exported });
      else if (w === "export") exporting = true;
      return;
    }
    if (exporting && a?.[1] === "GH_REPO") exported = a[2];
  };
  const stop = () => {
    head = true;
    exporting = false;
    own = undefined;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) word += s[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
      quoted = true;
    } else if (c === "\\" && i + 1 < s.length) {
      word += s[++i];
      has = true;
    } else if (c === "$" && s[i + 1] === "(") {
      end(i);
      stop();
      i++;
    } else if (/[;&|()`\n]/.test(c)) {
      end(i);
      stop();
    } else if (/\s/.test(c)) end(i);
    else {
      word += c;
      has = true;
    }
  }
  end(s.length);
  return out;
}

/** gh's flags that take a value: the word after one is never the PR. `-m` and `-r` are left out — on `merge` they take none. */
const VALUE_FLAGS = new Set([
  "-R", "--repo", "--json", "-q", "--jq", "-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head",
  "-T", "--template", "-a", "--assignee", "-l", "--label", "--reviewer", "--add-label", "--remove-label", "--add-assignee",
  "--remove-assignee", "--add-reviewer", "--remove-reviewer", "--milestone", "-p", "--project", "-X", "--method", "-f", "--field",
  "--raw-field", "--subject", "--match-head-commit", "--author-email", "-A", "-i", "--interval",
]);

const GH_ACTIONS = new Set(["view", "create", "merge", "checks", "comment", "edit", "diff", "close", "reopen", "ready", "review"]);
const GH_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/;

function ghRepo(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const parts = v.replace(/^https?:\/\//, "").split("/").filter(Boolean);
  // HOST/OWNER/REPO names the host too: only github.com's is ours to link.
  if (parts.length === 3 && parts[0].toLowerCase() !== "github.com") return undefined;
  const r = parts.slice(-2).join("/");
  return parts.length >= 2 && parts.length <= 3 && REPO.test(r) ? r : undefined;
}

/** The first `gh pr|issue <action>` or `gh api repos/o/r/(pulls|issues)/N` a command line runs, what it acts on as far as the command says. */
export function ghCall(command: string): GhCall | null {
  for (const run of ghRuns(command)) {
    const w = words(command.slice(run.at));
    if (w[0] === "api") {
      for (const p of w.slice(1)) {
        const a = /^\/?repos\/([\w.-]+\/[\w.-]+)\/(pulls|issues)\/(\d+)(?:[/?#].*)?$/.exec(p);
        if (a) return { kind: a[2] === "pulls" ? "pr" : "issue", action: "api", repo: a[1], number: Number(a[3]) };
      }
      continue;
    }
    if (w[0] !== "pr" && w[0] !== "issue") continue;
    const kind: "pr" | "issue" = w[0];
    const action = w[1];
    if (!action || !GH_ACTIONS.has(action)) continue;
    const call: GhCall = { kind, action };
    for (let i = 2; i < w.length; i++) {
      const t = w[i];
      const eq = /^(--repo|-R)=(.+)$/.exec(t);
      if (eq) call.repo = ghRepo(eq[2]) ?? call.repo;
      else if (t === "-R" || t === "--repo") call.repo = ghRepo(w[++i]) ?? call.repo;
      else if (VALUE_FLAGS.has(t)) i++;
      else if (t.startsWith("-")) continue;
      else if (call.number === undefined) {
        const n = /^#?(\d+)$/.exec(t);
        const u = GH_URL.exec(t);
        if (n) call.number = Number(n[1]);
        else if (u) {
          call.number = Number(u[3]);
          call.repo = call.repo ?? u[1];
          call.kind = u[2] === "pull" ? "pr" : "issue";
        }
      }
    }
    // gh's own `GH_REPO`, set on the command or exported before it, is a repo the command names.
    if (!call.repo && run.ghRepo) call.repo = ghRepo(run.ghRepo);
    return call;
  }
  return null;
}

/**
 * gh's own status line naming what it acted on, as gh 2.92 prints it with
 * no terminal — and under Claude Code it never has one: `close`, `reopen`
 * and `ready` print theirs either way, `✓ Closed pull request
 * owner/repo#36 (Blink)`, `! Pull request owner/repo#36 (Blink) is already
 * closed`, `✓ Pull request owner/repo#36 is marked as "ready for review"`,
 * `✓ Closed issue owner/repo#7 (Flaky)`; `merge` prints only its warning,
 * `! Pull request owner/repo#36 was already merged` — its ✓ lines are a
 * terminal's alone — and `review` nothing. A title, when gh gives one, is
 * in brackets right after the number.
 */
const GH_SAID = /\b(pull request|issue) ([\w.-]+\/[\w.-]+)#(\d{1,7})(?: \(([^\n]*)\))?/gi;
/** Each action's own status lines, whole, as gh prints them with no terminal — ✓ done, ! already so — its colours taken off. */
const GH_STATUS: Partial<Record<string, RegExp>> = {
  close: /^[✓!] (?:Closed (?:pull request|issue) .*|(?:Pull request|Issue) .* is already closed)$/,
  reopen: /^[✓!] (?:Reopened (?:pull request|issue) .*|(?:Pull request|Issue) .* is already open)$/,
  ready: /^[✓!] Pull request .* is (?:marked as "ready for review"|converted to "draft"|already "ready for review"|already "in draft")$/,
  merge: /^! Pull request .* (?:was already merged|is already queued to merge)$/,
};
const GH_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+(?:#[\w-]+)?/;

/** What gh's output says about the PR or issue: `--json`/`gh api`'s object, view's `key:\tvalue` lines, the URL it printed, or its status line. */
function ghResult(call: GhCall, result: string | undefined): { title?: string; url?: string; number?: number; repo?: string } {
  if (!result) return {};
  const j = json(result);
  const o = obj(j);
  if (o) {
    const url = str(o.html_url) ?? str(o.url);
    const u = url ? GH_URL.exec(url) : null;
    return { title: str(o.title), url: u ? url : undefined, number: typeof o.number === "number" ? o.number : u ? Number(u[3]) : undefined, repo: u?.[1] };
  }
  if (j !== undefined) return {};
  const head = result.slice(0, 20_000);
  const line = (k: string) => new RegExp(`^${k}:\\t(.*)$`, "m").exec(head.split(/\n--\n/, 1)[0])?.[1]?.trim() || undefined;
  if (call.action === "view") {
    const url = line("url");
    const u = url ? GH_URL.exec(url) : null;
    const n = line("number");
    const number = n && /^\d+$/.test(n) ? Number(n) : u ? Number(u[3]) : undefined;
    // Its own lines, of the number it named: a later command's view of another is not this one's.
    if (call.number !== undefined && number !== undefined && number !== call.number) return {};
    return { title: line("title"), url: u ? url : undefined, number, repo: u?.[1] };
  }
  // create, comment, edit: the URL it made or acted on, the first one printed — of the number it named, if it named
  // one; a later command's output (a PR's body, its comments) may hold any (decision 87).
  if (call.action === "create" || call.action === "comment" || call.action === "edit") {
    const first = GH_LINK.exec(head)?.[0];
    const u = first ? GH_URL.exec(first) : null;
    if (!u || (call.number !== undefined && Number(u[3]) !== call.number)) return {};
    return { url: first, number: Number(u[3]), repo: u[1] };
  }
  // close, reopen, ready, merge: gh's own status line, the first, by repo, number and title. No URL anywhere in the
  // output is theirs — gh prints none — and review, checks, diff print no line of theirs: a URL or a line there is
  // another command's, or a check's, a diff's, a body's, which may name any PR (decision 87).
  const status = GH_STATUS[call.action];
  if (!status) return {};
  const kind = call.kind === "pr" ? "pull request" : "issue";
  const said = head
    .split("\n")
    .map((l) => l.replace(/\x1b\[[\d;]*m/g, "").trimEnd())
    .filter((l) => status.test(l))
    .flatMap((l) => [...l.matchAll(GH_SAID)])
    .find((m) => m[1].toLowerCase() === kind && (call.number === undefined || Number(m[3]) === call.number));
  return said ? { title: said[4]?.trim() || undefined, number: Number(said[3]), repo: said[2] } : {};
}

function github(call: GhCall, result: string | undefined): Subject | null {
  const r = ghResult(call, result);
  const n = call.number ?? r.number;
  if (n === undefined) return null;
  // The repo the command names, else the one gh's output names — never the chat's folder's, which is not known to be
  // where the shell was. None: `#36` alone, untitled and unlinked; the desk's index is asked only with a repo (decision 87).
  const repo = call.repo ?? r.repo;
  const ref = call.kind === "pr" && repo ? prRef(n, repo) : null;
  const made = repo ? `https://github.com/${repo}/${call.kind === "pr" ? "pull" : "issues"}/${n}` : undefined;
  return {
    connector: "github",
    label: `#${n}`,
    title: r.title ?? ref?.title,
    url: outsideLink("github", r.url) ?? outsideLink("github", made) ?? outsideLink("github", ref?.url),
    where: "GitHub",
    id: `github:${(repo ?? ref?.repo ?? "").toLowerCase()}#${n}`,
  };
}

/** A WebFetch of a GitHub PR or issue page, or a Linear issue's. */
function fetched(input: Obj, env: SubjectEnv): Subject | null {
  const gh = outsideLink("github", input.url);
  const u = gh ? GH_URL.exec(gh) : null;
  if (u) return github({ kind: u[2] === "pull" ? "pr" : "issue", action: "fetch", repo: u[1], number: Number(u[3]) }, undefined);
  const li = outsideLink("linear", input.url);
  const l = li ? /^https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?:[/?#]|$)/.exec(li) : null;
  return l ? issue(l[1].toUpperCase(), { url: li }, env) : null;
}

// ------------------------------------------------------------ Slack

const SLACK_URL = /https:\/\/(?:[\w-]+\.)*slack\.com\/[^\s)\]>"'|\\]+/g;

function slack(tool: string, input: Obj, result: string | undefined): Subject | null {
  // A search's permalinks are its hits', not one thing it touched.
  if (/^slack_search_/.test(tool) || tool === "slack_read_user_profile") return null;
  const r = obj(json(result));
  const body = (str(r?.messages) ?? str(r?.results) ?? (r ? "" : (result ?? ""))).slice(0, 20_000);
  const links = [...[...body.matchAll(SLACK_URL)].map((m) => m[0]), r?.permalink, r?.message_link, r?.link, r?.channel_link, r?.url]
    .map((l) => outsideLink("slack", l))
    .filter((x): x is string => !!x);
  if (/canvas/.test(tool)) {
    const name = str(input.title) ?? "canvas";
    const id = str(input.canvas_id) ?? name;
    return { connector: "slack", label: name, url: links[0], where: "Slack", id: `slack:canvas:${id}` };
  }
  const ch = str(input.channel_id);
  if (!ch) return null;
  const name = /^Channel:\s*#?([^\s(]+)/m.exec(body)?.[1] ?? str(r?.channel_name);
  const dm = /^[UWD]/.test(ch);
  // The message's permalink — the one it names by ts, or the one a sent message got — else the channel's own link,
  // else Slack's redirect to the channel. A read's other permalinks are its messages', not the channel.
  const ts = str(input.message_ts) ?? str(input.thread_ts);
  const sent = /^slack_(?:send|schedule)_message/.test(tool);
  const permalink = (ts ? links.find((l) => l.includes(`/archives/${ch}/p${ts.replace(".", "")}`)) : undefined) ?? (sent ? links.find((l) => /\/archives\/\w+\/p\d+/.test(l)) : undefined);
  const channelLink = links.find((l) => l.includes(`/client/`) && l.includes(ch));
  const redirect = /^[CGD][A-Z0-9]{2,}$/.test(ch) ? `https://slack.com/app_redirect?channel=${encodeURIComponent(ch)}` : undefined;
  return {
    connector: "slack",
    label: dm ? "DM" : `#${name ?? ch}`,
    url: permalink ?? channelLink ?? redirect,
    where: "Slack",
    id: `slack:${ch}`,
  };
}

// ------------------------------------------------------------ the Desk

function card(itemId: string | undefined, title: string | undefined, env: SubjectEnv): Subject | null {
  const own = env.own;
  const name = title ?? (own && (!itemId || own.itemId === itemId) ? own.title : undefined);
  const id = itemId ?? (name && own?.title === name ? (own.itemId ?? undefined) : undefined);
  if (!name && !id) return null;
  return { connector: "desk", label: name ?? id!, url: uiLink(env, `desk${id ? `?item=${encodeURIComponent(id)}` : ""}`), where: "the Desk", id: `desk:${id ?? name}` };
}

/** The desk plugin's `desk_*` tools: the work item, by its name, linking to its card on the Desk. */
function desk(tool: string, input: Obj, result: string | undefined, env: SubjectEnv): Subject | null {
  const r = obj(json(result));
  const own = env.own && env.own.itemId ? env.own : null;
  switch (tool) {
    case "desk_set_work_item":
    case "desk_timer_start":
      if (r?.untracked === true) return null;
      return card(str(r?.item_id) ?? str(input.item_id), str(r?.title) ?? str(input.new_title) ?? key(input.issue_key), env);
    case "desk_create_item":
      return card(str(r?.id), str(input.title) ?? key(input.issue_key), env);
    case "desk_link":
      return card(str(input.item_id), undefined, env);
    case "desk_whoami": {
      const w = obj(r?.work_item);
      return w ? card(str(w.id), str(w.title), env) : null;
    }
    case "desk_work_item": {
      // The brief's first line: "Work item w12: ABC-154 Its title — In Progress (url)", or "…: Its title (no Linear issue)".
      const m = /^Work item (\S+): (.+)$/m.exec(result ?? "");
      if (!m) return null;
      const title = m[2].replace(/ \(no Linear issue\)$/, "").replace(/ — [^—]*\(https?:[^)]*\)$/, "").replace(/^[A-Z][A-Z0-9]{0,9}-\d+ /, "");
      return card(m[1], title, env);
    }
    case "desk_add_line": {
      // On the session's own item: the tile it landed on names it, `<item>@<day>`; a held line lands there once assigned.
      const tile = str(r?.tile);
      return card(tile ? tile.split("@", 1)[0] : (own?.itemId ?? undefined), undefined, env);
    }
    case "desk_open": {
      const d = str(input.desk);
      return d && d !== "none" ? { connector: "desk", label: `desk ${d}`, url: uiLink(env, "desk"), where: "the Desk", id: `desk:open:${d}` } : null;
    }
  }
  return null;
}

// ------------------------------------------------------------ the bench

const ROLE: Record<string, string> = { dut: "DUT", "dev-bench": "dev bench" };

/** An `embarch-api` tool: the study it ran or read, else the board it acted on (decision 15's pages). */
function bench(tool: string, input: Obj, result: string | undefined, env: SubjectEnv): Subject | null {
  const r = obj(json(result));
  const study = str(input.study_id) ?? str(r?.study_id);
  if (study) return { connector: "bench", label: `study ${study}`, url: uiLink(env, `live-study?study=${encodeURIComponent(study)}`), where: "Live Study", id: `bench:study:${study}` };
  const target = obj(r?.target) ?? obj(obj(r?.build)?.target);
  const role = str(input.role) ?? (/(^dev_bench_|_dev_bench$)/.test(tool) ? "dev-bench" : tool === "mem_read" ? "dut" : undefined);
  // enroll_probe's `name` is what the board is called; another tool's is a signal's or a tap's.
  const label = str(input.board) ?? str(target?.board) ?? (tool === "enroll_probe" ? str(input.name) : undefined) ?? (role ? (ROLE[role] ?? role) : undefined);
  return label ? { connector: "bench", label, url: uiLink(env, `topology?board=${encodeURIComponent(role ?? label)}`), where: "Topology", id: `bench:board:${label}` } : null;
}

// ------------------------------------------------------------ a step, a run

/**
 * What a step touched, read once per step: the reducer replaces an entry
 * that changes, so it is kept by the entry — and by the desk's index and
 * the env it was read with, either of which can change what it names.
 * Every render asks again (a row, a run's list); its JSON is parsed once.
 */
const read = new WeakMap<Step, { refs: number; env: string; s: Subject | null }>();
const envKey = (e: SubjectEnv) => [e.uiUrl, e.own?.itemId, e.own?.title, e.own?.issueKey, e.own?.issueUrl].map((x) => x ?? "").join("\u0000");

/** What a step touched, or null for a step that touches no connector (or none by name). */
export function stepSubject(t: Step, env: SubjectEnv): Subject | null {
  const refs = refsVersion();
  const key = envKey(env);
  const hit = read.get(t);
  if (hit && hit.refs === refs && hit.env === key) return hit.s;
  const s = subjectOf(t, env);
  read.set(t, { refs, env: key, s });
  return s;
}

function subjectOf(t: Step, env: SubjectEnv): Subject | null {
  const input = t.input ?? {};
  if (t.name === "Bash") {
    const call = typeof input.command === "string" ? ghCall(input.command) : null;
    return call ? github(call, t.result) : null;
  }
  if (t.name === "WebFetch") return fetched(input, env);
  const m = /^mcp__(.+?)__(.+)$/.exec(t.name);
  if (!m) return null;
  const [, server, tool] = m;
  if (/(?:^|[_-])embarch-desk$/.test(server)) {
    if (tool.startsWith("linear_")) return deskLinear(tool, input, t.result, env);
    if (tool.startsWith("desk_")) return desk(tool, input, t.result, env);
    return null;
  }
  if (/(?:^|[_-])embarch-api$/.test(server)) return bench(tool, input, t.result, env);
  if (/^linear(?:[-_].*)?$/i.test(server) || /[_-]linear$/i.test(server)) return linearServer(tool, input, t.result, env);
  if (tool.startsWith("slack_")) return slack(tool, input, t.result);
  return null;
}

/** Two sightings of one thing: what either knows. */
function merge(a: Subject, b: Subject): Subject {
  return { ...a, title: a.title ?? b.title, url: a.url ?? b.url, where: a.url ? a.where : (b.where ?? a.where) };
}

/**
 * What a folded run's steps touched (decision 50): each thing once, in the
 * order first touched, at most `max` and how many more. Its head — the
 * latest step, whose line the row shows — names its own, so it is left out.
 */
export function runSubjects(steps: readonly Entry[], env: SubjectEnv, max = 3): { shown: Subject[]; more: number } {
  const head = runHead(steps);
  const skip = head ? stepSubject(head, env) : null;
  const all: Subject[] = [];
  for (const e of steps) {
    if (e.kind !== "tool") continue;
    const s = stepSubject(e, env);
    if (!s || (skip && same(s, skip))) continue;
    const i = all.findIndex((x) => same(x, s));
    if (i < 0) all.push(s);
    else all[i] = merge(all[i], s);
  }
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/**
 * One thing: the same id. A PR one step named without its repo stays apart
 * from one another step named with it — taking it for that one is a guess
 * across steps, and a wrong link is worse than none (87).
 */
function same(a: Subject, b: Subject): boolean {
  return a.id === b.id;
}
