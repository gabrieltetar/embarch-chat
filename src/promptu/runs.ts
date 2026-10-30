// Promptu's pass in the chat (decision 96): one run per chat at a time, from
// the rough prompt to the improved one, held here on the Node side so a page
// that is hidden, reloaded or not open yet (a Start work chat) shows the same
// dialog. `prep` plans the pages; each page the owner answers goes through
// `next`, which plans the rest; when nothing is left, `render` writes the
// prompt. "Accept all recommendations" renders with `--rest recommended`,
// Esc with `--rest assume` (what is left becomes stated assumptions). The
// prompt goes to the draft and is never sent; a failure is one line and the
// draft stays as it was (or, for Start work, gets the desk's old starter).
//
// Events: `view` (sid, PromptuView | null) whenever the dialog changes, and
// `result` (sid) when a run ended — its result waits in `take` for the page
// that shows the chat, once.

import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AnswerInput, PrepOut, PromptuCli, Rest } from "./cli";

/** What started a run: Enter at a task start, a desk Start work chat, the 💡's handoff card (97). */
export type Origin = "enter" | "start" | "handoff";

/** The dialog as the page draws it. */
export interface PromptuView {
  sid: string;
  seq: number;
  origin: Origin;
  rough: string;
  /** `working`: a command runs; `ask`: a page waits on the owner. */
  phase: "working" | "ask";
  doing?: "prep" | "next" | "render";
  /** The latest `prep` or `next` output while asking. */
  step?: PrepOut;
  /** Quick mode (95): no dialog, every recommendation taken. */
  quick: boolean;
}

/** How a run ended. */
export interface PromptuResult {
  sid: string;
  seq: number;
  origin: Origin;
  rough: string;
  /** The improved prompt, for the draft. */
  prompt?: string;
  /** One line: why there is none. */
  error?: string;
  /** The owner stopped it before a prompt came back (Esc while it read the prompt). */
  cancelled?: boolean;
  /** What the draft gets instead when there is no prompt (96). */
  fallback?: string;
  /** Start work's starter went to Claude instead, as decision 11 sent it (the owner's P2). */
  fallbackSent?: boolean;
  /** For the footer's pattern, shown in the notice. */
  pattern?: string | null;
}

/** The work item a Start work pass reads as its `desk` source (contract §7.8 `--desk`). */
export interface DeskItem {
  key?: string;
  title?: string;
  url?: string;
  id?: string;
  text: string;
}

export interface BeginOpts {
  rough: string;
  cwd: string;
  origin: Origin;
  /** The EmbArch parts present: `desk`, `embarch-api`. */
  have: string[];
  /** A pattern the owner forced on the card (95), or the handoff card's (97). */
  pattern?: string | null;
  quick: boolean;
  /** A desk Start work run: `--start` (embarch-promptu decision 32). */
  start?: boolean;
  /** The work item, or how to read it: read after the dialog shows, so the owner sees the pass begin at once. */
  desk?: DeskItem | null | (() => Promise<DeskItem | null>);
  /** Start work's old starter, for when the pass gives no prompt. */
  fallback?: string;
  /**
   * Sends the fallback instead of leaving it in the draft: a Start work pass
   * that fails or is skipped sends the desk's starter, as decision 11 did
   * (the owner's P2).
   */
  sendFallback?: (text: string) => void;
}

interface Active {
  view: PromptuView;
  ac: AbortController;
  cwd: string;
  fallback?: string;
  sendFallback?: (text: string) => void;
}

/** The brief the pass reads, cut as the terminal skill cuts it: about 2,000 characters (SYNTHESIS §2.3). */
export const DESK_TEXT_MAX = 2000;

/** One answer as the page sends it: a label, labels, or free text (contract §8.1). */
function cleanAnswer(v: unknown): string | string[] | { other: string } | { labels: string[]; other?: string } | null {
  const s = (x: unknown) => (typeof x === "string" ? x.slice(0, 4000) : null);
  if (typeof v === "string") return s(v);
  if (Array.isArray(v)) return v.map(s).filter((x): x is string => x !== null).slice(0, 8);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const other = s(o.other) ?? undefined;
    if (Array.isArray(o.labels)) return { labels: o.labels.map(s).filter((x): x is string => x !== null).slice(0, 8), ...(other ? { other } : {}) };
    if (other !== undefined) return { other };
  }
  return null;
}

/** What a page sent as answers, kept to the shapes `next` and `render` take. */
export function cleanInput(v: unknown): AnswerInput {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: AnswerInput = {};
  if (typeof o.pattern === "string" && o.pattern.trim()) out.pattern = o.pattern.slice(0, 200);
  if (o.answers && typeof o.answers === "object" && !Array.isArray(o.answers)) {
    const answers: NonNullable<AnswerInput["answers"]> = {};
    for (const [k, raw] of Object.entries(o.answers as Record<string, unknown>)) {
      if (!/^_?[a-z][a-z_]*$/.test(k)) continue;
      const a = cleanAnswer(raw);
      if (a !== null) answers[k] = a;
    }
    out.answers = answers;
  }
  return out;
}

export class PromptuRuns extends EventEmitter {
  private active = new Map<string, Active>();
  private results = new Map<string, PromptuResult>();
  private seq = 0;

  constructor(
    private cli: PromptuCli,
    private log: (s: string) => void,
  ) {
    super();
  }

  /** The dialog of a chat, or null. */
  view(sid: string): PromptuView | null {
    return this.active.get(sid)?.view ?? null;
  }

  /** Whether a run is under way for this chat. */
  busy(sid: string): boolean {
    return this.active.has(sid);
  }

  /** The result of a chat's last run, once: the page that shows the chat takes it. */
  take(sid: string): PromptuResult | null {
    const r = this.results.get(sid) ?? null;
    this.results.delete(sid);
    return r;
  }

  private show(sid: string, a: Active | null): void {
    this.emit("view", sid, a ? a.view : null);
  }

  private end(sid: string, a: Active, r: Omit<PromptuResult, "sid" | "seq" | "origin" | "rough">): void {
    if (this.active.get(sid) !== a) return;
    this.active.delete(sid);
    const result: PromptuResult = { sid, seq: a.view.seq, origin: a.view.origin, rough: a.view.rough, ...r };
    if (!result.prompt && a.fallback) {
      if (a.sendFallback) {
        try {
          a.sendFallback(a.fallback);
          result.fallbackSent = true;
        } catch (e) {
          this.log(`[${sid.slice(0, 8)}] promptu: the starter could not be sent (${(e as Error).message}); it waits in the draft`);
          result.fallback = a.fallback;
        }
      } else result.fallback = a.fallback;
    }
    this.log(`[${sid.slice(0, 8)}] promptu ${a.view.origin}: ${result.prompt ? "a prompt in the draft" : result.cancelled ? "cancelled" : `no prompt (${result.error})`}`);
    this.results.set(sid, result);
    this.show(sid, null);
    this.emit("result", sid);
  }

  private current(sid: string, seq: number): Active | null {
    const a = this.active.get(sid);
    return a && a.view.seq === seq ? a : null;
  }

  /** Writes the work item for `--desk` into a folder of its own (0700), removed when `prep` is done. */
  private deskFile(item: DeskItem): { file: string; dir: string } | null {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embarch-chat-promptu-"));
      const file = path.join(dir, "item.json");
      const text = item.text.length > DESK_TEXT_MAX ? item.text.slice(0, DESK_TEXT_MAX - 1) + "…" : item.text;
      fs.writeFileSync(file, JSON.stringify({ ...item, text }), { mode: 0o600 });
      return { file, dir };
    } catch (e) {
      this.log(`promptu: the work item could not be written for the pass: ${(e as Error).message}`);
      return null;
    }
  }

  /** Starts a run on a rough prompt; a run already under way for the chat is dropped first. */
  async begin(sid: string, o: BeginOpts): Promise<void> {
    const old = this.active.get(sid);
    if (old) {
      old.ac.abort();
      this.active.delete(sid);
    }
    const a: Active = {
      view: { sid, seq: ++this.seq, origin: o.origin, rough: o.rough, phase: "working", doing: "prep", quick: o.quick },
      ac: new AbortController(),
      cwd: o.cwd,
      fallback: o.fallback,
      sendFallback: o.sendFallback,
    };
    this.active.set(sid, a);
    this.show(sid, a);
    // Whatever throws on the way ends the run with one line: a dialog never stays "working" (review F2).
    try {
      const item = typeof o.desk === "function" ? await o.desk() : o.desk;
      if (this.active.get(sid) !== a) return;
      const desk = item ? this.deskFile(item) : null;
      let r: Awaited<ReturnType<PromptuCli["prep"]>>;
      try {
        r = await this.cli.prep(o.rough, { cwd: o.cwd, have: o.have, desk: desk?.file, pattern: o.pattern, quick: o.quick, start: o.start, signal: a.ac.signal });
      } finally {
        if (desk) fs.rmSync(desk.dir, { recursive: true, force: true });
      }
      if (this.active.get(sid) !== a) return;
      if (!r.ok || !r.value) return this.end(sid, a, r.error === "cancelled" ? { cancelled: true } : { error: r.error ?? "promptu prep failed" });
      await this.after(sid, a, r.value);
    } catch (e) {
      this.end(sid, a, { error: `Promptu stopped: ${(e as Error)?.message ?? String(e)}` });
    }
  }

  /** What a `prep` or `next` output leads to: its prompt, a render when nothing is left, or the next page. */
  private async after(sid: string, a: Active, out: PrepOut): Promise<void> {
    if (typeof out.prompt === "string" && out.prompt.trim()) return this.end(sid, a, { prompt: out.prompt, pattern: out.pattern?.id ?? null });
    if (out.done || (!out.choose && !out.pages?.length)) return this.render(sid, a, out.run, {}, null);
    a.view = { ...a.view, phase: "ask", doing: undefined, step: out };
    this.show(sid, a);
  }

  private async render(sid: string, a: Active, run: string, input: AnswerInput, rest: Rest | null): Promise<void> {
    a.view = { ...a.view, phase: "working", doing: "render" };
    this.show(sid, a);
    const r = await this.cli.render(run, input, rest, a.cwd, a.ac.signal);
    if (this.active.get(sid) !== a) return;
    if (!r.ok || !r.value?.prompt) return this.end(sid, a, { error: r.error ?? "promptu render wrote no prompt" });
    this.end(sid, a, { prompt: r.value.prompt, pattern: r.value.pattern });
  }

  /** A page answered (the chip row's pick as `pattern`): `next`, then the next page or the prompt. */
  async answer(sid: string, seq: number, input: AnswerInput): Promise<void> {
    const a = this.current(sid, seq);
    if (!a || a.view.phase !== "ask" || !a.view.step) return;
    const run = a.view.step.run;
    a.view = { ...a.view, phase: "working", doing: "next" };
    this.show(sid, a);
    try {
      const r = await this.cli.next(run, input, a.cwd, a.ac.signal);
      if (this.active.get(sid) !== a) return;
      if (!r.ok || !r.value) return this.end(sid, a, { error: r.error ?? "promptu next failed" });
      await this.after(sid, a, r.value);
    } catch (e) {
      this.end(sid, a, { error: `Promptu stopped: ${(e as Error)?.message ?? String(e)}` });
    }
  }

  /**
   * The dialog ends here: "Accept all recommendations" (`recommended`), or
   * Esc (`assume`) — the answers given count, what is left becomes stated
   * assumptions. `input` carries what the page on screen holds.
   */
  async finish(sid: string, seq: number, input: AnswerInput, rest: Rest): Promise<void> {
    const a = this.current(sid, seq);
    if (!a || a.view.phase !== "ask" || !a.view.step) return;
    try {
      await this.render(sid, a, a.view.step.run, input, rest);
    } catch (e) {
      this.end(sid, a, { error: `Promptu stopped: ${(e as Error)?.message ?? String(e)}` });
    }
  }

  /** Esc while the pass reads the prompt: no prompt, the draft as it was. */
  cancel(sid: string, seq: number): void {
    const a = this.current(sid, seq);
    if (!a || a.view.phase !== "working") return;
    a.ac.abort();
    this.end(sid, a, { cancelled: true });
  }

  /**
   * Why a chat's process stays up for Promptu (decision 41's "it waits on the
   * owner"): a dialog open, or a prompt no page has taken yet. So an idle
   * close never drops either.
   */
  holdReason(sid: string): string | null {
    if (this.active.has(sid)) return "a Promptu dialog is open";
    if (this.results.has(sid)) return "a Promptu prompt waits for its draft";
    return null;
  }

  /**
   * The chat's process closed, or its view was dropped: nothing of a run
   * outlives it, so none lands in the chat resumed or opened again later.
   */
  forget(sid: string): void {
    const a = this.active.get(sid);
    this.active.delete(sid);
    this.results.delete(sid);
    if (a) {
      a.ac.abort();
      this.log(`[${sid.slice(0, 8)}] promptu: dropped with its chat`);
      this.show(sid, null);
    }
  }

  dispose(): void {
    for (const a of this.active.values()) a.ac.abort();
    this.active.clear();
    this.results.clear();
    this.removeAllListeners();
  }
}
