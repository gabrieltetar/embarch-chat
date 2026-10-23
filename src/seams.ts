// Seams for what this pass does not build, so it lands without reshaping
// the chat: the Haiku assistant (embarch-chat-assistant-proposal.md —
// ghost text, the 💡 cards, reply chips, naming a chat after its first turn)
// and the 📚 library menu (decision 38). Both plug in here; until then the
// panel shows Claude's own ai-title as the chat's name.

import type { Chat } from "./wire/chat";

/** What the assistant offers the webview; empty until it is built. */
export interface Suggestions {
  ghost?: string;
  chips?: string[];
  cards?: Array<{ category: string; title: string; edit: string }>;
}

export interface Assistant {
  /** After each of Claude's turns: chips for the chat on screen (25, 34); a name after the first (12). */
  afterTurn(chat: Chat, onScreen: boolean): Promise<Suggestions | null>;
  /** While the owner writes (24, 26). */
  draft(chat: Chat, text: string): Promise<Suggestions | null>;
}

export const noAssistant: Assistant = {
  afterTurn: async () => null,
  draft: async () => null,
};

/** A library entry: a Claude Code command or skill (decision 7), grouped by its `category:` (38). */
export interface LibraryEntry {
  name: string;
  category: string;
  description?: string;
}

export interface Library {
  entries(): Promise<LibraryEntry[]>;
}

export const noLibrary: Library = { entries: async () => [] };
