// The Haiku assistant at the input (decisions/assistant.md in embarch-doc/embarch-chat):
// ghost text after a 300 ms pause, cards on a 2 s pause or just before send,
// reply chips after each turn, and a name for each chat after its first
// (decision 12). It runs only for the chat on screen (34): a background
// chat's chips wait until it is opened, one call then; naming still runs
// once per chat. The next keystroke cancels a stale call (26).

import { EventEmitter } from "events";
import type { ChatState } from "../wire/reducer";
import { Card, Chip, extractHandoff } from "./edits";
import { HaikuResult, dropNeutralDir, runHaiku } from "./haiku";
import { AssistInput, SYSTEM, cardsPrompt, cleanCompletion, ghostPrompt, parseCards, parseObject, parseTurn, partialCompletion, turnPrompt } from "./prompts";

export interface AssistantSettings {
  claudePath: string;
  /** Off: no Haiku calls at all; the CLI's own guess and the handoff chip still show. */
  enabled: boolean;
  log: (line: string) => void;
  /** For tests: the env each call runs with. */
  env?: NodeJS.ProcessEnv;
}

/** `name`: a turn call that also names the chat — the owner's next message or keystroke does not cancel it. */
type Kind = "ghost" | "cards" | "turn" | "name";

interface PerChat {
  cli: string | null;
  haiku: string[];
  /** The last message asked for a handoff (36); the turn that answers it writes one. */
  handoffAsked: boolean;
  handoff: string | null;
  due: boolean;
  named: boolean;
  /** A name was asked for and has not come back yet. */
  nameDue: boolean;
  /** Bumped by every message the owner sends: chips asked before it are spent. */
  epoch: number;
}

/** Claude's last reply: the top-level text after the owner's last message. */
export function lastReply(s: ChatState): string {
  let i = s.timeline.length - 1;
  while (i >= 0 && s.entries[s.timeline[i]]?.kind !== "user") i--;
  return s.timeline
    .slice(i + 1)
    .map((id) => s.entries[id])
    .filter((e) => e && e.kind === "text")
    .map((e) => (e as { text: string }).text)
    .join("\n\n");
}

/** Events: `chips` (sid, Chip[]). */
export class HaikuAssistant extends EventEmitter {
  private calls = new Map<string, AbortController>();
  private chats = new Map<string, PerChat>();
  private seq = 0;

  constructor(private settings: () => AssistantSettings) {
    super();
  }

  private chat(sid: string): PerChat {
    let c = this.chats.get(sid);
    if (!c) {
      c = { cli: null, haiku: [], handoffAsked: false, handoff: null, due: false, named: false, nameDue: false, epoch: 0 };
      this.chats.set(sid, c);
    }
    return c;
  }

  private async call(sid: string, kind: Kind, prompt: string, onText?: (t: string) => void): Promise<HaikuResult | null> {
    const s = this.settings();
    if (!s.enabled) return null;
    const key = `${sid}:${kind}`;
    this.calls.get(key)?.abort();
    const ac = new AbortController();
    this.calls.set(key, ac);
    const n = ++this.seq;
    const r = await runHaiku({ claudePath: s.claudePath, system: SYSTEM, prompt, onText, signal: ac.signal, env: s.env });
    if (this.calls.get(key) === ac) this.calls.delete(key);
    const tag = `[${sid.slice(0, 8)}] haiku ${kind} #${n}`;
    if (r.aborted) s.log(`${tag}: cancelled after ${r.ms} ms`);
    else s.log(`${tag}: ${r.error ? `failed (${r.error})` : "ok"}, first token ${r.firstTokenMs ?? "-"} ms, ${r.ms} ms${r.costUsd !== null ? `, $${r.costUsd.toFixed(4)}` : ""}`);
    return r.aborted || r.error ? null : r;
  }

  /** Cancels the chat's ghost and card calls (the next keystroke, decision 26). */
  cancel(sid: string, kinds: Kind[] = ["ghost", "cards"]): void {
    for (const k of kinds) {
      const key = `${sid}:${k}`;
      this.calls.get(key)?.abort();
      this.calls.delete(key);
    }
  }

  /** The second wave (24, 26): a completion of the draft, streamed through `onPartial`. */
  async ghost(sid: string, input: AssistInput, onPartial: (text: string) => void): Promise<string | null> {
    let last = "";
    const r = await this.call(sid, "ghost", ghostPrompt(input), (t) => {
      const p = partialCompletion(t);
      if (p === null) return;
      const c = cleanCompletion(input.draft, p);
      if (c !== last) {
        last = c;
        onPartial(c);
      }
    });
    if (!r) return null;
    const o = parseObject(r.text);
    return typeof o?.completion === "string" ? cleanCompletion(input.draft, o.completion) : null;
  }

  /** The third wave (26, 28, 36): cards that edit the draft (37). */
  async cards(sid: string, input: AssistInput): Promise<Card[] | null> {
    const r = await this.call(sid, "cards", cardsPrompt(input));
    if (!r) return null;
    return parseCards(parseObject(r.text), input.draft, `c${this.seq}`);
  }

  // ------------------------------------------------------------ chips

  /** The chips to show: the handoff's fresh chat first, then the CLI's own guess among Haiku's (25, 36). */
  chipsFor(sid: string): Chip[] {
    const c = this.chats.get(sid);
    if (!c) return [];
    const out: Chip[] = [];
    if (c.handoff) out.push({ text: "Fresh chat with this handoff", source: "handoff", action: "freshChat" });
    const seen = new Set<string>();
    const add = (text: string, source: Chip["source"]) => {
      const k = text.trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ text: text.trim(), source });
    };
    if (c.cli) add(c.cli, "cli");
    for (const h of c.haiku) add(h, "haiku");
    return out.slice(0, c.handoff ? 5 : 4);
  }

  handoffFor(sid: string): string | null {
    return this.chats.get(sid)?.handoff ?? null;
  }

  /** The fresh chat took the handoff: its chip goes; the other chips stay. */
  handoffTaken(sid: string): void {
    const c = this.chats.get(sid);
    if (!c?.handoff) return;
    c.handoff = null;
    this.emitChips(sid);
  }

  private emitChips(sid: string): void {
    this.emit("chips", sid, this.chipsFor(sid));
  }

  /** The owner sent a message: the chips are spent; a handoff request is remembered for the turn it starts. */
  sent(sid: string, opts: { handoff?: boolean } = {}): void {
    const c = this.chat(sid);
    this.cancel(sid, ["ghost", "cards", "turn"]);
    c.cli = null;
    c.haiku = [];
    c.handoff = null;
    c.due = false;
    c.epoch++;
    c.handoffAsked = !!opts.handoff;
    this.emitChips(sid);
  }

  /** The CLI's own guess at the next prompt (`prompt_suggestion`), which comes just after the turn ends. */
  suggestion(sid: string, text: string): void {
    const c = this.chat(sid);
    c.cli = text.trim() || null;
    this.emitChips(sid);
  }

  /**
   * A turn ended. On screen: chips (25), and a name after the first turn
   * (12). Off screen: the name only; the chips wait until it is opened (34).
   */
  async turnEnded(sid: string, input: () => AssistInput, opts: { onScreen: boolean; firstTurn: boolean; rename: (name: string) => Promise<void> }): Promise<void> {
    const c = this.chat(sid);
    // A first-turn name that never came: asked again now.
    if (c.named === false && c.nameDue) opts = { ...opts, firstTurn: true };
    if (c.handoffAsked) {
      c.handoffAsked = false;
      const h = extractHandoff(input().lastReply);
      c.handoff = h || null;
    }
    const want = { chips: opts.onScreen, name: opts.firstTurn && !c.named };
    if (!opts.onScreen) c.due = true;
    this.emitChips(sid);
    if (!want.chips && !want.name) return;
    if (want.name) {
      c.named = true;
      c.nameDue = true;
    }
    await this.runTurn(sid, input(), want, opts.rename);
  }

  /** The chat came on screen: its chips, if a turn ended while it was off (34). */
  async shown(sid: string, input: () => AssistInput): Promise<void> {
    const c = this.chats.get(sid);
    if (!c?.due) return;
    c.due = false;
    await this.runTurn(sid, input(), { chips: true, name: false });
  }

  /**
   * One call for the chips and, after the first turn, the name (decision
   * 12). A call that names is its own kind: the reply the owner sends a
   * moment later (a click on the CLI's own chip) spends its chips but not
   * the name; a name that did not come back is asked again after the next
   * turn.
   */
  private async runTurn(sid: string, input: AssistInput, want: { chips: boolean; name: boolean }, rename?: (name: string) => Promise<void>): Promise<void> {
    const c = this.chat(sid);
    const epoch = c.epoch;
    const r = await this.call(sid, want.name ? "name" : "turn", turnPrompt(input, want));
    const { chips, name } = r ? parseTurn(parseObject(r.text)) : { chips: [], name: null };
    if (want.name) {
      if (name && rename) {
        await rename(name);
        c.nameDue = false;
      } else c.named = false;
    }
    if (r && want.chips && c.epoch === epoch) {
      c.haiku = chips;
      this.emitChips(sid);
    }
  }

  forget(sid: string): void {
    this.cancel(sid, ["ghost", "cards", "turn", "name"]);
    this.chats.delete(sid);
  }

  dispose(): void {
    for (const ac of this.calls.values()) ac.abort();
    this.calls.clear();
    this.removeAllListeners();
    dropNeutralDir();
  }
}
