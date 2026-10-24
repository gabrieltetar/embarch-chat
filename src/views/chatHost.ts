// One webview showing one chat — the secondary sidebar's (decision 17) or an
// editor tab's. The host keeps the state; the webview gets one snapshot and
// then every event, folding them with the same reducer.

import * as path from "path";
import * as vscode from "vscode";
import type { ChatManager } from "../chats";
import type { DeskService } from "../deskService";
import type { ContentDocs } from "../content";
import type { DiffContent, Proposals } from "../diff";
import type { PlanDocs } from "../plans";
import { isDestination } from "../wire/cards";
import { diffSides } from "../diff";
import { atlasInfo, citationTarget } from "../atlas";
import { DeskError } from "../desk/client";
import { jump } from "../jump";
import { mentionItems, mentionOf } from "../mentions";
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
import { historyMessage } from "./history";
import type { Attachment, ContextItem } from "../wire/message";
import { IMAGE_TYPES } from "../wire/message";
import type { EditorContext, EditorItem } from "../editorContext";
import { editorItem, editorLabel } from "../editorContext";
import { terminalOutput } from "../terminals";
import type { ChatToHost, Header, HostToChat } from "../../webview/shared/protocol";

export interface HostCtx {
  chats: ChatManager;
  desk: DeskService;
  diff: DiffContent;
  /** A pending Edit's or Write's diff, change by change (decision 64). */
  proposals: Proposals;
  /** A tool's whole input or output in an editor tab (decision 62). */
  content: ContentDocs;
  /** A pending plan as a tab to comment on, line by line (decision 77). */
  plans: PlanDocs;
  /** The extension's global state: where the owner last chose to save an "always allow" (78). */
  remembered: vscode.Memento;
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
  /** A new chat on the same work item, forked from this one before the owner's message `uuid` (decision 73). */
  fork: (sid: string, uuid: string) => Promise<void>;
  /** The owner names a chat (decision 75). */
  rename: (sid: string) => Promise<void>;
  /** The editor's open file or selection, which goes with a message by default (60). */
  editor: EditorContext;
}

/** Where an "always allow" was last saved, in the extension's global state (78). */
const DESTINATION_KEY = "embarchChat.permissionDestination";

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

/** A pasted image as the page sent it: one of the API's types, base64. */
const isImage = (i: Attachment) => !!i && IMAGE_TYPES.includes(i.mediaType) && typeof i.data === "string" && /^[A-Za-z0-9+/=]+$/.test(i.data);

/** The editor's file or selection as the page sent it back: one the host gave it (60). */
function editorBack(e: EditorItem | undefined): ContextItem[] {
  if (!e || typeof e.path !== "string" || !e.path) return [];
  if (e.kind === "file") return [{ kind: "file", path: e.path }];
  if (e.kind === "selection" && Number.isInteger(e.startLine) && Number.isInteger(e.endLine) && typeof e.text === "string") {
    return [{ kind: "selection", path: e.path, startLine: e.startLine, endLine: e.endLine, text: e.text }];
  }
  return [];
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
  private onEditor = () => {
    if (this.ready) this.pushEditor();
  };

  /** Messages go in the order sent, though one waits — to resume its chat, for a terminal's output. */
  private sending: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(
    private webview: vscode.Webview,
    private ctx: HostCtx,
    public sid: string | null,
    private inEditor: boolean,
    /** Brings this page's view or tab forward, with focus. */
    private reveal: () => void = () => {},
  ) {
    ctx.chats.on("event", this.onEvent);
    ctx.chats.on("snapshot", this.onSnapshot);
    ctx.chats.on("changed", this.onSnapshotIfView);
    ctx.chats.on("draft", this.onDraft);
    ctx.desk.on("changed", this.onDesk);
    ctx.assistant.on("chips", this.onChips);
    ctx.history.on("changed", this.onPrompts);
    ctx.editor.on("changed", this.onEditor);
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
        permDestination: this.ctx.remembered.get<string>(DESTINATION_KEY),
      },
      header: this.header(),
      warning: this.ctx.warning(),
    });
    this.post({ t: "chips", sid: rec.chat.sessionId, chips: this.ctx.assistant.chipsFor(rec.chat.sessionId) });
    this.post({ t: "library", entries: this.ctx.library(), assistant: this.ctx.assistantOn() });
    this.pushPrompts();
    this.pushDraft();
    this.pushEditor();
    // A turn that ended while the chat was off screen gets its chips now (34).
    if (rec.ours) void this.ctx.assistant.shown(rec.chat.sessionId, () => assistInput(this.ctx, rec, ""));
  }

  /** The editor's file or selection, with its words from the chat's folder (60). */
  private pushEditor(): void {
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    const item = this.ctx.editor.current;
    if (!rec) return;
    this.post({ t: "editor", editor: item ? { ...item, label: editorLabel(item, rec.chat.opts.cwd || rec.chat.state.cwd || "") } : null });
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
      for (const k of this.keyed.splice(0)) this.post(k);
      return;
    }
    if (m.t === "newChat") return this.ctx.newChat();
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (!rec) return;
    const chat = rec.chat;
    // A permission, question or plan prompt; a dialog or an elicitation takes `respond` (66).
    const pending = (id: string) => chat.state.pending.find((p) => p.requestId === id && p.form !== "dialog" && p.form !== "elicitation");
    switch (m.t) {
      case "send":
        // One that waits nowhere goes at once, as it always did.
        if (!this.waiting && rec.ours && !m.terminals?.length) return this.deliver(rec, m, []);
        this.waiting++;
        // To the chat it was written in, whichever this page shows when its turn comes.
        this.sending = this.sending
          .then(() => this.send(m, rec))
          .catch((e) => this.ctx.log(`send: ${(e as Error).message}`))
          .finally(() => void this.waiting--);
        return;
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
      case "rewindCheck":
      case "rewind":
      case "export":
      case "exportSave":
        return historyMessage(this.ctx, rec, m, (x) => this.post(x));
      case "btw":
        if (rec.ours && typeof m.question === "string" && m.question.trim()) await chat.ask(m.question.trim());
        return;
      case "sideClear":
        return chat.clearSide();
      case "allow": {
        const p = pending(m.requestId);
        // A plan: into auto mode, or into ask mode, as Claude Code approves one (77).
        if (p?.form === "plan") {
          this.ctx.plans.done(p.requestId);
          return chat.approvePlan(p, m.mode === "default" ? "default" : "auto");
        }
        // Every change rejected in the diff tab: Allow has nothing left to allow (64).
        if (p && this.ctx.proposals.rejectsAll(p.requestId)) chat.deny(p, "The user rejected every change of this edit.");
        // Always: the suggestions the owner kept, where the owner picked — one of Claude Code's four places, never anything else (78).
        else if (p)
          chat.allow(
            p,
            !!m.always && {
              picks: Array.isArray(m.picks) ? m.picks.filter((i) => Number.isInteger(i)) : undefined,
              destination: isDestination(m.destination) ? m.destination : undefined,
            },
          );
        this.ctx.proposals.done(m.requestId);
        return;
      }
      case "deny": {
        const p = pending(m.requestId);
        // A plan goes back with what was typed and its comments, in Claude Code's words (77).
        if (p?.form === "plan") chat.keepPlanning(p, m.message ?? "");
        else if (p) chat.deny(p, m.message?.trim() || "The user declined this tool call.");
        this.ctx.proposals.done(m.requestId);
        this.ctx.plans.done(m.requestId);
        return;
      }
      case "openPlan": {
        const p = pending(m.requestId);
        if (p?.form === "plan") await this.ctx.plans.open(chat.sessionId, p);
        return;
      }
      case "removePlanComment":
        return this.ctx.plans.remove(m.requestId, m.id);
      case "permDestination":
        // Remembered for every chat and window, as Claude Code remembers it (78).
        if (isDestination(m.destination)) await this.ctx.remembered.update(DESTINATION_KEY, m.destination);
        return;
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
      // Work that runs on its own (port items 70–72): only where the chat runs.
      case "runInBackground":
        if (rec.ours) await chat.runInBackground(m.toolUseId);
        return;
      case "stopTask":
        if (rec.ours) await chat.stopTask(m.taskId);
        return;
      case "taskOutput": {
        if (!rec.ours) return;
        try {
          this.post({ t: "taskOutput", taskId: m.taskId, ...(await chat.taskOutput(m.taskId)) });
        } catch (e) {
          this.post({ t: "taskOutput", taskId: m.taskId, error: (e as Error).message });
        }
        return;
      }
      case "cancelQueued":
        if (rec.ours) await chat.cancelQueued(m.id);
        return;
      case "sendNow":
        if (rec.ours) await chat.sendNow(m.id);
        return;
      case "mode":
        return chat.setMode(m.mode);
      case "model":
        return chat.setModel(m.model);
      case "effort":
        return chat.setEffort(typeof m.effort === "string" ? m.effort : null, m.ultracode === true);
      case "compact":
        if (rec.ours) chat.compact();
        return;
      case "refreshContext":
        return chat.refreshContext();
      case "remoteControl":
        if (rec.ours) await chat.remoteControl(typeof m.name === "string" && m.name.trim() ? m.name.trim() : undefined);
        return;
      case "keep": {
        // The reply's own text, from the host's state: the page names it, never supplies it.
        const e = chat.state.entries[m.entryId];
        if (e?.kind !== "text" || !e.text.trim() || (m.kind !== "finding" && m.kind !== "decision")) return;
        try {
          const r = await this.ctx.desk.keep(chat.sessionId, e.text, m.kind);
          this.post({ t: "kept", entryId: m.entryId, kind: m.kind, held: r.held });
        } catch (err) {
          const why = err instanceof DeskError && err.unreachable ? "the desk is not running" : err instanceof DeskError && err.status === 404 ? "the desk has not seen this chat" : (err as Error).message;
          this.post({ t: "kept", entryId: m.entryId, kind: m.kind, error: why });
        }
        return;
      }
      case "mcpStatus":
        return chat.mcpStatus();
      case "mcp":
        if (rec.ours) await chat.mcpAction(m.name, m.action);
        return;
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

  private async send(m: Extract<ChatToHost, { t: "send" }>, rec: ChatRecord): Promise<void> {
    if (this.ctx.chats.get(rec.chat.sessionId) !== rec) {
      // A read-only view dropped since, as another thread opened: the message stays with it, to copy.
      this.ctx.chats.keepNote(rec.chat.sessionId, { type: "_note", text: "This chat was closed before your message went. Your message was not sent:", tone: "error", kept: m.text });
      return;
    }
    if (!rec.ours) {
      if (!(await this.ctx.resume(rec.chat.sessionId, m.text))) {
        this.snapshot();
        return;
      }
      this.snapshot();
    }
    // A terminal's output is read now, as Claude Code reads it at send (58);
    // reading it shows the terminal, so the page gets focus back after.
    const terminals: ContextItem[] = [];
    const names = (m.terminals ?? []).filter((n) => typeof n === "string");
    for (const name of names) {
      const text = await terminalOutput(name, this.ctx.log);
      if (text !== null) terminals.push({ kind: "terminal", name, text });
    }
    if (names.length) this.focusInput();
    this.deliver(rec, m, terminals);
  }

  private deliver(rec: ChatRecord, m: Extract<ChatToHost, { t: "send" }>, terminals: ContextItem[]): void {
    const chat = rec.chat;
    this.ctx.assistant.sent(chat.sessionId, { handoff: m.handoff });
    const images = (m.images ?? []).filter(isImage);
    const extra = { pastes: (m.pastes ?? []).filter((p) => typeof p === "string"), context: [...editorBack(m.editor), ...terminals] };
    // The compact card's first line goes first, the rest after its compaction (decision 36).
    const split = splitCompact(m.text);
    if (split && rec.ours) chat.sendAfterCompact(split.compact, split.rest, images, extra);
    else chat.send(m.text, images, extra);
  }

  /** For a page not yet loaded: what a key asked of it (59), posted once it is ready. */
  private keyed: HostToChat[] = [];

  private postKeyed(m: HostToChat): void {
    if (this.ready) this.post(m);
    else this.keyed.push(m);
  }

  /** This page forward, its input focused. */
  focusInput(): void {
    this.reveal();
    this.postKeyed({ t: "focus" });
  }

  /**
   * The editor's file and selected lines as an @-mention at the input's
   * caret (Alt+Shift+K, 59), from this chat's folder. `unlessChip`: not when
   * the editor chip (60) already carries the same lines — the page knows
   * whether it shows it.
   */
  insertMention(ed: vscode.TextEditor, opts: { unlessChip?: boolean } = {}): void {
    const rec = this.sid ? this.ctx.chats.get(this.sid) : undefined;
    if (!rec) return;
    this.reveal();
    const sel = editorItem(ed, { attachOpenFile: false, attachSelection: true });
    const lines = opts.unlessChip && sel?.kind === "selection" ? { unlessChip: { path: sel.path, startLine: sel.startLine, endLine: sel.endLine } } : {};
    this.postKeyed({ t: "insert", text: `@${mentionOf(ed, rec.chat.opts.cwd || rec.chat.state.cwd || "")} `, ...lines });
  }

  dispose(): void {
    this.ctx.chats.off("event", this.onEvent);
    this.ctx.chats.off("snapshot", this.onSnapshot);
    this.ctx.chats.off("changed", this.onSnapshotIfView);
    this.ctx.chats.off("draft", this.onDraft);
    this.ctx.desk.off("changed", this.onDesk);
    this.ctx.assistant.off("chips", this.onChips);
    this.ctx.history.off("changed", this.onPrompts);
    this.ctx.editor.off("changed", this.onEditor);
    for (const s of this.subs) s.dispose();
  }
}
