// What the owner's answers on the cards say to the CLI, in Claude Code's own
// words where its panel (2.1.309) has them: a plan sent back with comments
// on its lines (decision 77), and the rules a permission card saves and
// where (78).

// ---------------------------------------------------------------- plans

/** A comment on lines of a plan (77): the lines it is on (0-based), their text, and what the owner wrote. */
export interface PlanComment {
  id: string;
  start: number;
  end: number;
  selectedText: string;
  comment: string;
}

/** Claude Code's words for a plan sent back (its panel's `mq1` and `MD`). */
export const KEEP_PLANNING = "User chose to stay in plan mode and continue planning";
export const REJECTED_BECAUSE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: ";

/**
 * "Keep planning"'s answer as Claude Code's panel builds it: what the owner
 * typed after the rejection's own words, else that Claude keeps planning;
 * then each comment as `[Re: "<its lines>"] <comment>`. With neither, the
 * turn stops (`interrupt`) and Claude waits for the owner's next message.
 */
export function planFeedback(typed: string, comments: PlanComment[]): { message: string; interrupt: boolean } {
  const t = typed.trim();
  const head = t ? REJECTED_BECAUSE + t : KEEP_PLANNING;
  if (!comments.length) return { message: head, interrupt: !t };
  return { message: `${head}\n\nComments on the plan:\n${comments.map((c) => `[Re: "${c.selectedText}"] ${c.comment}`).join("\n")}`, interrupt: false };
}

// ---------------------------------------------------------------- permissions

/** Where an "always allow" is saved: Claude Code's four places, in the order its card cycles them. */
export const DESTINATIONS = ["localSettings", "userSettings", "projectSettings", "session"] as const;
export type Destination = (typeof DESTINATIONS)[number];
export const isDestination = (d: unknown): d is Destination => (DESTINATIONS as readonly unknown[]).includes(d);

/** Claude Code's words for each place, and what each one writes. */
export const DESTINATION_LABEL: Record<Destination, string> = {
  localSettings: "this project (just you)",
  userSettings: "all projects",
  projectSettings: "this project (shared)",
  session: "this session",
};
export const DESTINATION_FILE: Record<Destination, string> = {
  localSettings: "Saves to .claude/settings.local.json (gitignored)",
  userSettings: "Saves to ~/.claude/settings.json",
  projectSettings: "Saves to .claude/settings.json (shared with team)",
  session: "Only for this session (not saved)",
};

interface Suggestion {
  type?: string;
  rules?: Array<{ toolName?: string; ruleContent?: string }>;
  directories?: string[];
  mode?: string;
  destination?: string;
}

/** One of the CLI's permission suggestions in a line: what it grants, its whole text, and whether it goes where the owner picks (a rule or a directory; a mode change keeps its own place, as in Claude Code). */
export interface Grant {
  text: string;
  full: string;
  placed: boolean;
}

const MODE_WORDS: Record<string, string> = {
  acceptEdits: "accept edits for this session",
  default: "ask before edits again",
  plan: "plan mode for this session",
  auto: "auto mode for this session",
};

export function grantOf(raw: unknown): Grant {
  const s = (raw ?? {}) as Suggestion;
  const cut = (x: string) => ([...x].length > 40 ? [...x].slice(0, 39).join("") + "…" : x);
  if ((s.type === "addRules" || s.type === "replaceRules") && Array.isArray(s.rules)) {
    const full = s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName))).join(", ");
    return { text: s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${cut(r.ruleContent)})` : String(r.toolName))).join(", "), full, placed: true };
  }
  if (s.type === "addDirectories" && Array.isArray(s.directories)) {
    const full = s.directories.join(", ");
    return { text: `access to ${s.directories.map((d) => `${d.split(/[/\\]/).filter(Boolean).pop() ?? d}/`).join(", ")}`, full, placed: true };
  }
  if (s.type === "setMode" && s.mode) return { text: MODE_WORDS[s.mode] ?? `${s.mode} mode for this session`, full: `${s.mode} mode`, placed: false };
  const what = String(s.type ?? "a change");
  return { text: what, full: JSON.stringify(raw), placed: false };
}

/** Claude Code's order of how lasting a place is: the CLI's own suggestion picks the most lasting it names. */
const LASTING = ["userSettings", "projectSettings", "localSettings", "session", "cliArg"];

/** Where the card starts: the owner's last pick, else the most lasting place the CLI's suggestions name, else this session — Claude Code's rule. */
export function defaultDestination(suggestions: unknown[] | undefined, remembered: unknown): Destination {
  if (isDestination(remembered)) return remembered;
  const own = (suggestions ?? [])
    .map((s) => (s as Suggestion)?.destination)
    .filter(isDestination)
    .sort((a, b) => LASTING.indexOf(a) - LASTING.indexOf(b))[0];
  return own ?? "session";
}

/**
 * What "always allow" sends: the suggestions the owner kept (by index; all
 * when none are named), each rule or directory saved where the owner picked
 * and a mode change where the CLI said (Claude Code's own split). One saved
 * to a file goes to this session as well: the CLI writes a rule to the
 * project's .claude/settings.json and then asks for the same command again
 * in the session that saved it [measured on 2.1.287; one saved to local
 * settings or the session applies at once].
 */
export function alwaysPermissions(suggestions: unknown[] | undefined, picks: number[] | undefined, destination: Destination | undefined): unknown[] {
  const all = Array.isArray(suggestions) ? suggestions : [];
  const kept = picks ? all.filter((_, i) => picks.includes(i)) : all;
  return kept.flatMap((s) => {
    if (!destination || !grantOf(s).placed) return [s];
    const placed = { ...(s as object), destination };
    return destination === "session" ? [placed] : [placed, { ...(s as object), destination: "session" }];
  });
}
