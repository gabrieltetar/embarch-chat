// What the chat knows of Promptu outside a run (decisions 95, 96): whether
// the `promptu` binary is here, the card's two switches — on or off, Quick
// mode — kept in the extension's own state for every window (never the
// owner's settings: 82's rule for effort), and the pattern set for the
// card's picker, read once from `promptu patterns --json` and again every
// few minutes, and the weekly pass's line (95), read the same way from
// `promptu week status --json`. Events: `state` whenever any of it changes.

import { EventEmitter } from "events";
import type { McpServer } from "../wire/reducer";
import type { PatternInfo, PromptuCli, WeekStatus } from "./cli";

/** The weekly pass's line on the card: what `week status` said, or one line when it failed. */
export type PromptuWeek =
  | { error: string }
  | { last: { week: string; at: string | null; status: string } | null; next: string | null; running: boolean; missed: boolean; missedSince: string | null; open: number; sheetWeek: string | null };

function weekOf(s: WeekStatus): PromptuWeek {
  return {
    last: s.last ? { week: s.last.week, at: s.last.finished ?? s.last.started ?? null, status: s.last.status } : null,
    next: s.next ?? null,
    running: s.running,
    missed: s.missed === true,
    missedSince: s.missed_since ?? null,
    open: Number.isFinite(s.open) ? s.open : 0,
    sheetWeek: s.sheet?.week ?? null,
  };
}

/** The card's switches and what it lists, as the page gets them. */
export interface PromptuState {
  /** The binary is found (`embarchChat.promptuPath`, or PATH). */
  available: boolean;
  /** The card's switch: Enter at a task start runs the pass (95). Default on. */
  enabled: boolean;
  /** Quick mode: no dialog, every recommendation taken, the prompt still in the draft for a look (95). */
  quick: boolean;
  patterns: PatternInfo[];
  /** The weekly pass's line; null: none to show (no `week status` verb, or not read yet) (95). */
  week: PromptuWeek | null;
  /** A pass the card started that failed: one line, until the next click or the next success (95). */
  weekRunError: string | null;
  /** One line when it is not available: why. */
  why: string | null;
}

/** The extension's global state, or a stand-in in tests. */
export interface Store {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export const ENABLED_KEY = "embarchChat.promptu.enabled";
export const QUICK_KEY = "embarchChat.promptu.quick";
const PATTERNS_MS = 5 * 60_000;

/**
 * Whether the bench tools are part of this session (`--have embarch-api`):
 * the chat's own MCP list once its CLI has said, else the `embarch-api`
 * binary on PATH — a chat's first prompt goes before its CLI starts.
 */
export function embarchApiPresent(mcp: McpServer[] | null | undefined, onPath: () => boolean): boolean {
  if (mcp) return mcp.some((s) => s.name === "embarch-api" && s.status !== "disabled" && s.status !== "failed");
  return onPath();
}

export class PromptuService extends EventEmitter {
  private patterns: { bin: string | null; at: number; list: PatternInfo[] } = { bin: null, at: 0, list: [] };
  private fetching = false;
  private week: { bin: string | null; at: number; value: PromptuWeek | null } = { bin: null, at: 0, value: null };
  private fetchingWeek = false;
  private runningWeek = false;
  private weekRunError: string | null = null;

  constructor(
    readonly cli: PromptuCli,
    private store: Store,
    private log: (s: string) => void,
  ) {
    super();
  }

  state(cwd: string): PromptuState {
    const bin = this.cli.located();
    if (bin && (bin !== this.patterns.bin || Date.now() - this.patterns.at > PATTERNS_MS)) void this.loadPatterns(bin, cwd);
    if (bin && (bin !== this.week.bin || Date.now() - this.week.at > PATTERNS_MS)) void this.loadWeek(bin, cwd);
    return {
      available: !!bin,
      enabled: this.store.get<boolean>(ENABLED_KEY, true),
      quick: this.store.get<boolean>(QUICK_KEY, false),
      patterns: bin === this.patterns.bin ? this.patterns.list : [],
      week: this.weekShown(bin),
      weekRunError: this.weekRunError,
      why: bin ? null : "promptu is not installed here: put it on PATH, or set embarchChat.promptuPath",
    };
  }

  /** The week's line, a pass this window started counted as running before `week status` has caught up. */
  private weekShown(bin: string | null): PromptuWeek | null {
    const v = bin && bin === this.week.bin ? this.week.value : null;
    if (this.runningWeek && v && !("error" in v)) return { ...v, running: true };
    return v;
  }

  /** The card's weekly line has a sheet waiting: the click opens it rather than runs a pass (95). */
  sheetWaiting(cwd: string): boolean {
    const w = this.state(cwd).week;
    return !!w && !("error" in w) && w.open > 0 && !!w.sheetWeek;
  }

  /**
   * The card's click on the weekly line with no sheet waiting (95): one
   * `promptu week run`, in the background. Nothing starts when one is going,
   * this window's or the timer's (`week status` says `running`; exit 4 is the
   * same answer from `week run` itself). A failure is one line on the card.
   */
  async runWeek(cwd: string): Promise<void> {
    const bin = this.cli.located();
    if (!bin || this.runningWeek) return;
    const w = this.state(cwd).week;
    if (!w || "error" in w || w.running || this.sheetWaiting(cwd)) return;
    this.runningWeek = true;
    this.weekRunError = null;
    this.emit("state");
    try {
      const r = await this.cli.weekRun(cwd);
      if (!r.ok && !r.busy) this.weekRunError = r.error ?? "promptu week run failed";
      if (!r.ok) this.log(`promptu week run: ${r.error}`);
    } finally {
      this.runningWeek = false;
    }
    await this.loadWeek(bin, cwd);
    this.emit("state");
  }

  /** On and found: Enter at a task start, and Start work, run the pass. */
  ready(): boolean {
    return this.store.get<boolean>(ENABLED_KEY, true) && !!this.cli.located();
  }

  quick(): boolean {
    return this.store.get<boolean>(QUICK_KEY, false);
  }

  async set(change: { enabled?: unknown; quick?: unknown }): Promise<void> {
    if (typeof change.enabled === "boolean") await this.store.update(ENABLED_KEY, change.enabled);
    if (typeof change.quick === "boolean") await this.store.update(QUICK_KEY, change.quick);
    this.emit("state");
  }

  private async loadPatterns(bin: string, cwd: string): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const r = await this.cli.patterns(cwd);
      this.patterns = { bin, at: Date.now(), list: r.ok && r.value ? r.value : [] };
      if (!r.ok) this.log(`promptu patterns: ${r.error}`);
    } finally {
      this.fetching = false;
    }
    this.emit("state");
  }

  private async loadWeek(bin: string, cwd: string): Promise<void> {
    if (this.fetchingWeek) return;
    this.fetchingWeek = true;
    let value: PromptuWeek | null = null;
    try {
      const r = await this.cli.weekStatus(cwd);
      if (r.ok && r.value) value = weekOf(r.value);
      else if (!r.unsupported) value = { error: r.error ?? "promptu week status failed" };
      if (!r.ok) this.log(`promptu week status: ${r.error}`);
    } finally {
      this.week = { bin, at: Date.now(), value };
      this.fetchingWeek = false;
    }
    this.emit("state");
  }
}
