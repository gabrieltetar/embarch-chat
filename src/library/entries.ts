// A library entry and how the 📚 shows it (decisions 7,
// 38) — pure, shared by the host and the chat webview.
// files.ts reads the entries.

export interface LibraryEntry {
  /** What follows the `/`, without a plugin prefix. */
  name: string;
  category: string;
  description?: string;
  source: "plugin" | "user";
  /** The plugin's name, for its namespaced form (`/<plugin>:<name>`). */
  plugin?: string;
  kind: "command" | "skill";
}

export const OTHER = "Other";

/**
 * How an entry is typed in this session: the CLI lists a plugin's entries as
 * `<plugin>:<name>` (measured on 2.1.287), the owner's own as `<name>`. Before
 * the session has started that is all there is to go on; once it has, null
 * means it knows the entry under neither name (its plugin is not installed).
 */
export function invocation(e: LibraryEntry, slashCommands: string[]): string | null {
  const full = e.plugin ? `${e.plugin}:${e.name}` : e.name;
  if (!slashCommands.length) return full;
  const known = new Set(slashCommands.map((c) => c.replace(/^\//, "")));
  if (known.has(full)) return full;
  if (known.has(e.name)) return e.name;
  return null;
}

/** Grouped for the 📚's submenus: categories by name, Other last. */
export function byCategory(entries: LibraryEntry[]): Array<{ category: string; entries: LibraryEntry[] }> {
  const m = new Map<string, LibraryEntry[]>();
  for (const e of entries) {
    const list = m.get(e.category) ?? [];
    list.push(e);
    m.set(e.category, list);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)))
    .map(([category, entries]) => ({ category, entries }));
}
