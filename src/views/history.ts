// The chat's history, host side (decision 74): the export dialog's
// text — Claude Code's own /export, or the panel's for a chat it may not
// run — and its save through VS Code's save dialog.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ChatRecord } from "../chats";
import { conversationText, exportFileName } from "../wire/history";
import type { ChatToHost, HostToChat } from "../../webview/shared/protocol";
import type { HostCtx } from "./chatHost";

export type HistoryMessage = Extract<ChatToHost, { t: "export" | "exportSave" }>;

export async function historyMessage(ctx: HostCtx, rec: ChatRecord, m: HistoryMessage, post: (m: HostToChat) => void): Promise<void> {
  const chat = rec.chat;
  switch (m.t) {
    case "export": {
      // The CLI's own /export text for a chat this window runs (resumed for
      // it when closed); any other is rendered here from what the page shows.
      if (rec.ours && chat.started) {
        try {
          const r = await chat.exportConversation();
          post({ t: "export", text: r.text, filename: r.filename });
          return;
        } catch (err) {
          ctx.log(`[${chat.sessionId.slice(0, 8)}] export: ${(err as Error).message}; the panel's own text instead`);
        }
      }
      post({ t: "export", text: conversationText(chat.state), filename: exportFileName(chat.state) });
      return;
    }
    case "exportSave": {
      const dir = chat.opts.cwd || chat.state.cwd || os.homedir();
      const name = path.basename(m.filename) || "conversation.txt";
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(dir, name)), filters: { Text: ["txt"] }, title: "Export conversation" });
      if (!uri) return;
      try {
        fs.writeFileSync(uri.fsPath, m.text);
        ctx.log(`[${chat.sessionId.slice(0, 8)}] exported to ${uri.fsPath}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Conversation not saved: ${(err as Error).message}`);
      }
      return;
    }
  }
}
