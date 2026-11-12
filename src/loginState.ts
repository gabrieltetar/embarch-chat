// One pick decides a window's login for every Claude surface in it
// (decision 106). The window's pick and each chat's login are mirrored into
// one small file that `claude-login`, the wrapper Claude Code's panel and the
// terminals start `claude` through, reads too: it holds the configured
// logins' folders, each window folder's pick and the login every chat
// started on, so a resume runs on that login wherever it happens.

import * as fs from "fs";
import * as path from "path";
import { expandHome } from "./desk/client";
import type { LoginConfig } from "./logins";

export const LOGIN_STATE_PATH = "~/.config/embarch-chat/logins.json";
/** Chats kept on record, oldest dropped first: a transcript lasts 30 days (12), and this is several months of chats. */
export const SESSIONS_KEPT = 3000;

export interface LoginState {
  /** Each configured login's folder, absolute; null for the CLI's default folder. */
  logins: Record<string, string | null>;
  /** The login picked for a window, by each of its folders (absolute). No entry: the folder rule applies. */
  folders: Record<string, string>;
  /** The login each chat started on, by session id. */
  sessions: Record<string, string>;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(record(v)).filter(([, x]) => typeof x === "string")) as Record<string, string>;

/** The file's state; empty when it is missing or unreadable, so nothing written by hand stops a chat. */
export function readLoginState(file: string): LoginState {
  let o: Record<string, unknown> = {};
  try {
    o = record(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    /* none yet */
  }
  const logins = Object.fromEntries(Object.entries(record(o.logins)).filter(([, x]) => x === null || typeof x === "string")) as Record<string, string | null>;
  return { logins, folders: strings(o.folders), sessions: strings(o.sessions) };
}

/** Written whole to a file beside it, then renamed over it: a reader never sees half a file. */
export function writeLoginState(file: string, s: LoginState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Reads the file, lets `change` edit the state, and writes it back only when `change` says it changed. */
export function updateLoginState(file: string, change: (s: LoginState) => boolean): LoginState {
  const s = readLoginState(file);
  if (change(s)) writeLoginState(file, s);
  return s;
}

/** The configured logins as the file holds them: `~/` expanded, absolute. */
export function stateLogins(logins: Record<string, LoginConfig>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(logins).map(([name, l]) => [name, l.configDir ? path.resolve(expandHome(l.configDir)) : null]));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Mirrors a window into the state: the configured logins, and its pick for
 * each of its folders, or no entry where it has none. With one login there
 * is nothing to pick (101), so nothing is added, and only the window's own
 * entries are taken out. Whether anything changed.
 */
export function mirrorWindow(s: LoginState, logins: Record<string, LoginConfig>, folders: string[], picked: string | null): boolean {
  let changed = false;
  const shared = Object.keys(logins).length > 1;
  if (shared) {
    const now = stateLogins(logins);
    if (!sameJson(now, s.logins)) {
      s.logins = now;
      changed = true;
    }
  }
  const want = shared && picked && logins[picked] ? picked : undefined;
  for (const f of folders) {
    if (s.folders[f] === want) continue;
    if (want) s.folders[f] = want;
    else delete s.folders[f];
    changed = true;
  }
  return changed;
}

/** Puts a chat's login on record, dropping the oldest past SESSIONS_KEPT. Whether it changed. */
export function recordSession(s: LoginState, sessionId: string, login: string): boolean {
  if (s.sessions[sessionId] === login) return false;
  delete s.sessions[sessionId];
  s.sessions[sessionId] = login;
  const ids = Object.keys(s.sessions);
  for (const id of ids.slice(0, Math.max(0, ids.length - SESSIONS_KEPT))) delete s.sessions[id];
  return true;
}

/**
 * The login a chat runs under: the one on record for it, else the one on
 * record for the chat it carries on from (a fork's parent, a handoff's old
 * chat), else the window's. A name no longer configured counts as no record.
 * `recorded` is false when the answer should be written down.
 */
export function chatLogin(s: LoginState, sessionId: string, from: string | null, current: string, logins: Record<string, LoginConfig>): { login: string; recorded: boolean } {
  const own = s.sessions[sessionId];
  if (own && logins[own]) return { login: own, recorded: true };
  const parent = from ? s.sessions[from] : undefined;
  if (parent && logins[parent]) return { login: parent, recorded: false };
  return { login: current, recorded: false };
}

/**
 * `chatLogin` against the file, and with `record` the answer written down
 * when it was not. With one login there is nothing to record: the window's.
 */
export function resolveChatLogin(file: string, sessionId: string, from: string | null, current: string, logins: Record<string, LoginConfig>, keep: boolean): string {
  if (Object.keys(logins).length <= 1) return current;
  if (!keep) return chatLogin(readLoginState(file), sessionId, from, current, logins).login;
  let login = current;
  updateLoginState(file, (s) => {
    const r = chatLogin(s, sessionId, from, current, logins);
    login = r.login;
    return !r.recorded && recordSession(s, sessionId, login);
  });
  return login;
}
