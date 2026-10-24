// The chat's history, host side (decisions 73 and 74): a rewind
// checked with a dry run, then done — the files only with the owner's
// confirmation, the conversation always as a fork, as Claude Code's panel
// does it — and the export dialog's text and its save.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ChatRecord } from "../chats";
import type { RewindResult } from "../wire/chat";
import { conversationText, exportFileName } from "../wire/history";
import type { ChatToHost, HostToChat } from "../../webview/shared/protocol";
import type { HostCtx } from "./chatHost";

export type HistoryMessage = Extract<ChatToHost, { t: "rewindCheck" | "rewind" | "export" | "exportSave" }>;

/** Where the owner last saved an export, in the extension's global state: the next save dialog opens there (74). */
const EXPORT_FOLDER_KEY = "embarchChat.exportFolder";

/** The owner's message as a note quotes it: its first line, cut short. */
function quote(text: string): string {
  const l = text.trim().split("\n")[0];
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
}

/** Why the files of this chat cannot be rewound now, or null. Only a chat this window runs has the process that holds its checkpoints. */
function noFileRewind(rec: ChatRecord): string | null {
  if (!rec.ours) return "Its files are rewound from where this chat runs; here only the conversation, as a fork.";
  if (rec.chat.state.busy || rec.chat.state.compacting) return "Claude is working: stop the turn first.";
  if (rec.chat.state.pending.length) return "Claude waits on your answer: answer or stop first.";
  return null;
}

export async function historyMessage(ctx: HostCtx, rec: ChatRecord, m: HistoryMessage, post: (m: HostToChat) => void): Promise<void> {
  const chat = rec.chat;
  switch (m.t) {
    case "rewindCheck": {
      const no = noFileRewind(rec);
      let result: RewindResult;
      if (no) result = { canRewind: false, error: no };
      else {
        try {
          result = await chat.rewindFiles(m.uuid, true);
        } catch (e) {
          result = { canRewind: false, error: (e as Error).message };
        }
      }
      post({ t: "rewindCheck", uuid: m.uuid, result });
      return;
    }
    case "rewind": {
      const e = Object.values(chat.state.entries).find((x) => x.kind === "user" && x.uuid === m.uuid);
      const what = e && e.kind === "user" ? `“${quote(e.text)}”` : "that message";
      if (m.restore !== "conversation") {
        // Files change on disk: only as confirmed, from the dry run the owner saw.
        const no = noFileRewind(rec);
        if (no) return chat.note(`Files not rewound: ${no}`, "error");
        try {
          const r = await chat.rewindFiles(m.uuid, false);
          if (!r.canRewind) return chat.note(`Files not rewound: ${r.error ?? "Claude Code could not."}`, "error");
          const skipped = r.skippedLinks ? ` ${r.skippedLinks} link${r.skippedLinks > 1 ? "s were" : " was"} left alone.` : "";
          chat.note(`Files rewound to before ${what}.${skipped}`);
        } catch (err) {
          return chat.note(`Files not rewound: ${(err as Error).message}`, "error");
        }
      }
      if (m.restore !== "code") await ctx.fork(chat.sessionId, m.uuid);
      return;
    }
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
      // Where the last export went, else the home folder — never the chat's
      // own: a repo's working tree is one `git add .` from a remote, and a
      // conversation about a client's firmware stays local (review r4 L3).
      const last = ctx.remembered.get<string>(EXPORT_FOLDER_KEY);
      const dir = last && fs.existsSync(last) ? last : os.homedir();
      const name = path.basename(m.filename) || "conversation.txt";
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(dir, name)), filters: { Text: ["txt"] }, title: "Export conversation" });
      if (!uri) return;
      try {
        fs.writeFileSync(uri.fsPath, m.text);
        ctx.log(`[${chat.sessionId.slice(0, 8)}] exported to ${uri.fsPath}`);
        await ctx.remembered.update(EXPORT_FOLDER_KEY, path.dirname(uri.fsPath));
      } catch (err) {
        void vscode.window.showErrorMessage(`Conversation not saved: ${(err as Error).message}`);
      }
      return;
    }
  }
}
