// An agent hands its chat over to a fresh session in the same panel
// (decision 103): the `handoff(prompt)` tool of the panel's own MCP server
// (65). This file is the tool as Claude sees it and what the setting
// `embarchChat.handoff` may say; wire/chat.ts runs the call, extension.ts
// starts the fresh session.

import type { McpTool } from "./mcpServer";

/** `card` (the default): the owner sees the prompt and decides; `immediate`: it switches at once; `off`: no tool. */
export type HandoffSetting = "card" | "immediate" | "off";

export function handoffSetting(v: unknown): HandoffSetting {
  return v === "immediate" || v === "off" ? v : "card";
}

/** What a chat does for the tool's call: the answer Claude reads. */
export interface HandoffPort {
  handoff(prompt: string, how: "card" | "immediate"): Promise<string>;
}

export const HANDOFF_TOOL: Omit<McpTool, "call"> = {
  name: "handoff",
  description:
    "Hand this conversation over to a fresh session in the same panel, when its context has grown long enough that a clean start would serve better. `prompt` is the fresh session's first message and its only memory of this one: say what the work is, what is done, what is left, and the files, branches and ids it needs. The owner may edit the prompt or decline; if declined, this session carries on. Do not rerun a step that already ran: the handoff continues the work, it does not repeat it.",
  inputSchema: {
    type: "object",
    properties: { prompt: { type: "string", description: "The fresh session's first message: everything it needs to carry on." } },
    required: ["prompt"],
    additionalProperties: false,
  },
  annotations: { title: "Hand off to a fresh session" },
};

/** The answers Claude reads. */
export const HANDOFF_DONE = "Handed off: a fresh session in this panel starts with your prompt, and this session ends now. Say nothing more.";
export const HANDOFF_STAY = "The owner chose to stay in this session. Carry on here.";
