// What this window does for its chats' CLIs (src/wire/host.ts), by the
// owner's settings, read as each process starts. Every one of them is
// machine-scoped: what runs on Claude's tool calls is not a workspace's to
// change (decision 48).

import * as vscode from "vscode";
import type { HostHooks } from "./wire/host";
import { saveIfDirty } from "./autosave";

export function hostHooks(log: (s: string) => void): HostHooks {
  const c = vscode.workspace.getConfiguration("embarchChat");
  const h: HostHooks = {};
  if (c.get<boolean>("autosave", true)) h.beforeFileTool = (tool, file, cwd) => saveIfDirty(tool, file, cwd, log);
  return h;
}
