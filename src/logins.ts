// Which Claude login and which desk a window's chats use, from the machine's
// settings. Everything here is pure: the extension holds the picked login.

import * as path from "path";
import { expandHome } from "./desk/client";

export interface LoginConfig {
  /** Run `claude` with `CLAUDE_CONFIG_DIR` here; absent, the CLI's own default folder. */
  configDir?: string;
}

export interface DeskConfig {
  url: string;
  tokenPath: string;
  /** Set on every process of a chat on this desk. `~/` is expanded: nothing else would, and the desk's tools read these as paths. */
  env?: Record<string, string>;
}

export interface FolderRule {
  folder: string;
  login: string;
  desk?: string;
}

export const DEFAULT_LOGIN = "work";

/** The first rule whose folder is, or holds, one of the window's folders. */
export function matchFolderRule(rules: FolderRule[], folders: string[]): FolderRule | null {
  for (const r of rules) {
    const base = expandHome(r.folder).replace(/[/\\]+$/, "");
    if (folders.some((f) => f === base || f.startsWith(base + path.sep))) return r;
  }
  return null;
}

/** The picker's login, else the folder rule's, else the default; a name no longer configured counts as unset. */
export function currentLogin(picked: string | undefined, rule: FolderRule | null, logins: Record<string, LoginConfig>): string {
  if (picked && logins[picked]) return picked;
  if (rule && logins[rule.login]) return rule.login;
  return DEFAULT_LOGIN;
}

/** The desk the folder rule names, or null for the default desk. */
export function ruleDesk(rule: FolderRule | null, desks: Record<string, DeskConfig>): DeskConfig | null {
  return (rule?.desk && desks[rule.desk]) || null;
}

/** `base` with the login's config folder and the desk's variables applied. */
export function loginEnv(base: NodeJS.ProcessEnv, login: LoginConfig | undefined, desk: DeskConfig | null): NodeJS.ProcessEnv {
  const env = { ...base };
  if (login?.configDir) env.CLAUDE_CONFIG_DIR = expandHome(login.configDir);
  for (const [k, v] of Object.entries(desk?.env ?? {})) env[k] = expandHome(v);
  return env;
}
