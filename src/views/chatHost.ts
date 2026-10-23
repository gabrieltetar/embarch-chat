// One webview showing one chat — the secondary sidebar's (decision 17) or an
// editor tab's. The host keeps the state; the webview gets one snapshot and
// then every event, folding them with the same reducer.

import * as path from "path";
import * as vscode from "vscode";
import type { ChatManager } from "../chats";
import type { DeskService } from "../deskService";
import type { DiffContent } from "../diff";
import { diffSides } from "../diff";
import { jump } from "../jump";
import { mentionItems } from "../mentions";
import type { WireMessage } from "../wire/types";
import type { ChatToHost, Header, HostToChat } from "../../webview/shared/protocol";

export interface HostCtx {
  chats: ChatManager;
  desk: DeskService;
  diff: DiffContent;
  log: (s: string) => void;
  claudePath: () => string;
  deskUrl: (itemId: string | null) => string;
  warning: () => string | null;
  openInEditor: (sid: string) => void;
  newChat: (itemId?: string) => void;
}

export class ChatHost implements vscode.Disposable {
  private subs: vscode.Disposable[] = [];
  private ready = false;
  private onEvent = (sid: string, e: WireMessage) => {
    if (sid === this.sid && this.ready) this.post({ t: "event", e });
  };
  private onSnapshot = (sid: string) => {
    if (sid === this.sid) this.snapshot();
  };
  private onDesk = () => {
    if (this.ready && this.sid) this.post({ t: "header", header: this.header() });
  };

  constructor(
    private webview: vscode.Webview,
    private ctx: HostCtx,
    public sid: string | null,
    private inEditor: boolean,
  ) {
    ctx.chats.on("event", this.onEvent);
    ctx.chats.on("snapshot", this.onSnapshot);
    ctx.chats.on("changed", this.onSnapshotIfView);
    ctx.desk.on("changed", this.onDesk);
    this.subs.push(webview.onDidReceiveMessage((m: ChatToHost) => void this.onMessage(m)));
  }

  /** A viewer that became the owner's changes how it renders. */
  private onSnapshotIfView = () => {
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (rec && this.lastOurs !== rec.ours) this.snapshot();
  };
  private lastOurs: boolean | null = null;

  private post(m: HostToChat): void {
    void this.webview.postMessage(m);
  }

  show(sid: string | null): void {
    this.sid = sid;
    this.snapshot();
  }

  snapshot(): void {
    if (!this.ready) return;
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (!rec) {
      this.post({ t: "empty", warning: this.ctx.warning() });
      return;
    }
    this.lastOurs = rec.ours;
    const t = this.ctx.desk.thread(rec.chat.sessionId)?.thread;
    const where = rec.ours ? undefined : t?.live ? (t.client === "embarch-chat" ? "another window's chat" : t.client ? t.client : "a terminal or Claude Code's panel") : undefined;
    this.post({
      t: "snapshot",
      state: rec.chat.state,
      view: { ours: rec.ours, readOnly: !rec.ours && !rec.resumable, resumable: !rec.ours && rec.resumable, where, inEditor: this.inEditor },
      header: this.header(),
      warning: this.ctx.warning(),
    });
  }

  private header(): Header | null {
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (!rec) return null;
    const itemId = rec.itemId ?? this.ctx.desk.thread(rec.chat.sessionId)?.group.item?.id ?? null;
    const card = this.ctx.desk.card(itemId);
    const today = this.ctx.desk.view?.today;
    const tile = card?.tiles?.find((x) => x.date === today);
    return {
      itemId,
      issueKey: card?.issue?.key,
      issueUrl: card?.issue?.url,
      title: card ? (card.issue?.title ?? card.title) : (rec.itemTitle ?? (itemId ? itemId : "Untracked")),
      stateName: card?.issue?.state_name,
      prs: card?.prs ?? [],
      todaySeconds: tile?.seconds ?? 0,
      deskUrl: this.ctx.deskUrl(itemId),
      untracked: !itemId,
    };
  }

  private async onMessage(m: ChatToHost): Promise<void> {
    if (m.t === "ready") {
      this.ready = true;
      this.snapshot();
      return;
    }
    if (m.t === "newChat") return this.ctx.newChat();
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (!rec) return;
    const chat = rec.chat;
    const pending = (id: string) => chat.state.pending.find((p) => p.requestId === id);
    switch (m.t) {
      case "send": {
        if (!rec.ours) {
          const adopted = this.ctx.chats.adopt(chat.sessionId);
          if (!adopted) return;
          // Marked as this panel's on the desk; same item, so nothing moves.
          void this.ctx.desk.client.assign(chat.sessionId, rec.itemId ? { item_id: rec.itemId } : { untracked: true }).catch((e) => this.ctx.log(`assign on resume: ${(e as Error).message}`));
          this.snapshot();
        }
        chat.send(m.text);
        return;
      }
      case "allow": {
        const p = pending(m.requestId);
        if (p) chat.allow(p, m.always);
        return;
      }
      case "deny": {
        const p = pending(m.requestId);
        if (p) chat.deny(p, m.message?.trim() || (p.form === "plan" ? "Keep planning." : "The user declined this tool call."));
        return;
      }
      case "answer": {
        const p = pending(m.requestId);
        if (p) chat.answerQuestion(p, m.answers);
        return;
      }
      case "interrupt":
        return chat.interrupt();
      case "mode":
        return chat.setMode(m.mode);
      case "model":
        return chat.setModel(m.model);
      case "compact":
        if (rec.ours) chat.compact();
        return;
      case "refreshContext":
        return chat.refreshContext();
      case "openDiff": {
        const cwd = chat.opts.cwd || chat.state.cwd || "";
        let d = null;
        if (m.toolId) {
          const e = chat.state.entries[m.toolId];
          if (e && e.kind === "tool") d = diffSides(e.name, e.input, e.structured, cwd);
        } else if (m.requestId) {
          const p = pending(m.requestId);
          if (p) d = diffSides(p.toolName, p.input, undefined, cwd);
        }
        if (d) await this.ctx.diff.open(d);
        return;
      }
      case "openFile": {
        const cwd = chat.opts.cwd || chat.state.cwd || "";
        const abs = path.isAbsolute(m.path) ? m.path : path.join(cwd, m.path);
        const doc = await vscode.workspace.openTextDocument(abs).then(
          (d) => d,
          () => null,
        );
        if (!doc) return;
        const ed = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
        if (m.line) {
          const pos = new vscode.Position(Math.max(0, m.line - 1), 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
        return;
      }
      case "openLink":
        if (/^https?:\/\//.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case "mention": {
        const items = await mentionItems(m.q, chat.opts.cwd || chat.state.cwd || "");
        this.post({ t: "mentions", q: m.q, items });
        return;
      }
      case "jump": {
        const t = this.ctx.desk.thread(chat.sessionId)?.thread;
        if (t) await jump(t, this.ctx.desk.isWindowFolder(t.cwd), this.ctx.desk.client, this.ctx.claudePath(), this.ctx.log);
        return;
      }
      case "openInEditor":
        return this.ctx.openInEditor(chat.sessionId);
      case "states": {
        const h = this.header();
        if (!h?.itemId) return;
        try {
          const r = await this.ctx.desk.client.states(h.itemId);
          this.post({ t: "states", states: r.states });
        } catch (e) {
          this.post({ t: "states", states: [], error: (e as Error).message });
        }
        return;
      }
      case "setStatus": {
        const h = this.header();
        if (!h?.itemId) return;
        try {
          await this.ctx.desk.client.setStatus(h.itemId, m.stateId);
          await this.ctx.desk.refresh();
        } catch (e) {
          void vscode.window.showErrorMessage(`Status not changed: ${(e as Error).message}`);
        }
        return;
      }
    }
  }

  dispose(): void {
    this.ctx.chats.off("event", this.onEvent);
    this.ctx.chats.off("snapshot", this.onSnapshot);
    this.ctx.chats.off("changed", this.onSnapshotIfView);
    this.ctx.desk.off("changed", this.onDesk);
    for (const s of this.subs) s.dispose();
  }
}
