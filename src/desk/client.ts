// The desk, from the extension's Node side only (decision 20): loopback HTTP
// with the desk's bearer token, which never reaches a webview — a webview is
// a page (embarch-desk decision 28). Every call here is one route of the
// desk's interface (embarch-chat-desk-proposal.md, "Interface").

import * as fs from "fs";
import * as http from "http";
import * as os from "os";

export interface DeskOptions {
  baseUrl: string;
  tokenPath: string;
  timeoutMs?: number;
}

export class DeskError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
  /** The desk is not running (or not reachable): 0. */
  get unreachable(): boolean {
    return this.status === 0;
  }
  /** Not called at all: the URL is not this machine's: -1. */
  get refused(): boolean {
    return this.status === -1;
  }
}

/**
 * The desk's URL, when it is this machine's: plain http on a loopback
 * address. The desk runs beside the window and its token is a key to the
 * owner's Linear, Harvest and chats, so nothing else is ever called with it
 * — whatever a setting says.
 */
export function loopbackUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? u : null;
}

export interface MailboxEntry {
  id: string;
  kind: "start" | "focus";
  item_id?: string;
  session_id?: string;
  folder: string;
  prompt?: string;
  [k: string]: unknown;
}

export type AssignBody = { item_id: string } | { issue_key: string } | { new_title: string; desk?: string } | { untracked: true };

/** The `client` mark of a session this panel runs (desk Interface: assign "gains client"). */
export const CLIENT = "embarch-chat";

/** A desk name no desk has: `/view?desk=` with it is a 404 on a desk that reads the parameter. */
const NO_SUCH_DESK = "embarch-chat: no such desk";

/**
 * A `/view?desk=` the desk refused for the desk it names — none by that
 * name (404 today), or any other 4xx. Not the token (401), which is no
 * answer about the desk at all.
 */
export function refusesDesk(e: unknown): boolean {
  return e instanceof DeskError && e.status >= 400 && e.status < 500 && e.status !== 401;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? os.homedir() + p.slice(1) : p;
}

export class DeskClient {
  private token: string | null = null;

  constructor(private opts: DeskOptions) {}

  private readToken(force = false): string | null {
    if (this.token && !force) return this.token;
    try {
      this.token = fs.readFileSync(expandHome(this.opts.tokenPath), "utf8").trim() || null;
    } catch {
      this.token = null;
    }
    return this.token;
  }

  /** Why this client calls nothing, or null when its URL is this machine's. */
  get refusal(): string | null {
    return loopbackUrl(this.opts.baseUrl) ? null : `the desk URL ${JSON.stringify(this.opts.baseUrl)} is not this machine (http on 127.0.0.1, ::1 or localhost); nothing is sent to it`;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const base = loopbackUrl(this.opts.baseUrl);
    if (!base || !path.startsWith("/")) throw new DeskError(this.refusal ?? `not a desk route: ${path}`, -1);
    const url = new URL(path, base);
    // Checked before the token is read: it never leaves for another host.
    if (url.host !== base.host) throw new DeskError(`not a desk route: ${path}`, -1);
    const token = this.readToken();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        url,
        {
          method,
          timeout: this.opts.timeoutMs ?? 5000,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          },
        },
        (r) => {
          let text = "";
          r.setEncoding("utf8");
          r.on("data", (d) => (text += d));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, text }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("the desk did not answer in time")));
      req.on("error", (e) => reject(new DeskError(`desk unreachable: ${e.message}`, 0)));
      if (payload) req.write(payload);
      req.end();
    });
    let parsed: unknown = undefined;
    try {
      parsed = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      parsed = res.text;
    }
    if (res.status === 401 && !retried) {
      // The token file may have been rewritten since it was read.
      this.readToken(true);
      return this.call<T>(method, path, body, true);
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = (parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : res.text) || `HTTP ${res.status}`;
      throw new DeskError(msg, res.status, parsed);
    }
    return parsed as T;
  }

  // ---------------------------------------------------------------- reads

  /** The desk's view; with `desk`, that desk's cards instead of the open desk's (decision 9) — a 404 once that desk is deleted. */
  view(desk?: string | null): Promise<DeskView> {
    return this.call<DeskView>("GET", desk ? `/view?desk=${encodeURIComponent(desk)}` : "/view");
  }

  /**
   * Whether this desk reads `/view?desk=` (desk b722b3b and later). Asked
   * for a desk no one has, it refuses: 404 today, and any refusal of the
   * request (`refusesDesk`) counts, as the Interface does not pin the
   * status. An older desk ignores the parameter and answers with the open
   * desk's cards, which a window on another desk must not show as its own.
   */
  async readsDeskParam(): Promise<boolean> {
    try {
      await this.call("GET", `/view?desk=${encodeURIComponent(NO_SUCH_DESK)}`);
      return false;
    } catch (e) {
      if (refusesDesk(e)) return true;
      throw e;
    }
  }

  session(sid: string): Promise<{ session_id: string; cwd: string; untracked: boolean; client?: string | null; work_item: { id: string; title: string } | null }> {
    return this.call("GET", `/sessions/${encodeURIComponent(sid)}`);
  }

  /**
   * Whether the desk has a session as this panel's: it echoes `client` in
   * GET /sessions/{sid} (desk b722b3b and later). An older desk keeps no
   * client, and a session it never heard of is not marked.
   */
  async isMarked(sid: string): Promise<boolean> {
    try {
      return (await this.session(sid)).client === CLIENT;
    } catch (e) {
      if (e instanceof DeskError && e.status === 404) return false;
      throw e;
    }
  }

  states(itemId: string): Promise<{ states: Array<{ id: string; name: string; type: string }> }> {
    return this.call("GET", `/items/${encodeURIComponent(itemId)}/states`);
  }

  async mailbox(folder: string): Promise<MailboxEntry[]> {
    const r = await this.call<unknown>("GET", `/mailbox?folder=${encodeURIComponent(folder)}`);
    if (Array.isArray(r)) return r as MailboxEntry[];
    if (r && typeof r === "object") {
      for (const k of ["entries", "mailbox", "pending"]) {
        const v = (r as Record<string, unknown>)[k];
        if (Array.isArray(v)) return v as MailboxEntry[];
      }
    }
    return [];
  }

  // ---------------------------------------------------------------- writes

  /** Binds a session to its work item before `claude` starts (decision 10), marked as this panel's. */
  assign(sid: string, body: AssignBody): Promise<{ item_id?: string; title?: string; untracked?: boolean }> {
    return this.call("POST", `/sessions/${encodeURIComponent(sid)}/assign`, { ...body, client: CLIENT });
  }

  /**
   * Marks a session as this panel's without touching its work item — for a
   * chat resumed here: an assign with an item or `untracked` moves it, and
   * `untracked` clears its spans, the time of its open tiles. So the assign
   * carries `client` alone. The desk's Interface does not say what it
   * answers to that: desk b722b3b applies `client` first and then answers
   * 400 for the missing item; a later desk may answer 200. Neither answer
   * is taken as the mark: it is read back from the session. True when the
   * desk has it; false when it does not keep it (an older desk).
   */
  async markClient(sid: string): Promise<boolean> {
    try {
      await this.call("POST", `/sessions/${encodeURIComponent(sid)}/assign`, { client: CLIENT });
    } catch (e) {
      // Whatever it says about the item; not the desk being away, the URL refused or the token wrong.
      if (!(e instanceof DeskError) || e.unreachable || e.refused || e.status === 401 || e.status >= 500) throw e;
    }
    return this.isMarked(sid);
  }

  setStatus(itemId: string, stateId: string): Promise<unknown> {
    return this.call("POST", `/items/${encodeURIComponent(itemId)}/status`, { state_id: stateId });
  }

  /** The entry, once; null when another window took it first (409). */
  async take(id: string): Promise<MailboxEntry | null> {
    try {
      const r = await this.call<unknown>("POST", `/mailbox/${encodeURIComponent(id)}/take`);
      if (r && typeof r === "object" && "entry" in r) return (r as { entry: MailboxEntry }).entry;
      return r as MailboxEntry;
    } catch (e) {
      if (e instanceof DeskError && e.status === 409) return null;
      throw e;
    }
  }

  /** Leaves a focus request for the window whose folder runs a chat (Jump to another window's chat). */
  postFocus(sessionId: string, folder: string): Promise<{ id: string }> {
    return this.call("POST", "/mailbox", { kind: "focus", session_id: sessionId, folder });
  }
}

// ------------------------------------------------------------------- shapes

export interface IssueRef {
  key: string;
  url: string;
  title: string;
  state_id?: string;
  state_name?: string;
  state_type?: string;
}

export interface PrRef {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  draft?: boolean;
}

export interface ViewSession {
  session_id: string;
  name?: string;
  /** The contract's field; today's desk sends `status`. */
  state?: string;
  status?: string;
  waiting_for?: string | null;
  last_ms?: number;
  last_reply_ms?: number;
  cwd?: string;
  client?: string | null;
  folder_uri?: string;
  session_uri?: string;
}

export interface ViewTile {
  id: string;
  date: string;
  seconds?: number;
  hours?: number;
  status?: string;
}

export interface ViewCard {
  id: string;
  title: string;
  issue: IssueRef | null;
  repo_path: string | null;
  prs: PrRef[];
  pinned?: boolean;
  last_activity_ms: number;
  logged_today?: number;
  live_sessions: ViewSession[];
  tiles: ViewTile[];
  desk_id?: string | null;
  /**
   * When the item's notes last changed (null: none yet). A client that shows
   * notes re-reads `/items/{id}/notes` only when it moves; this panel shows
   * none yet, so nothing reads it.
   */
  notes_ms?: number | null;
}

export interface ViewDesk {
  id: string;
  name: string;
  firmware_repos: string[];
  github_repos?: string[];
}

export interface DeskView {
  now_ms: number;
  today: string;
  window_days?: number;
  cards: ViewCard[];
  desks: ViewDesk[];
  open_desk: ViewDesk | null;
  ignore?: string[];
  sessions_waiting?: number;
  /** Every live session the desk tracks, on a card or not (the desk's addition for this panel). */
  sessions?: Array<ViewSession & { item_id?: string | null; desk_id?: string | null; untracked?: boolean }>;
  settings?: { chat_panel?: boolean };
}
