// Where the desk is, by the desk's own rule (embarch-desk src/paths.rs) read from an environment.
// The Rust clients hold the same rule in embarch-core-client; chat's copy is this one (decision 124).

import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_DESK_PORT = 4891;

type Env = Record<string, string | undefined>;

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === "" ? undefined : v;
}

/** The desk's config folder: EMBARCH_DESK_CONFIG_DIR itself, else $XDG_CONFIG_HOME/embarch-desk (empty counts as unset), else ~/.config/embarch-desk. */
export function deskConfigDir(env: Env = process.env): string {
  const dir = env.EMBARCH_DESK_CONFIG_DIR;
  if (dir !== undefined) return dir;
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  const base = xdg ?? path.join(nonEmpty(env.HOME) ?? os.homedir(), ".config");
  return path.join(base, "embarch-desk");
}

/** The desk's bearer token file. */
export function deskTokenFile(env: Env = process.env): string {
  return path.join(deskConfigDir(env), "desk-token");
}

/** The desk's port: EMBARCH_DESK_PORT when it parses as one, else 4891. */
export function deskPort(env: Env = process.env): number {
  const raw = env.EMBARCH_DESK_PORT;
  if (raw !== undefined && /^\+?\d+$/.test(raw)) {
    const n = Number(raw);
    if (n <= 65535) return n;
  }
  return DEFAULT_DESK_PORT;
}

export function deskBaseUrl(env: Env = process.env): string {
  return `http://127.0.0.1:${deskPort(env)}`;
}

/** An engineer's setting wins; with none set the desk's rule answers. */
export function resolveDeskEndpoint(setUrl: string | undefined, setTokenPath: string | undefined, env: Env = process.env): { url: string; tokenPath: string } {
  return { url: nonEmpty(setUrl) ?? deskBaseUrl(env), tokenPath: nonEmpty(setTokenPath) ?? deskTokenFile(env) };
}
