// The chat's history, host side (decisions 73 and 74): a rewind
// checked with a dry run, then done — the files only with the owner's
// confirmation, the conversation always as a fork, as Claude Code's panel
// does it — and the export dialog's text and its save. The confirmation is
// not the page's word alone (review r4 L4): the files are rewound only if
// a dry run at that moment says what the one the owner saw said, and never
// while a background task may still be writing them.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ChatRecord } from "../chats";
import type { Chat, RewindResult } from "../wire/chat";
import type { UserEntry } from "../wire/reducer";
import { conversationText, exportFileName } from "../wire/history";
import type { ChatToHost, HostToChat } from "../../webview/shared/protocol";
import type { HostCtx } from "./chatHost";

export type HistoryMessage = Extract<ChatToHost, { t: "rewindCheck" | "rewind" | "export" | "exportSave" }>;

/** The export each chat's dialog was given: Save writes it, as Keep takes its text from host state (84) — never the page's. */
const exported = new WeakMap<Chat, { text: string; filename: string }>();

/** Where the owner last saved an export, in the extension's global state: the next save dialog opens there (74). */
const EXPORT_FOLDER_KEY = "embarchChat.exportFolder";

/** The owner's message as a note quotes it: its first line, cut short. */
function quote(text: string): string {
  const l = text.trim().split("\n")[0];
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
}

/** Why a message of another chat, or none, is refused; one given back unsent, never sent. */
const NOT_OURS = "That message is not one of this chat's.";
const NOT_SENT = "That message was not sent.";

/**
 * The owner's message `uuid` in this chat, as the page offers it — settled,
 * with its uuid on record — or why it is refused. A rewind or a fork names
 * one of the chat this page serves, never another's (review r4 UI M3): the
 * page's dialog is its chat's, and the host checks it again. One given back
 * unsent is in no transcript (review r6 L1).
 */
function ownerMessage(chat: Chat, uuid: string): UserEntry | string {
  if (typeof uuid !== "string" || !uuid) return NOT_OURS;
  const e = Object.values(chat.state.entries).find((x): x is UserEntry => x.kind === "user" && x.uuid === uuid);
  if (e?.unsent) return NOT_SENT;
  return e && !e.pending && !e.held ? e : NOT_OURS;
}

/** Why the files of this chat cannot be rewound now, or null. Only a chat this window runs has the process that holds its checkpoints. */
function noFileRewind(rec: ChatRecord): string | null {
  if (!rec.ours) return "Its files are rewound from where this chat runs; here only the conversation, as a fork.";
  if (rec.chat.state.busy || rec.chat.state.compacting) return "Claude is working: stop the turn first.";
  if (rec.chat.state.pending.length) return "Claude waits on your answer: answer or stop first.";
  // A background shell or subagent could change files after the dry run, or write over the rewind.
  if (rec.chat.state.background.length) return "A background task runs: stop it, or let it finish, first.";
  return null;
}

/** The dry run each chat's owner was last shown, by message: what a rewind may do without asking again. */
const shown = new WeakMap<Chat, Map<string, string>>();

/** A dry run as the confirmation shows it: the files, and the lines removed and added. */
const dryRunKey = (r: RewindResult) => JSON.stringify([[...(r.filesChanged ?? [])].sort(), r.insertions ?? 0, r.deletions ?? 0]);

function remember(chat: Chat, uuid: string, r: RewindResult): void {
  let m = shown.get(chat);
  if (!m) shown.set(chat, (m = new Map()));
  if (r.canRewind) m.set(uuid, dryRunKey(r));
  else m.delete(uuid);
}

export async function historyMessage(ctx: HostCtx, rec: ChatRecord, m: HistoryMessage, post: (m: HostToChat) => void): Promise<void> {
  const chat = rec.chat;
  switch (m.t) {
    case "rewindCheck": {
      const own = ownerMessage(chat, m.uuid);
      const no = typeof own === "string" ? own : noFileRewind(rec);
      let result: RewindResult;
      if (no) result = { canRewind: false, error: no };
      else {
        try {
          result = await chat.rewindFiles(m.uuid, true);
        } catch (e) {
          result = { canRewind: false, error: (e as Error).message };
        }
      }
      remember(chat, m.uuid, result);
      post({ t: "rewindCheck", uuid: m.uuid, result });
      return;
    }
    case "rewind": {
      const e = ownerMessage(chat, m.uuid);
      if (typeof e === "string") {
        ctx.log(`[${chat.sessionId.slice(0, 8)}] rewind to ${String(m.uuid).slice(0, 8)} refused: ${e === NOT_SENT ? "never sent" : "not a message of this chat's"}`);
        return chat.note(`Not rewound or forked: ${e}`, "error");
      }
      const what = `“${quote(e.text)}”`;
      if (m.restore !== "conversation") {
        // Files change on disk: only as confirmed, from the dry run the owner saw.
        const no = noFileRewind(rec);
        if (no) return chat.note(`Files not rewound: ${no}`, "error");
        try {
          // The owner confirmed one dry run: a fresh one that says otherwise is shown and asked again, and nothing is done.
          const now = await chat.rewindFiles(m.uuid, true);
          if (!now.canRewind) return chat.note(`Files not rewound: ${now.error ?? "Claude Code could not."}`, "error");
          if (shown.get(chat)?.get(m.uuid) !== dryRunKey(now)) {
            ctx.log(`[${chat.sessionId.slice(0, 8)}] rewind to ${m.uuid.slice(0, 8)}: the files changed since the confirmation; asked again`);
            remember(chat, m.uuid, now);
            post({ t: "rewindCheck", uuid: m.uuid, result: now, again: m.restore });
            return;
          }
          shown.get(chat)?.delete(m.uuid);
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
          exported.set(chat, { text: r.text, filename: r.filename });
          post({ t: "export", text: r.text, filename: r.filename });
          return;
        } catch (err) {
          ctx.log(`[${chat.sessionId.slice(0, 8)}] export: ${(err as Error).message}; the panel's own text instead`);
        }
      }
      const own = { text: conversationText(chat.state), filename: exportFileName(chat.state) };
      exported.set(chat, own);
      post({ t: "export", ...own });
      return;
    }
    case "exportSave": {
      // Where the last export went, else the home folder — never the chat's
      // own: a repo's working tree is one `git add .` from a remote, and a
      // conversation about a client's firmware stays local (review r4 L3).
      const ex = exported.get(chat);
      if (!ex) return;
      const last = ctx.remembered.get<string>(EXPORT_FOLDER_KEY);
      const dir = last && fs.existsSync(last) ? last : os.homedir();
      const name = path.basename(ex.filename) || "conversation.txt";
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(dir, name)), filters: { Text: ["txt"] }, title: "Export conversation" });
      if (!uri) return;
      try {
        fs.writeFileSync(uri.fsPath, ex.text);
        ctx.log(`[${chat.sessionId.slice(0, 8)}] exported to ${uri.fsPath}`);
        await ctx.remembered.update(EXPORT_FOLDER_KEY, path.dirname(uri.fsPath));
      } catch (err) {
        void vscode.window.showErrorMessage(`Conversation not saved: ${(err as Error).message}`);
      }
      return;
    }
  }
}
