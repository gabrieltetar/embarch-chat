// Messages between the extension host and its two webviews. The webviews
// never see the desk token or call the desk: every desk read reaches them as
// data here, every desk write leaves as a request the host carries out
// (decision 20).

import type { ChatState } from "../../src/wire/reducer";
import type { WireMessage } from "../../src/wire/types";
import type { PrRef } from "../../src/desk/client";
import type { ThreadGroup } from "../../src/desk/threads";

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
}

export type HostToChat =
  | { t: "snapshot"; state: ChatState; view: ChatView; header: Header | null; warning: string | null }
  | { t: "event"; e: WireMessage }
  | { t: "header"; header: Header | null }
  | { t: "empty"; warning: string | null }
  | { t: "mentions"; q: string; items: MentionItem[] }
  | { t: "states"; states: Array<{ id: string; name: string; type: string }>; error?: string };

export interface MentionItem {
  /** What goes after the @. */
  insert: string;
  label: string;
  detail?: string;
}

export type ChatToHost =
  | { t: "ready" }
  | { t: "send"; text: string }
  | { t: "allow"; requestId: string; always?: boolean }
  | { t: "deny"; requestId: string; message?: string }
  | { t: "answer"; requestId: string; answers: Record<string, string> }
  | { t: "interrupt" }
  | { t: "mode"; mode: string }
  | { t: "model"; model: string }
  | { t: "compact" }
  | { t: "openDiff"; toolId?: string; requestId?: string }
  | { t: "openFile"; path: string; line?: number }
  | { t: "openLink"; url: string }
  | { t: "mention"; q: string }
  | { t: "jump" }
  | { t: "openInEditor" }
  | { t: "states" }
  | { t: "setStatus"; stateId: string }
  | { t: "newChat" }
  | { t: "refreshContext" };

export type HostToList = {
  t: "groups";
  groups: ThreadGroup[];
  desk: string | null;
  error: string | null;
  selected: string | null;
  now: number;
};

export type ListToHost =
  | { t: "ready" }
  | { t: "open"; sid: string }
  | { t: "openInEditor"; sid: string }
  | { t: "jump"; sid: string }
  | { t: "newChat"; itemId?: string }
  | { t: "refresh" };

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
