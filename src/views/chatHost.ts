// One webview showing one chat — the secondary sidebar's (decision 17) or an
// editor tab's. The host keeps the state; the webview gets one snapshot and
// then every event, folding them with the same reducer.

import * as path from "path";
import * as vscode from "vscode";
import type { ChatManager } from "../chats";
import type { DeskService } from "../deskService";
import type { ContentDocs } from "../content";
import type { DiffContent, Proposals } from "../diff";
import { diffSides } from "../diff";
import { atlasInfo, citationTarget } from "../atlas";
import { jump } from "../jump";
import { mentionItems } from "../mentions";
import type { WireMessage } from "../wire/types";
import type { ChatRecord } from "../chats";
import type { HaikuAssistant } from "../assistant/assistant";
import { lastReply } from "../assistant/assistant";
import type { Chip } from "../assistant/edits";
import { splitCompact } from "../assistant/edits";
import type { PromptHistory } from "../assistant/history";
import type { AssistInput } from "../assistant/prompts";
import type { LibraryEntry } from "../library/entries";
import { invocation } from "../library/entries";
import type { ChatToHost, Header, HostToChat } from "../../webview/shared/protocol";

export interface HostCtx {
  chats: ChatManager;
  desk: DeskService;
  diff: DiffContent;
  /** A pending Edit's or Write's diff, change by change (decision 64). */
  proposals: Proposals;
  /** A tool's whole input or output in an editor tab (decision 62). */
  content: ContentDocs;
  log: (s: string) => void;
  claudePath: () => string;
  deskUrl: (itemId: string | null) => string;
  uiUrl: () => string;
  warning: () => string | null;
  openInEditor: (sid: string) => void;
  newChat: (itemId?: string) => void;
  /** The Haiku assistant (embarch-chat-assistant-proposal.md), on or off by setting. */
  assistant: HaikuAssistant;
  assistantOn: () => boolean;
  /** The owner's past prompts, for the instant wave (26). */
  history: PromptHistory;
  /** The 📚's entries (38). */
  library: () => LibraryEntry[];
  /** A new chat on the same work item that starts with this chat's handoff (36). */
  freshChat: (sid: string) => void;
  /** Makes a resumable thread this window's (32) for the owner's message; false when it may not be resumed here (the message then stays in the refusal's note). */
  resume: (sid: string, text: string) => Promise<boolean>;
  /** The owner names a chat (decision 75). */
  rename: (sid: string) => Promise<void>;
}

/** The chat's card in two lines (decision 18), from the desk's view. */
export function headerFor(ctx: HostCtx, rec: ChatRecord): Header {
  const itemId = rec.itemId ?? ctx.desk.thread(rec.chat.sessionId)?.group.item?.id ?? null;
  const card = ctx.desk.card(itemId);
  const today = ctx.desk.view?.today;
  const tile = card?.tiles?.find((x) => x.date === today);
  return {
    itemId,
    issueKey: card?.issue?.key,
    issueUrl: card?.issue?.url,
    title: card ? (card.issue?.title ?? card.title) : (rec.itemTitle ?? (itemId ? itemId : "Untracked")),
    stateName: card?.issue?.state_name,
    prs: card?.prs ?? [],
    todaySeconds: tile?.seconds ?? 0,
    deskUrl: ctx.deskUrl(itemId),
    untracked: !itemId,
  };
}

/** What the assistant sees (decision 27): the draft, Claude's last reply, the item's card, the library's names, the context usage. */
export function assistInput(ctx: HostCtx, rec: ChatRecord, draft: string): AssistInput {
  const h = headerFor(ctx, rec);
  const st = rec.chat.state;
  return {
    draft,
    lastReply: lastReply(st),
    item: h.untracked ? null : { key: h.issueKey, title: h.title, state: h.stateName, prs: h.prs.map((p) => `PR #${p.number} ${p.draft ? "draft" : p.state}`) },
    library: ctx.library().map((e) => invocation(e, st.slashCommands) ?? e.name),
    context: st.context ? { percentage: st.context.percentage, totalTokens: st.context.totalTokens, maxTokens: st.context.maxTokens } : null,
  };
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
  private onDraft = (sid: string) => {
    if (sid === this.sid && this.ready) this.pushDraft();
  };
  private onChips = (sid: string, chips: Chip[]) => {
    if (sid === this.sid && this.ready) this.post({ t: "chips", sid, chips });
  };
  private promptsSent = -1;
  private onPrompts = () => {
    if (this.ready) this.pushPrompts();
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
    ctx.chats.on("draft", this.onDraft);
    ctx.desk.on("changed", this.onDesk);
    ctx.assistant.on("chips", this.onChips);
    ctx.history.on("changed", this.onPrompts);
    this.subs.push(webview.onDidReceiveMessage((m: ChatToHost) => void this.onMessage(m)));
    // The times above messages come and go with their setting (68).
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("embarchChat.showMessageTimestamps")) this.snapshot();
      }),
    );
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
      view: {
        ours: rec.ours,
        readOnly: !rec.ours && !rec.resumable,
        resumable: !rec.ours && rec.resumable,
        where,
        inEditor: this.inEditor,
        uiUrl: this.ctx.uiUrl(),
        atlas: (() => {
          const a = atlasInfo(rec.chat.opts.cwd || rec.chat.state.cwd || "");
          return a ? { docs: a.docs, boards: a.boards } : null;
        })(),
        timestamps: vscode.workspace.getConfiguration("embarchChat").get<boolean>("showMessageTimestamps", false),
      },
      header: this.header(),
      warning: this.ctx.warning(),
    });
    this.post({ t: "chips", sid: rec.chat.sessionId, chips: this.ctx.assistant.chipsFor(rec.chat.sessionId) });
    this.post({ t: "library", entries: this.ctx.library(), assistant: this.ctx.assistantOn() });
    this.pushPrompts();
    this.pushDraft();
    // A turn that ended while the chat was off screen gets its chips now (34).
    if (rec.ours) void this.ctx.assistant.shown(rec.chat.sessionId, () => assistInput(this.ctx, rec, ""));
  }

  /** Text for the draft, once, to the page showing the chat. */
  private pushDraft(): void {
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (!rec?.draft) return;
    this.post({ t: "draft", sid: rec.chat.sessionId, text: rec.draft });
    rec.draft = null;
  }

  /** The owner's past prompts, when they changed since this page last got them. */
  private pushPrompts(): void {
    const v = this.ctx.history.version;
    if (v === this.promptsSent) return;
    this.promptsSent = v;
    this.post({ t: "prompts", items: this.ctx.history.prompts() });
  }

  private header(): Header | null {
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    return rec ? headerFor(this.ctx, rec) : null;
  }

  private async onMessage(m: ChatToHost): Promise<void> {
    if (m.t === "ready") {
      this.ready = true;
      this.promptsSent = -1;
      this.post({ t: "library", entries: this.ctx.library(), assistant: this.ctx.assistantOn() });
      this.snapshot();
      return;
    }
    if (m.t === "newChat") return this.ctx.newChat();
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (!rec) return;
    const chat = rec.chat;
    // A permission, question or plan prompt; a dialog or an elicitation takes `respond` (66).
    const pending = (id: string) => chat.state.pending.find((p) => p.requestId === id && p.form !== "dialog" && p.form !== "elicitation");
    switch (m.t) {
      case "send": {
        if (!rec.ours) {
          if (!(await this.ctx.resume(chat.sessionId, m.text))) {
            this.snapshot();
            return;
          }
          this.snapshot();
        }
        this.ctx.assistant.sent(chat.sessionId, { handoff: m.handoff });
        // The compact card's first line goes first, the rest after its compaction (decision 36).
        const split = splitCompact(m.text);
        if (split && rec.ours) chat.sendAfterCompact(split.compact, split.rest);
        else chat.send(m.text);
        return;
      }
      case "assist": {
        if (!rec.ours) return;
        const input = assistInput(this.ctx, rec, m.text);
        if (m.kind === "ghost") {
          const text = await this.ctx.assistant.ghost(chat.sessionId, input, (t) => this.post({ t: "ghost", seq: m.seq, text: t, done: false }));
          this.post({ t: "ghost", seq: m.seq, text: text ?? "", done: true });
        } else {
          const cards = await this.ctx.assistant.cards(chat.sessionId, input);
          this.post({ t: "cards", seq: m.seq, cards: cards ?? [] });
        }
        return;
      }
      case "assistCancel":
        this.ctx.assistant.cancel(chat.sessionId);
        return;
      case "freshChat":
        return this.ctx.freshChat(chat.sessionId);
      case "rename":
        return this.ctx.rename(chat.sessionId);
      case "allow": {
        const p = pending(m.requestId);
        // Every change rejected in the diff tab: Allow has nothing left to allow (64).
        if (p && this.ctx.proposals.rejectsAll(p.requestId)) chat.deny(p, "The user rejected every change of this edit.");
        else if (p) chat.allow(p, m.always);
        this.ctx.proposals.done(m.requestId);
        return;
      }
      case "deny": {
        const p = pending(m.requestId);
        if (p) chat.deny(p, m.message?.trim() || (p.form === "plan" ? "Keep planning." : "The user declined this tool call."));
        this.ctx.proposals.done(m.requestId);
        return;
      }
      case "answer": {
        const p = pending(m.requestId);
        if (p) chat.answerQuestion(p, m.answers);
        return;
      }
      case "respond": {
        const p = chat.state.pending.find((x) => x.requestId === m.requestId);
        if (p) chat.respond(p, m.response);
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
          // Change by change when it can be taken so (64); else the plain diff.
          if (p && (await this.ctx.proposals.open(chat.sessionId, p, cwd))) return;
          if (p) d = diffSides(p.toolName, p.input, undefined, cwd);
        }
        if (d) await this.ctx.diff.open(d);
        return;
      }
      case "openContent": {
        const e = chat.state.entries[m.toolId];
        if (e?.kind === "tool") await this.ctx.content.open(e, m.part);
        return;
      }
      case "openFile": {
        // A path, never a URI (vscode:, command:, file:, ...); one letter is a Windows drive.
        if (/^[a-z][a-z0-9+.-]+:/i.test(m.path)) return;
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
      case "atlas": {
        const a = atlasInfo(chat.opts.cwd || chat.state.cwd || "");
        const target = a && citationTarget(a, m);
        if (!target) {
          void vscode.window.showInformationMessage(`The atlas has nothing for ${m.doc ? `${m.doc} p${m.page}` : `${m.board}:${m.ref}`}.`);
          return;
        }
        const doc = await vscode.workspace.openTextDocument(target.file);
        const ed = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
        if (target.line) {
          const pos = new vscode.Position(target.line - 1, 0);
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
    this.ctx.chats.off("draft", this.onDraft);
    this.ctx.desk.off("changed", this.onDesk);
    this.ctx.assistant.off("chips", this.onChips);
    this.ctx.history.off("changed", this.onPrompts);
    for (const s of this.subs) s.dispose();
  }
}
