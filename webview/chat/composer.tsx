// The input: Enter sends, Shift+Enter breaks the line, Stop while a turn
// runs (decision 8). `@` completes a workspace path (with the selected lines)
// and the CLI inlines it; `/` completes the library's entries and the
// session's own commands.
//
// The Haiku assistant comes in three waves (embarch-chat-assistant-proposal.md
// decision 26): instantly, typing through the ghost text shown and a prefix
// match over the owner's own past prompts; after a 300 ms pause, Haiku's
// ghost text, streamed, Tab takes it; after a 2 s pause or just before send,
// its cards behind the 💡 (38), each an edit to the draft previewed in place
// on hover — added words in ghost grey, removed ones struck through — applied
// on a click, Ctrl+Z restores (37). The next keystroke cancels a stale call.
// After each turn, reply chips above the input (25). The 📚 beside the 💡
// holds the library, one submenu per category (38).
//
// What goes in with the words, as Claude Code's own panel does it (56): a
// pasted screenshot is a thumbnail under the input until sent — an image
// alone sends; a long paste is remembered so the CLI can mark it; what shows
// nothing is stripped from a paste, and from the draft before it goes.
// `/btw <question>` asks aside (57): it goes to the side questions above
// the input, never into the conversation. The 💬 beside the 📚 does the
// same as a mode: tagged "Side question", every Enter asks aside until Esc
// or a second click leaves it, the draft kept. The editor's open file or
// selection shows as a chip under the input and goes with the message
// (60), unless its × was clicked or it already went with an earlier one.
// A terminal picked from the @ list is a chip too: its output is read when
// the message goes (58).

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Card, Chip, PastPrompt } from "../../src/assistant/edits";
import { CATEGORIES, applyEdit, ghostRest, prefixMatch, wordDiff } from "../../src/assistant/edits";
import type { LibraryEntry } from "../../src/library/entries";
import { byCategory, invocation } from "../../src/library/entries";
import type { Attachment } from "../../src/wire/message";
import type { EditorItem } from "../../src/editorContext";
import { IMAGE_TYPES, looksBinary, pasteToMark, pastesIn, rememberPaste, stripInvisible, strippedNotice } from "../../src/wire/message";
import type { HostToChat, MentionItem } from "../shared/protocol";
import { MODELS, MODES } from "../shared/protocol";
import { vscodeApi } from "../shared/vscode";
import { CategoryMenu, MenuGroup } from "./menus";

const post = (m: unknown) => vscodeApi.postMessage(m);

/** The waves' pauses (26), and how long a send waits for its cards: a cards call took 3.8 s live. */
export const GHOST_MS = 300;
export const CARDS_MS = 2000;
const HOLD_MS = 4500;
/** A draft this short sends at once: the owner's most-sent replies are one word (14). */
const HOLD_MIN_WORDS = 6;

interface Props {
  sid: string;
  busy: boolean;
  /** A card waits on the owner: a message sent now goes in after its answer (55). */
  waiting: boolean;
  mode: string;
  model: string | null;
  slashCommands: string[];
  placeholder: string;
  mentions: { q: string; items: MentionItem[] } | null;
  prompts: PastPrompt[];
  library: LibraryEntry[];
  /** The Haiku assistant runs (a setting). */
  assistant: boolean;
  /** This window runs the chat and it has a conversation: a side question can be asked (57). */
  canAsk: boolean;
  /** The editor's open file or selection (60). */
  editor: EditorChip | null;
  chips: Chip[];
  onSend: (text: string, opts: SendOpts) => void;
  onChip: (chip: Chip) => void;
}

export interface SendOpts {
  handoff?: boolean;
  images?: Attachment[];
  /** The long pastes the text still holds, for the CLI to mark (56). */
  pastes?: string[];
  /** The editor's file or selection (60). */
  editor?: EditorItem;
  /** Terminals whose output goes with it, by name (58). */
  terminals?: string[];
}

export type EditorChip = EditorItem & { label: string };

/** Which file or selection a chat sent last: the same one does not go again until it changes (Claude Code's rule). */
const editorSent: Record<string, string> = {};
const editorKey = (e: EditorItem) => (e.kind === "file" ? `f:${e.path}` : `s:${e.path}:${e.startLine}-${e.endLine}:${e.text.length}:${e.text.slice(0, 64)}:${e.text.slice(-64)}`);

type Pop = { kind: "at" | "slash"; start: number; q: string; items: MentionItem[]; on: number };
type Image = Attachment & { id: number };

/** A pasted image file as base64. */
const readImage = (f: File) =>
  new Promise<Attachment>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ mediaType: f.type, data: String(r.result).replace(/^data:[^,]*,/, "") });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
let imageIds = 0;
type Ghost = { base: string; completion: string; src: "local" | "haiku" };
type Undo = { before: string; after: string; cardId?: string; handoff?: boolean };

type Saved = { drafts?: Record<string, string> };

/** Unsent text survives the webview being hidden and the chat being switched, per chat. */
function saveDraft(sid: string, text: string): void {
  const st = (vscodeApi.getState() as Saved | undefined) ?? {};
  const drafts = { ...(st.drafts ?? {}) };
  if (text) drafts[sid] = text;
  else delete drafts[sid];
  vscodeApi.setState({ ...st, drafts });
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Text the host gives back to a chat's draft (a held message not sent, a
 * start the desk refused). Kept here until that chat's composer takes it:
 * it may not be mounted, or not listening yet, when the message lands.
 */
const returned: Record<string, string> = {};
export function returnToDraft(sid: string, text: string): void {
  returned[sid] = returned[sid] ? `${returned[sid]}\n\n${text}` : text;
  window.dispatchEvent(new CustomEvent("embarch-draft", { detail: sid }));
}

/**
 * The owner is typing (decision 55), by Claude Code's own rule: the draft
 * changed under the owner's hands in the last 1.5 s and is not blank, so
 * sending or clearing it ends that at once; here leaving the input ends it
 * too. A card that comes meanwhile waits, quiet, until it ends (cards.tsx).
 */
export const TYPING_MS = 1500;
let typingNow = false;
export const ownerTyping = () => typingNow;
function setTyping(v: boolean): void {
  if (v === typingNow) return;
  typingNow = v;
  window.dispatchEvent(new Event("embarch-typing"));
}

export function Composer(p: Props) {
  const { sid, busy, mode, model, slashCommands, placeholder, mentions, library, chips, onChip } = p;
  const [text, setTextState] = useState(() => (vscodeApi.getState() as Saved | undefined)?.drafts?.[sid] ?? "");
  const [pop, setPop] = useState<Pop | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [cards, setCards] = useState<{ judged: string; list: Card[] }>({ judged: "", list: [] });
  const [used, setUsed] = useState<string[]>([]);
  const [menu, setMenu] = useState<null | "bulb" | "library">(null);
  const [preview, setPreview] = useState<Card | null>(null);
  const [holding, setHolding] = useState(false);
  /** Side-question mode (57): Enter asks aside. */
  const [asideMode, setAsideMode] = useState(false);
  const aside = asideMode && p.canAsk;
  const asideNow = useRef(aside);
  asideNow.current = aside;
  const [images, setImages] = useState<Image[]>([]);
  /** Terminals picked from the @ list (58). */
  const [terminals, setTerminals] = useState<string[]>([]);
  const terminalsNow = useRef(terminals);
  terminalsNow.current = terminals;
  /** The editor chip whose × was clicked: kept out until the file or selection changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismissedNow = useRef(dismissed);
  dismissedNow.current = dismissed;
  // For a send the cards' answer makes, from a listener set up once.
  const imagesNow = useRef(images);
  imagesNow.current = images;
  /** One line about the last paste or send: what was stripped, a clipboard that held no usable image. */
  const [notice, setNotice] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const bulbBtn = useRef<HTMLButtonElement>(null);
  const libBtn = useRef<HTMLButtonElement>(null);
  const mentionTimer = useRef<number>(0);
  const typingTimer = useRef<number>(0);
  const textRef = useRef(text);
  const props = useRef(p);
  props.current = p;
  const a = useRef({
    seq: 0,
    ghostReq: null as null | { seq: number; text: string },
    cardsReq: null as null | { seq: number; text: string },
    inflight: false,
    ghostTimer: 0,
    cardsTimer: 0,
    holdTimer: 0,
    hold: null as null | string,
    handoff: false,
    undo: [] as Undo[],
    /** Long pastes of this draft, newest last (56). */
    pastes: [] as string[],
  });

  const setText = (v: string) => {
    textRef.current = v;
    setTextState(v);
  };
  /**
   * Empties the draft, the DOM too: keys typed and Enter in one frame leave
   * the state where it was last rendered, and Preact then skips the render
   * that would have cleared the input.
   */
  const clearText = () => {
    setText("");
    if (ta.current) ta.current.value = "";
  };

  /** The owner changed the draft: typing for TYPING_MS more, or no longer once it is blank (55). */
  const typed = (v: string) => {
    clearTimeout(typingTimer.current);
    if (!v.trim()) return setTyping(false);
    setTyping(true);
    typingTimer.current = window.setTimeout(() => setTyping(false), TYPING_MS);
  };
  const doneTyping = () => {
    clearTimeout(typingTimer.current);
    setTyping(false);
  };

  useEffect(() => {
    saveDraft(sid, text);
    const el = ta.current;
    if (el) {
      el.style.height = "auto";
      const want = Math.max(el.scrollHeight, overlay.current?.scrollHeight ?? 0);
      el.style.height = `${Math.min(want + 2, window.innerHeight * 0.4)}px`;
    }
  });

  useEffect(() => {
    if (mentions && pop?.kind === "at" && mentions.q === pop.q) setPop({ ...pop, items: mentions.items, on: 0 });
  }, [mentions]);

  // Text given back to this chat's draft goes first, the owner's newer draft after it.
  useEffect(() => {
    const take = () => {
      const back = returned[sid];
      if (!back) return;
      delete returned[sid];
      const cur = textRef.current;
      setText(cur.trim() ? `${back}\n\n${cur}` : back);
    };
    const on = (e: Event) => (e as CustomEvent<string>).detail === sid && take();
    take();
    window.addEventListener("embarch-draft", on);
    return () => window.removeEventListener("embarch-draft", on);
  }, [sid]);

  useEffect(
    () => () => {
      const s = a.current;
      clearTimeout(s.ghostTimer);
      clearTimeout(s.cardsTimer);
      clearTimeout(s.holdTimer);
      doneTyping();
    },
    [],
  );

  // ------------------------------------------------------------ the assistant's answers

  useEffect(() => {
    const on = (ev: MessageEvent<HostToChat>) => {
      const m = ev.data;
      const s = a.current;
      if (m.t === "focus") {
        ta.current?.focus();
        return;
      }
      if (m.t === "insert") {
        // At the caret — at the end when the input was never in use — spaced from the word before.
        const el = ta.current;
        if (!el) return;
        const cur = textRef.current;
        const [at, end] = el.selectionStart === 0 && el.selectionEnd === 0 ? [cur.length, cur.length] : [el.selectionStart, el.selectionEnd];
        const before = cur.slice(0, at);
        const pad = before && !/\s$/.test(before) ? " " : "";
        const next = before + pad + m.text + cur.slice(end);
        setText(next);
        focusAt(at + pad.length + m.text.length);
        return;
      }
      if (m.t === "ghost") {
        if (!s.ghostReq || m.seq !== s.ghostReq.seq) return;
        if (m.done) s.inflight = false;
        if (m.text) setGhost({ base: s.ghostReq.text, completion: m.text, src: "haiku" });
      } else if (m.t === "cards") {
        if (!s.cardsReq || m.seq !== s.cardsReq.seq) return;
        s.inflight = false;
        const judged = s.cardsReq.text;
        setCards({ judged, list: m.cards });
        if (s.hold !== null && s.hold === judged) {
          clearTimeout(s.holdTimer);
          if (m.cards.some((c) => applyEdit(judged, c.edit) !== null)) {
            // Something to look at before it goes: the 💡 opens, the next Enter sends as it is.
            s.hold = null;
            setHolding(false);
            setMenu("bulb");
          } else doSend(judged);
        }
      }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);

  const cancelStale = () => {
    const s = a.current;
    if (s.inflight) {
      post({ t: "assistCancel" });
      s.inflight = false;
    }
  };

  const askGhost = (v: string) => {
    const s = a.current;
    s.ghostReq = { seq: ++s.seq, text: v };
    s.inflight = true;
    post({ t: "assist", kind: "ghost", text: v, seq: s.ghostReq.seq });
  };

  const askCards = (v: string) => {
    const s = a.current;
    s.cardsReq = { seq: ++s.seq, text: v };
    s.inflight = true;
    post({ t: "assist", kind: "cards", text: v, seq: s.cardsReq.seq });
  };

  /** The draft moved: the instant wave now, Haiku's after their pauses (26). */
  const changed = (v: string, end: boolean, prev: Ghost | null) => {
    const s = a.current;
    // A side question is not a draft for the conversation: the assistant leaves it be.
    const on = props.current.assistant && !asideNow.current;
    clearTimeout(s.ghostTimer);
    clearTimeout(s.cardsTimer);
    const command = /^\/\S*\s*$/.test(v);
    const cardsLater = () => {
      if (on && words(v) >= 3 && !command) s.cardsTimer = window.setTimeout(() => askCards(v), CARDS_MS);
    };
    // Typing through the ghost text already shown keeps it, and its call.
    if (prev && end && ghostRest(v, prev.base, prev.completion)) {
      cardsLater();
      return;
    }
    cancelStale();
    const local = end ? prefixMatch(props.current.prompts, v) : null;
    setGhost(local ? { base: v, completion: local, src: "local" } : null);
    if (on && end && !local && v.trim().length >= 2 && !command && !v.endsWith("\n")) s.ghostTimer = window.setTimeout(() => askGhost(v), GHOST_MS);
    cardsLater();
  };

  // ------------------------------------------------------------ the popup: @ and /

  const slashItems = (q: string): MentionItem[] => {
    const out: MentionItem[] = [];
    const seen = new Set<string>();
    for (const e of library) {
      const inv = invocation(e, slashCommands);
      if (!inv || !(inv.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))) continue;
      seen.add(inv);
      out.push({ insert: inv, label: `/${inv}`, detail: e.category });
    }
    for (const c of slashCommands) {
      if (seen.has(c) || c === "btw" || !c.toLowerCase().includes(q)) continue;
      out.push({ insert: c, label: `/${c}` });
    }
    if ("btw".includes(q)) out.push({ insert: "btw", label: "/btw", detail: "a side question, not part of the conversation" });
    const starts = (it: MentionItem) => Number(!it.insert.toLowerCase().startsWith(q) && !it.insert.toLowerCase().includes(`:${q}`));
    return out.sort((x, y) => starts(x) - starts(y)).slice(0, 30);
  };

  const detect = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const q = at[2];
      const start = caret - q.length - 1;
      setPop((x) => ({ kind: "at", start, q, items: x?.kind === "at" ? x.items : [], on: 0 }));
      clearTimeout(mentionTimer.current);
      mentionTimer.current = window.setTimeout(() => post({ t: "mention", q }), 120);
      return;
    }
    const sl = /^\/(\S*)$/.exec(before);
    if (sl && (slashCommands.length || library.length)) {
      const items = slashItems(sl[1].toLowerCase());
      setPop(items.length ? { kind: "slash", start: 0, q: sl[1], items, on: 0 } : null);
      return;
    }
    setPop(null);
  };

  const focusAt = (pos: number) =>
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setAtEnd(pos === el.value.length);
    });

  const choose = (it: MentionItem) => {
    if (!pop) return;
    const el = ta.current!;
    const caret = el.selectionStart;
    if (it.terminal) {
      // Not text: a chip, its output read when the message goes (58).
      const name = it.terminal;
      setTerminals((cur) => (cur.includes(name) ? cur : [...cur, name]));
      const next = text.slice(0, pop.start) + text.slice(caret);
      setText(next);
      typed(next);
      setPop(null);
      setGhost(null);
      focusAt(pop.start);
      return;
    }
    const ins = pop.kind === "at" ? `@${it.insert} ` : `/${it.insert} `;
    const next = text.slice(0, pop.start) + ins + text.slice(caret);
    setText(next);
    typed(next);
    setPop(null);
    setGhost(null);
    focusAt(pop.start + ins.length);
  };

  // ------------------------------------------------------------ edits: cards, ghost, library

  const live = useMemo(() => cards.list.filter((c) => !used.includes(c.id) && applyEdit(text, c.edit) !== null), [cards, used, text]);

  const edit = (after: string, undo: Omit<Undo, "before" | "after"> = {}) => {
    const s = a.current;
    clearTimeout(s.ghostTimer);
    clearTimeout(s.cardsTimer);
    cancelStale();
    s.undo.push({ before: textRef.current, after, ...undo });
    setText(after);
    typed(after);
    setGhost(null);
    setPreview(null);
    focusAt(after.length);
  };

  const applyCard = (c: Card) => {
    const after = applyEdit(textRef.current, c.edit);
    if (after === null) return;
    if (c.kind === "handoff") a.current.handoff = true;
    setUsed((u) => [...u, c.id]);
    // The owner has seen the cards: sending this does not wait for them again.
    setCards((x) => ({ ...x, judged: after }));
    setMenu(null);
    edit(after, { cardId: c.id, handoff: c.kind === "handoff" });
  };

  const acceptGhost = (rest: string) => {
    const after = textRef.current + rest;
    edit(after);
    changed(after, true, null);
  };

  const pickEntry = (e: LibraryEntry) => {
    const inv = invocation(e, slashCommands) ?? e.name;
    const cur = textRef.current;
    const m = /^\/\S+[ \t]*/.exec(cur);
    const rest = (m ? cur.slice(m[0].length) : cur).replace(/^\s+/, "");
    const head = `/${inv} `;
    setMenu(null);
    a.current.undo.push({ before: cur, after: head + rest });
    setText(head + rest);
    typed(head + rest);
    setGhost(null);
    focusAt(head.length);
  };

  const undo = (e: KeyboardEvent): boolean => {
    const s = a.current;
    const top = s.undo[s.undo.length - 1];
    if (!top || textRef.current !== top.after) return false;
    e.preventDefault();
    s.undo.pop();
    if (top.handoff) s.handoff = false;
    if (top.cardId) setUsed((u) => u.filter((x) => x !== top.cardId));
    setText(top.before);
    typed(top.before);
    setGhost(null);
    focusAt(top.before.length);
    return true;
  };

  // ------------------------------------------------------------ sending

  const doSend = (t: string) => {
    const s = a.current;
    clearTimeout(s.ghostTimer);
    clearTimeout(s.cardsTimer);
    clearTimeout(s.holdTimer);
    cancelStale();
    s.hold = null;
    setHolding(false);
    const opts: SendOpts = s.handoff ? { handoff: true } : {};
    if (imagesNow.current.length) opts.images = imagesNow.current.map(({ mediaType, data }) => ({ mediaType, data }));
    const marked = pastesIn(t, s.pastes);
    if (marked.length) opts.pastes = marked;
    // A slash command goes as it is: the CLI reads it from the text. Its
    // terminal chips wait for the next message.
    const slash = t.startsWith("/");
    if (terminalsNow.current.length && !slash) {
      opts.terminals = terminalsNow.current;
      setTerminals([]);
    }
    const ed = props.current.editor;
    if (ed && !slash) {
      const key = editorKey(ed);
      if (key !== dismissedNow.current && editorSent[sid] !== key) {
        const { label: _label, ...item } = ed;
        opts.editor = item;
        editorSent[sid] = key;
      }
    }
    props.current.onSend(t, opts);
    s.handoff = false;
    s.undo = [];
    s.pastes = [];
    setImages([]);
    setNotice(null);
    clearText();
    doneTyping();
    setPop(null);
    setGhost(null);
    setPreview(null);
    setMenu(null);
    setCards({ judged: "", list: [] });
    setUsed([]);
  };

  /** `/btw <question>` (57): asked beside the chat; the draft clears, images and pastes stay for the next message. */
  const askAside = (q: string) => {
    if (!q) return setNotice("/btw takes a question: /btw which port did it pick?");
    if (!props.current.canAsk) return setNotice("A side question needs a conversation this window runs: send it a message first.");
    post({ t: "btw", question: q });
    a.current.undo = [];
    clearText();
    doneTyping();
    setPop(null);
    setGhost(null);
    setNotice(null);
  };

  const send = () => {
    // The DOM, not the last render: keys typed and Enter in one frame would
    // otherwise send the text from before them.
    const t = (ta.current?.value ?? text).trim();
    if (!t && (aside || (!images.length && !terminals.length))) return;
    // What shows nothing comes out first, and the owner looks again (Claude Code's rule).
    const clean = stripInvisible(t);
    if (clean.removed) {
      setText(clean.text);
      setNotice(strippedNotice(clean.removed, "review"));
      focusAt(clean.text.length);
      return;
    }
    const btw = /^\/btw(?:\s+([\s\S]*))?$/i.exec(t);
    if (btw) return askAside((btw[1] ?? "").trim());
    if (aside) return askAside(t);
    const s = a.current;
    if (s.hold !== null || !t) return doSend(t);
    // Just before send, the cards judge the whole prompt (26) — unless they already have.
    if (props.current.assistant && words(t) >= HOLD_MIN_WORDS && !t.startsWith("/") && cards.judged.trim() !== t) {
      s.hold = t;
      setHolding(true);
      clearTimeout(s.cardsTimer);
      if (!(s.inflight && s.cardsReq?.text.trim() === t)) {
        cancelStale();
        askCards(t);
      }
      s.holdTimer = window.setTimeout(() => s.hold !== null && doSend(s.hold), HOLD_MS);
      return;
    }
    doSend(t);
  };

  // ------------------------------------------------------------ pasting

  const addImages = async (files: File[]) => {
    const read = await Promise.all(files.map((f) => readImage(f).catch(() => null)));
    const ok = read.filter((x): x is Attachment => x !== null).map((x) => ({ ...x, id: ++imageIds }));
    if (ok.length) setImages((cur) => [...cur, ...ok]);
  };

  /** Text in at the caret as if typed, so undo and the input handler see it. */
  const insertText = (t: string) => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    if (document.execCommand("insertText", false, t)) return;
    el.setRangeText(t, el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const onPaste = (e: ClipboardEvent) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files: File[] = [];
    let sawImage = false;
    for (const it of Array.from(dt.items)) {
      if (!it.type.startsWith("image/")) continue;
      sawImage = true;
      const f = it.getAsFile();
      if (f && IMAGE_TYPES.includes(f.type)) files.push(f);
    }
    if (files.length) {
      e.preventDefault();
      void addImages(files);
      return;
    }
    const plain = dt.getData("text/plain");
    // WSL2/WSLg's clipboard bridge can hand a screenshot over as raw bytes in
    // text/plain: never into the draft (Claude Code's fix, its changelog 2.1.2xx).
    if ((sawImage && !plain) || (plain && looksBinary(plain))) {
      e.preventDefault();
      setNotice("The clipboard held an image that did not come through as one: nothing pasted");
      return;
    }
    if (!plain) return;
    const norm = plain.replace(/\r\n?/g, "\n");
    const clean = norm.length > 50000 ? { text: norm, removed: 0 } : stripInvisible(norm);
    const mark = pasteToMark(clean.text);
    if (mark) a.current.pastes = rememberPaste(a.current.pastes, mark);
    if (clean.removed) {
      e.preventDefault();
      insertText(clean.text);
      setNotice(strippedNotice(clean.removed, "pasted"));
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (pop && pop.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = pop.items.length;
        setPop({ ...pop, on: (pop.on + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(pop.items[pop.on]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPop(null);
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && undo(e)) return;
    if (e.key === "Tab" && !e.shiftKey && shown) {
      e.preventDefault();
      acceptGhost(shown);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape") {
      if (menu) setMenu(null);
      // Leaving the mode never stops Claude: that is the next Esc.
      else if (aside) setAsideMode(false);
      else if (shown) setGhost(null);
      else if (busy) post({ t: "interrupt" });
    }
  };

  /** The 💬: into side-question mode and out, the draft kept, the input focused. */
  const toggleAside = () => {
    const on = !aside;
    setAsideMode(on);
    if (on) {
      // Haiku's waves are for messages to the conversation.
      clearTimeout(a.current.ghostTimer);
      clearTimeout(a.current.cardsTimer);
      cancelStale();
      setGhost(null);
    }
    ta.current?.focus();
  };

  const shown = ghost && atEnd && !pop && !preview ? ghostRest(text, ghost.base, ghost.completion) : null;
  const edKey = useMemo(() => (p.editor ? editorKey(p.editor) : null), [p.editor]);
  const edChip = p.editor && edKey !== dismissed ? p.editor : null;
  const edSent = edKey !== null && editorSent[sid] === edKey;
  const after = preview ? applyEdit(text, preview.edit) : null;

  const bulbGroups: Array<MenuGroup<Card>> = CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    items: live.filter((x) => x.category === c.id).map((x) => ({ key: x.id, label: x.title, detail: x.why, value: x })),
  })).filter((g) => g.items.length);

  const libGroups: Array<MenuGroup<LibraryEntry>> = byCategory(library).map((g) => ({
    id: g.category,
    label: g.category,
    items: g.entries.map((e) => {
      const inv = invocation(e, slashCommands);
      return {
        key: `${e.source}:${e.name}`,
        label: `/${e.name}`,
        detail: e.description,
        title: inv ? `${e.description ?? ""}\n\n/${inv}` : "This session does not know it: install the embarch-chat plugin in Claude Code.",
        disabled: !inv,
        value: e,
      };
    }),
  }));

  return (
    <div
      class="composer"
      onFocusOut={(e) => {
        // Leaving the input, not moving within it (the 💡, a chip), ends the typing (55).
        const to = e.relatedTarget;
        if (!(to instanceof Node && (e.currentTarget as HTMLElement).contains(to))) doneTyping();
      }}
    >
      {chips.length > 0 && !busy && (
        <div class="chips">
          {chips.map((c) => (
            <button key={`${c.source}:${c.text}`} class={`chip ${c.source}`} title={c.action === "freshChat" ? "A new chat on this work item that starts with the handoff; this one stays readable" : c.source === "cli" ? "Claude Code's own guess — sends it" : "Sends it"} onClick={() => onChip(c)}>
              {c.text}
            </button>
          ))}
        </div>
      )}
      {pop && pop.items.length > 0 && (
        <div class="popup">
          {pop.items.map((it, i) => (
            <div key={`${it.terminal ? "t:" : ""}${it.insert}`} class={i === pop.on ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), choose(it))}>
              {it.label}
              {it.detail && <span class="detail">{it.detail}</span>}
            </div>
          ))}
        </div>
      )}
      {menu === "bulb" && bulbGroups.length > 0 && <CategoryMenu kind="bulb" groups={bulbGroups} anchor={bulbBtn.current} onPick={applyCard} onHover={setPreview} onClose={() => (setMenu(null), setPreview(null))} />}
      {menu === "library" && libGroups.length > 0 && <CategoryMenu kind="library" groups={libGroups} anchor={libBtn.current} onPick={pickEntry} onClose={() => setMenu(null)} />}
      {aside && (
        <div class="aside-tag" title="Enter asks Claude aside: the answer shows above, and neither joins the conversation. Esc or 💬 leaves, the draft kept.">
          💬 Side question <span class="muted">· answered beside the chat · Esc leaves</span>
        </div>
      )}
      <div class="field">
        <div class="overlay" ref={overlay} aria-hidden="true">
          {after !== null ? (
            wordDiff(text, after).map((d, i) => (
              <span key={i} class={d.t}>
                {d.s}
              </span>
            ))
          ) : (
            <>
              <span class="mirror">{text}</span>
              {shown && <span class="ghost">{shown}</span>}
            </>
          )}
          {"​"}
        </div>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          class={`${after !== null ? "previewing" : ""} ${aside ? "aside" : ""}`}
          placeholder={aside ? "Ask aside — Claude keeps working" : placeholder}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            const v = el.value;
            const end = el.selectionStart === v.length && el.selectionEnd === v.length;
            const s = a.current;
            if (s.hold !== null) {
              // Writing again: the held send is off.
              clearTimeout(s.holdTimer);
              s.hold = null;
              setHolding(false);
            }
            setText(v);
            typed(v);
            setAtEnd(end);
            setPreview(null);
            setNotice(null);
            if (!v.trim()) a.current.handoff = false;
            detect(v, el.selectionStart);
            changed(v, end, ghost);
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
          onKeyUp={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            setAtEnd(el.selectionStart === el.value.length);
          }}
          onClick={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            setAtEnd(el.selectionStart === el.value.length);
          }}
          onScroll={(e) => {
            if (overlay.current) overlay.current.scrollTop = (e.currentTarget as HTMLTextAreaElement).scrollTop;
          }}
          onBlur={() => setTimeout(() => setPop(null), 150)}
        />
      </div>
      {notice && <div class="paste-notice muted">{notice}</div>}
      {(images.length > 0 || edChip || terminals.length > 0) && (
        <div class="attachments">
          {terminals.map((name) => (
            <span key={`t:${name}`} class="ctx-chip" title="Its last 100 lines go with the message, read when it goes">
              <span class="ctx-kind">Terminal</span>
              <span class="ctx-label">{name}</span>
              <button class="icon remove" title="Don't send it" onClick={() => setTerminals((cur) => cur.filter((x) => x !== name))}>
                ×
              </button>
            </span>
          ))}
          {edChip && (
            <span
              class={`ctx-chip ${edSent ? "sent" : ""}`}
              title={edSent ? `${edChip.path}\nSent with an earlier message: not sent again until it changes` : `${edChip.path}\nGoes with the message — × keeps it out (embarchChat.attachOpenFile, attachSelection)`}
            >
              <span class="ctx-kind">{edChip.kind === "selection" ? "Selection" : "File"}</span>
              <span class="ctx-label">{edChip.label}</span>
              <button class="icon remove" title="Don't send it" onClick={() => setDismissed(edKey)}>
                ×
              </button>
            </span>
          )}
          {images.map((im) => (
            <span key={im.id} class="thumb" title={`${im.mediaType} — goes with the message`}>
              <img src={`data:${im.mediaType};base64,${im.data}`} alt="pasted image" />
              <button class="icon remove" title="Remove" onClick={() => setImages((cur) => cur.filter((x) => x.id !== im.id))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="bar">
        <select title="Permission mode" value={mode} onChange={(e) => post({ t: "mode", mode: (e.target as HTMLSelectElement).value })}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {!MODES.some((m) => m.id === mode) && <option value={mode}>{mode}</option>}
        </select>
        <select title="Model" value={MODELS.some((m) => m.id === model) ? (model as string) : "default"} onChange={(e) => post({ t: "model", model: (e.target as HTMLSelectElement).value })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id === "default" && model && !MODELS.some((x) => x.id === model) ? model : m.label}
            </option>
          ))}
        </select>
        <span class="assist-slot">
          <button
            ref={bulbBtn}
            class={`icon bulb ${live.length ? "lit" : ""} ${holding ? "checking" : ""}`}
            title={holding ? "Checking the draft before it goes — Enter sends now" : live.length ? `${live.length} suggestion${live.length > 1 ? "s" : ""} for this draft` : p.assistant ? "Suggestions for the draft show here after a pause" : "The assistant is off (embarchChat.assistant)"}
            disabled={!live.length}
            onClick={() => setMenu(menu === "bulb" ? null : "bulb")}
          >
            💡{live.length > 0 && <span class="count">{live.length}</span>}
            {holding && <span class="spinner" />}
          </button>
          <button ref={libBtn} class="icon library" title="Library" disabled={!library.length} onClick={() => setMenu(menu === "library" ? null : "library")}>
            📚
          </button>
          <button
            class={`icon btw ${aside ? "on" : ""}`}
            title={p.canAsk ? (aside ? "Side question mode: Enter asks aside — click or Esc to leave" : "Side question (/btw) — answered beside the chat, not added to it") : "Side questions need a conversation this window runs: send it a message first"}
            aria-pressed={aside}
            disabled={!p.canAsk}
            onClick={toggleAside}
          >
            💬
          </button>
        </span>
        <span class="spacer" />
        {busy && (
          <button title="Stop this turn (Esc); background tasks go on" onClick={() => post({ t: "interrupt" })}>
            Stop
          </button>
        )}
        <button
          class="primary"
          disabled={!text.trim() && (aside || (!images.length && !terminals.length))}
          onClick={send}
          title={aside ? "Ask aside (Enter): not added to the conversation" : p.waiting ? "Queued: Claude takes it after your answer to the card above" : busy ? "Queued: it waits above the input until Claude reads it, at its next step" : "Send (Enter)"}
        >
          {aside ? "Ask" : busy ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
