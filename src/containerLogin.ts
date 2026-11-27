// A login of kind `container` (decision 122): its chats run `claude` inside
// the agent's container, started by `embarch agent up`. Everything the panel
// needs to know about the container is read from what `embarch agent`
// recorded, `container.toml` (embarch-umbrella decisions 62, 67); nothing here
// starts a container.

import * as fs from "fs";
import * as path from "path";
import { expandHome } from "./desk/client";
import type { HandoffSetting } from "./handoff";

/** `logins.<name>.container` in the machine's settings. */
export interface ContainerConfig {
  /** The agent's `container.toml`, usually `~/.config/embarch/agents/<name>/container.toml`; `~/` expanded. */
  record: string;
  /** The repo's folder under `/work` in the container; absent, the host repo folder's own name (as `embarch agent shell` takes it). */
  manifestPath?: string;
}

export interface ContainerLogin {
  /** The container's name (`--name=` in the recorded vector). */
  container: string;
  /** The runtime binary, `docker` or `podman`. */
  runtime: string;
  /** The host repo path (the `/person/repo` mount's source). */
  repo: string;
  /** The exchange folder: the parent of the `claude-config` folder mounted as the agent's `~/.claude`. */
  exchange: string;
  /** The repo's path under `/work`. */
  manifestPath: string;
}

const TARGET_CLAUDE_CONFIG = "/home/agent/.claude";
const TARGET_PERSON_REPO = "/person/repo";
const RUNTIMES = ["docker", "podman"];

/** The values of the top-level `run_args = [ ... ]` array, in order. */
function runArgs(text: string): string[] {
  const m = /^run_args\s*=\s*\[/m.exec(text);
  if (!m) throw new Error("no run_args");
  const out: string[] = [];
  let i = m.index + m[0].length;
  while (i < text.length) {
    const c = text[i];
    if (c === "]") return out;
    if (c === '"') {
      let s = "";
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] !== "\\") {
          s += text[i];
          continue;
        }
        const e = text[++i];
        s += e === "n" ? "\n" : e === "t" ? "\t" : e === "u" ? String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)) : e;
        if (e === "u") i += 4;
      }
      out.push(s);
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) break;
      out.push(text.slice(i + 1, end));
      i = end;
    }
    i++;
  }
  throw new Error("run_args is not closed");
}

/** A top-level string value (`key = "value"`), before the first table. */
function topString(text: string, key: string): string | null {
  const head = text.split(/^\[/m)[0];
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(head);
  return m ? m[1] : null;
}

/** The mount's `source` for a `target`, from the vector's `--mount=type=bind,source=...,target=...` elements. */
function mountSource(args: string[], target: string): string | null {
  for (const a of args) {
    if (!a.startsWith("--mount=")) continue;
    const f = Object.fromEntries(a.slice("--mount=".length).split(",").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
    if (f.target === target && typeof f.source === "string") return f.source;
  }
  return null;
}

/** The repo's path under `/work`: relative, no `..`, no leading or trailing slash. */
function cleanManifestPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((x) => x === "." || x === "..")) throw new Error(`manifestPath is not a path under /work: ${JSON.stringify(p)}`);
  return parts.join("/");
}

/** The login a `container.toml` records. Throws, naming what is missing: a container login that cannot be read never falls back to the host. */
export function parseContainerRecord(text: string, cfg: Pick<ContainerConfig, "manifestPath"> = {}): ContainerLogin {
  const args = runArgs(text);
  const name = topString(text, "name");
  const runtime = topString(text, "runtime");
  if (!runtime || !RUNTIMES.includes(runtime)) throw new Error(`the recorded runtime is not docker or podman: ${JSON.stringify(runtime)}`);
  const named = args.find((a) => a.startsWith("--name="))?.slice("--name=".length) ?? (name ? `embarch-agent-${name}` : null);
  if (!named) throw new Error("the record names no container");
  const config = mountSource(args, TARGET_CLAUDE_CONFIG);
  if (!config || path.basename(config) !== "claude-config") throw new Error(`the record mounts no claude-config folder at ${TARGET_CLAUDE_CONFIG}`);
  const repo = mountSource(args, TARGET_PERSON_REPO);
  if (!repo) throw new Error(`the record mounts no repo at ${TARGET_PERSON_REPO}`);
  const manifestPath = cleanManifestPath(cfg.manifestPath ?? repo.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "");
  return { container: named, runtime, repo, exchange: path.dirname(config), manifestPath };
}

/** Reads the record a login names. */
export function readContainerLogin(cfg: ContainerConfig): ContainerLogin {
  const file = expandHome(cfg.record);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`container login: cannot read ${file} (run \`embarch init --container\`): ${(e as Error).message}`);
  }
  try {
    return parseContainerRecord(text, cfg);
  } catch (e) {
    throw new Error(`container login: ${file}: ${(e as Error).message}`);
  }
}

/** The container's working folder: where `claude` runs, and what its project folder is named for. */
export function containerWorkdir(c: ContainerLogin): string {
  return `/work/${c.manifestPath}`;
}

/** The agent's transcripts, on the host: its `~/.claude` is the exchange folder's `claude-config`. */
export function containerProjectsRoot(c: ContainerLogin): string {
  return path.join(c.exchange, "claude-config", "projects");
}

/** What goes before `claude`'s flags (`claude` itself last), as `embarch agent shell --claude` runs it, without a terminal. */
export function containerExecArgs(c: ContainerLogin): string[] {
  return ["exec", "-i", "-u", "agent", "-w", containerWorkdir(c), c.container, "claude"];
}

/**
 * The environment the runtime client needs and nothing else: nothing of the
 * host's reaches `claude` in the container (`exec` forwards none, and no `-e`
 * is passed), and the owner's tokens and desk variables stay out of the
 * client's too.
 */
const CLIENT_ENV = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "CONTAINER_HOST"];
export function containerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && CLIENT_ENV.includes(k.toUpperCase())) env[k] = v;
  return env;
}

/** The chat line for an `exec` that found no running container, else null. */
export function containerDownLine(c: ContainerLogin, stderr: string): string | null {
  if (!/is not running|no such container|no container with name or id/i.test(stderr)) return null;
  return `The agent container ${c.container} is not running: start it with \`embarch agent up\`, then send again.`;
}

/** What the panel declares in `initialize` (decisions 61, 65, 122): a container login has no autosave hook and no diagnostics tool. */
export function panelParts(s: { autosave: boolean; diagnostics: boolean; handoff: HandoffSetting }, container: boolean): { autosave: boolean; diagnostics: boolean; handoff: boolean } {
  return { autosave: s.autosave && !container, diagnostics: s.diagnostics && !container, handoff: s.handoff !== "off" };
}
