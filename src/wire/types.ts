// The stream-json wire as Claude Code's own panel speaks it, typed only as
// far as this extension reads it. Shapes are from real recordings
// (test/fixtures/wire/), not from documentation: the wire is partly
// documented and Anthropic's panel depends on it (proposal, "What is
// possible"). Everything is optional because a CLI update may drop a field;
// the reducer must keep working on what is left.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock | { type: string; [k: string]: unknown };

/** One line the CLI writes on stdout. */
export interface WireMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  [k: string]: unknown;
}

export interface PermissionRequest {
  subtype: "can_use_tool";
  tool_name: string;
  display_name?: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  description?: string;
  permission_suggestions?: unknown[];
  requires_user_interaction?: boolean;
  decision_reason?: string;
  blocked_path?: string;
}

/** What the owner answers a `can_use_tool` with. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = ["auto", "default", "acceptEdits", "plan"];

/** `get_context_usage`'s answer, trimmed to what the meter shows. */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: Array<{ name: string; tokens: number; kind?: string }>;
}
