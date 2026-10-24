// The library (decisions 7, 13, 38): an entry is a
// Claude Code command or skill, a `.md` file with frontmatter, so it works in
// the terminal, Claude Code's own panel and the fleet as well as here. Two
// folders: the generic entries in this repo's own plugin (shipped inside the
// extension), and the owner's `~/.claude/commands`, where an entry naming a
// client lives — never in a repo. Entries sit behind the 📚 by the input,
// one submenu per `category:` from their own frontmatter (none is Other).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LibraryEntry, OTHER } from "./entries";

/** The frontmatter's `key: value` lines (one level, quotes stripped): all a library entry needs. */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
      if (kv[2].trim().startsWith('"')) v = v.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[kv[1]] = v;
  }
  return out;
}

function entry(file: string, name: string, source: LibraryEntry["source"], kind: LibraryEntry["kind"], plugin?: string): LibraryEntry | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = frontmatter(text);
  const e: LibraryEntry = { name: fm.name?.trim() || name, category: fm.category?.trim() || OTHER, source, kind };
  if (fm.description) e.description = fm.description;
  if (plugin) e.plugin = plugin;
  return e;
}

/** Every `.md` under a commands folder; a subfolder's commands keep their own names. */
function commandFiles(dir: string): string[] {
  const out: string[] = [];
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...commandFiles(p));
    else if (d.isFile() && d.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** A plugin folder's commands and skills. */
export function pluginEntries(pluginDir: string): LibraryEntry[] {
  let plugin: string | undefined;
  try {
    plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")).name;
  } catch {
    return [];
  }
  const out: LibraryEntry[] = [];
  for (const f of commandFiles(path.join(pluginDir, "commands"))) {
    const e = entry(f, path.basename(f, ".md"), "plugin", "command", plugin);
    if (e) out.push(e);
  }
  let skills: fs.Dirent[] = [];
  try {
    skills = fs.readdirSync(path.join(pluginDir, "skills"), { withFileTypes: true });
  } catch {
    /* none */
  }
  for (const d of skills) {
    if (!d.isDirectory()) continue;
    const e = entry(path.join(pluginDir, "skills", d.name, "SKILL.md"), d.name, "plugin", "skill", plugin);
    if (e) out.push(e);
  }
  return out;
}

export function userCommandsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "commands");
}

/** The library: the plugin's entries, then the owner's own; a name the owner reuses is theirs. */
export function readLibrary(pluginDir: string | null, userDir = userCommandsDir()): LibraryEntry[] {
  const user = commandFiles(userDir)
    .map((f) => entry(f, path.basename(f, ".md"), "user", "command"))
    .filter((e): e is LibraryEntry => !!e);
  const mine = new Set(user.map((e) => e.name));
  const plugin = pluginDir ? pluginEntries(pluginDir).filter((e) => !mine.has(e.name)) : [];
  return [...plugin, ...user].sort((a, b) => a.name.localeCompare(b.name));
}
