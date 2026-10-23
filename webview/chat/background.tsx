// Work that runs while the owner does something else (port item 70, after
// Claude Code's own panel): "Run in background" under a step running in the
// foreground — a Bash call or a subagent — moves it there and the turn goes
// on; the step's row then says it runs there, and how it ended.

import { useEffect, useState } from "preact/hooks";
import type { ToolEntry } from "../../src/wire/reducer";

/**
 * "Run in background" under a step running in the foreground (port item
 * 70), as Claude Code's panel puts it under its card: the step goes on as a
 * background task and the turn goes on without waiting for it.
 */
export function RunInBackground({ toolUseId, onMove }: { toolUseId: string; onMove: (toolUseId: string) => void }) {
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!asked) return;
    // No answer that moves it (the host notes a refusal): the button comes back.
    const t = window.setTimeout(() => setAsked(false), 5000);
    return () => clearTimeout(t);
  }, [asked]);
  return (
    <div class="bg-line">
      <button
        class="link-button"
        disabled={asked}
        title="The step keeps running in the background, and Claude goes on"
        onClick={(e) => {
          e.stopPropagation();
          setAsked(true);
          onMove(toolUseId);
        }}
      >
        {asked ? "Moving to the background…" : "Run in background"}
      </button>
    </div>
  );
}

/** How a step that ran as a background task stands, for its row: running there, or how it ended. */
export function backgroundStatus(t: ToolEntry): { text: string; cls: string } | null {
  if (!t.background || !t.task) return null;
  if (!t.taskEnd) return { text: "in the background", cls: "bg" };
  if (t.taskEnd === "stopped") return { text: "stopped", cls: "stopped" };
  if (t.taskEnd === "failed") return { text: "failed", cls: "error" };
  return { text: "", cls: "done" };
}
