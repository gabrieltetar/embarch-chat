// Which account a login's folder really holds (decision 106). A `/login` in
// any panel writes the account it signs in to into that login's folder, so a
// label says nothing about the account: two labels can hold one. The CLI
// keeps the signed-in account in its config file's `oauthAccount`.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expandHome } from "./desk/client";

/** How often a login's files are looked at for a `/login`: a stat each, no read unless one changed. */
export const ACCOUNT_POLL_MS = 2000;

export interface Account {
  email: string;
  org: string | null;
  /** The same key means the same account in the same organisation. */
  key: string;
}

/** The CLI's config file for a login: in its folder, or `~/.claude.json` beside the CLI's default folder. */
export function accountFile(configDir: string | undefined): string {
  return configDir ? path.join(expandHome(configDir), ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/** The login's credentials, whose change is a `/login` or a refresh. */
export function credentialsFile(configDir: string | undefined): string {
  return path.join(configDir ? expandHome(configDir) : path.join(os.homedir(), ".claude"), ".credentials.json");
}

/** The account signed in to a login's folder, or null with none. */
export function readAccount(configDir: string | undefined): Account | null {
  try {
    const a = JSON.parse(fs.readFileSync(accountFile(configDir), "utf8"))?.oauthAccount;
    if (!a || typeof a.emailAddress !== "string" || !a.emailAddress) return null;
    const org = typeof a.organizationName === "string" && a.organizationName ? a.organizationName : null;
    const who = typeof a.accountUuid === "string" && a.accountUuid ? a.accountUuid : a.emailAddress.toLowerCase();
    const where = typeof a.organizationUuid === "string" && a.organizationUuid ? a.organizationUuid : (org ?? "");
    return { email: a.emailAddress, org, key: `${who}|${where}` };
  } catch {
    return null;
  }
}

/** The labels that hold the same account as another, one group per account. */
export function sharedAccounts(accounts: Record<string, Account | null>): string[][] {
  const by = new Map<string, string[]>();
  for (const [label, a] of Object.entries(accounts)) if (a) by.set(a.key, [...(by.get(a.key) ?? []), label]);
  return [...by.values()].filter((g) => g.length > 1);
}

const who = (a: Account) => (a.org ? `${a.email} (${a.org})` : a.email);

/** The status item for the login in effect: its label and account, and a warning while two labels hold one account. */
export function loginItem(label: string, accounts: Record<string, Account | null>): { text: string; tooltip: string; warn: boolean } {
  const account = accounts[label] ?? null;
  const shared = sharedAccounts(accounts);
  const warn = shared.length > 0;
  const text = `$(${warn ? "warning" : "account"}) ${label} · ${account ? (account.org ?? account.email) : "not logged in"}`;
  const lines = [
    `New EmbArch chats and Claude Code panels in this window run on ${label}: ${account ? who(account) : "no account is signed in to it"}.`,
    "A chat keeps the login it started on, resumed too. Click to change.",
  ];
  for (const g of shared) lines.push(`${g.join(" and ")} hold the same account: ${who(accounts[g[0]]!)}.`);
  return { text, tooltip: lines.join("\n"), warn };
}
