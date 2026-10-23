// What the owner's answers on the cards say to the CLI, in Claude Code's own
// words where its panel (2.1.309) has them: a plan sent back with comments
// on its lines (decision 77).

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
