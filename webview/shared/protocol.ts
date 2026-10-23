// Messages between the extension host and its two webviews. The webviews
// never see the desk token or call the desk: every desk read reaches them as
// data here, every desk write leaves as a request the host carries out
// (decision 20).

import type { ChatState } from "../../src/wire/reducer";
import type { RewindResult } from "../../src/wire/chat";
import type { WireMessage } from "../../src/wire/types";
import type { PrRef } from "../../src/desk/client";
import type { ThreadGroup } from "../../src/desk/threads";
import type { Card, Chip, PastPrompt } from "../../src/assistant/edits";
import type { LibraryEntry } from "../../src/library/entries";
import type { Attachment } from "../../src/wire/message";
import type { EditorItem } from "../../src/editorContext";

/** The chat's card in two lines (decision 18). */
export interface Header {
  itemId: string | null;
  issueKey?: string;
  issueUrl?: string;
  title: string;
  stateName?: string;
  prs: PrRef[];
  todaySeconds: number;
  deskUrl: string;
  untracked: boolean;
}

export interface ChatView {
  ours: boolean;
  /** Shown from its transcript; answering happens where it runs (decision 31). */
  readOnly: boolean;
  /** Read-only, but nothing runs it: the next message resumes it here. */
  resumable: boolean;
  where?: string;
  inEditor: boolean;
  /** embarch-ui's address, for bench cards' links (decision 15). */
  uiUrl: string;
  /** The chat's repo's atlas, for citation links (decision 16); null without one. */
  atlas: { docs: string[]; boards: string[] } | null;
  /** The time above each message, with a date line where the day changes (decision 68): embarchChat.showMessageTimestamps. */
  timestamps?: boolean;
}

export type HostToChat =
  | { t: "snapshot"; state: ChatState; view: ChatView; header: Header | null; warning: string | null }
  | { t: "event"; e: WireMessage }
  | { t: "header"; header: Header | null }
  | { t: "empty"; warning: string | null }
  | { t: "mentions"; q: string; items: MentionItem[] }
  | { t: "states"; states: Array<{ id: string; name: string; type: string }>; error?: string }
  /** The owner's own prompts of the last 30 days, for the instant prefix match (26); never stored by the page. */
  | { t: "prompts"; items: PastPrompt[] }
  /** The 📚's entries (38) and whether the Haiku assistant runs. */
  | { t: "library"; entries: LibraryEntry[]; assistant: boolean }
  /** Haiku's ghost text for draft request `seq`, streamed (24, 26). */
  | { t: "ghost"; seq: number; text: string; done: boolean }
  /** Haiku's cards for draft request `seq` (28, 36, 37). */
  | { t: "cards"; seq: number; cards: Card[] }
  /** The reply chips for the chat on screen (25). */
  | { t: "chips"; sid: string; chips: Chip[] }
  /** Text back into a chat's draft: a held message not sent, a start the desk refused. */
  | { t: "draft"; sid: string; text: string }
  /** What rewinding the files to before message `uuid` would change: the dry run the confirmation shows (decision 73). */
  | { t: "rewindCheck"; uuid: string; result: RewindResult }
  /** The conversation as plain text, for the export dialog (decision 74). */
  | { t: "export"; text: string; filename: string }
  /** The end of a background shell's or Monitor's output, for the page that asked (port item 71). */
  | { t: "taskOutput"; taskId: string; output?: string; totalBytes?: number; truncated?: boolean; error?: string }
  /** The editor's open file or selection, which goes with the next message unless dismissed (60). */
  | { t: "editor"; editor: (EditorItem & { label: string }) | null }
  /** Focus the input (after a terminal was read, 58; Ctrl+Alt+Esc, 59). */
  | { t: "focus" }
  /** Text in at the input's caret: an @-mention of the editor's selection (Alt+Shift+K, 59); not when the editor chip carries these lines (`unlessChip`). */
  | { t: "insert"; text: string; unlessChip?: { path: string; startLine: number; endLine: number } };

/** What a rewind restores (decision 73), as Claude Code's panel offers it: the conversation always as a fork. */
export type Restore = "both" | "conversation" | "code";

export interface MentionItem {
  /** What goes after the @. */
  insert: string;
  label: string;
  detail?: string;
  /** A terminal, by name: picked, its output goes with the message as a chip, not as text (58). */
  terminal?: string;
}

export type ChatToHost =
  | { t: "ready" }
  /** A message: pasted images go with it, and the long pastes it holds, for the CLI to mark (56). */
  | { t: "send"; text: string; handoff?: boolean; images?: Attachment[]; pastes?: string[]; editor?: EditorItem; terminals?: string[] }
  | { t: "allow"; requestId: string; always?: boolean }
  | { t: "deny"; requestId: string; message?: string }
  | { t: "answer"; requestId: string; answers: Record<string, string> }
  /** A dialog's or an MCP elicitation's answer, as the CLI's schema has it (decision 66). */
  | { t: "respond"; requestId: string; response: Record<string, unknown> }
  | { t: "interrupt" }
  | { t: "mode"; mode: string }
  | { t: "model"; model: string }
  | { t: "compact" }
  | { t: "openDiff"; toolId?: string; requestId?: string }
  /** A tool's whole input or output in an editor tab (decision 62). */
  | { t: "openContent"; toolId: string; part: "input" | "output" }
  | { t: "openFile"; path: string; line?: number }
  | { t: "openLink"; url: string }
  | { t: "atlas"; doc?: string; page?: number; board?: string; ref?: string }
  | { t: "mention"; q: string }
  | { t: "jump" }
  | { t: "openInEditor" }
  | { t: "states" }
  | { t: "setStatus"; stateId: string }
  | { t: "newChat" }
  | { t: "refreshContext" }
  /** Asks the assistant about the draft: ghost text after a 300 ms pause, cards after 2 s or before send (26). */
  | { t: "assist"; kind: "ghost" | "cards"; text: string; seq: number }
  /** The next keystroke cancels a stale call (26). */
  | { t: "assistCancel" }
  /** A chip that acts: a fresh chat with this chat's handoff (36). */
  | { t: "freshChat" }
  /** A dry run of rewinding the files to before the owner's message `uuid` (decision 73). */
  | { t: "rewindCheck"; uuid: string }
  /** Rewinds to before the owner's message `uuid`: its files, and/or the conversation as a fork (decision 73). */
  | { t: "rewind"; uuid: string; restore: Restore }
  /** The conversation as plain text, for the export dialog (decision 74). */
  | { t: "export" }
  /** Saves the export through VS Code's save dialog. */
  | { t: "exportSave"; text: string; filename: string }
  /** The owner names the chat (decision 75). */
  | { t: "rename" }
  /** A step in the foreground goes on in the background (port item 70). */
  | { t: "runInBackground"; toolUseId: string }
  /** One background task stopped, nothing else (port item 71). */
  | { t: "stopTask"; taskId: string }
  | { t: "taskOutput"; taskId: string }
  /** A message that waits for Claude: taken back to the draft, or sent now (port item 72). */
  | { t: "cancelQueued"; id: string }
  | { t: "sendNow"; id: string }
  /** `/btw <question>`: a side question, answered beside the chat (57). */
  | { t: "btw"; question: string }
  | { t: "sideClear" };

export type HostToList = {
  t: "groups";
  groups: ThreadGroup[];
  desk: string | null;
  error: string | null;
  /** One line when the running desk predates this panel: update it. */
  notice?: string | null;
  selected: string | null;
  now: number;
};

export type ListToHost =
  | { t: "ready" }
  | { t: "open"; sid: string }
  | { t: "openInEditor"; sid: string }
  | { t: "jump"; sid: string }
  | { t: "newChat"; itemId?: string }
  | { t: "refresh" }
  /** The owner names a thread (decision 75). */
  | { t: "rename"; sid: string };

export const MODELS = [
  { id: "default", label: "Default model" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

export const MODES = [
  { id: "auto", label: "Auto" },
  { id: "default", label: "Ask" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan" },
];
