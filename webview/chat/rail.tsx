// The rail on the chat's left edge (decision 94): Memory, Promptu, the 📚
// and the 💡, one icon each, folded like VS Code's activity bar until the
// pointer is on it, when their names show. The composer draws the entries
// into it (composer.tsx), since the 📚's and 💡's menus are the draft's;
// this file holds what they open beside the rail: Promptu's card (95) and
// the Memory menu (98).

import type { ComponentChildren, Ref } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { MemoryEntry, MemoryOut, MemoryUse, PatternInfo } from "../../src/promptu/cli";
import type { PromptuState } from "../../src/promptu/service";
import type { Usage, UsageWindow } from "../../src/usage";
import { LIMIT_NAMES, USAGE_AMBER, USAGE_RED, expired, limitHit, nextReset, resetsIn } from "../../src/usage";
import { useNow } from "./clock";
import { vscodeApi } from "../shared/vscode";

const post = (m: unknown) => vscodeApi.postMessage(m);

export function RailEntry(p: {
  icon: string;
  label: string;
  cls: string;
  title: string;
  lit?: boolean;
  count?: number;
  spin?: boolean;
  disabled?: boolean;
  /** What it opens beside the rail shows (a card or a menu): `aria-expanded`, never a pressed toggle (review F8). */
  expanded?: boolean;
  /** The accessible name when it says more than the label: Promptu's lit state (95). */
  ariaLabel?: string;
  btnRef?: Ref<HTMLButtonElement>;
  /** `byKey`: Enter or Space opened it, so what it opens takes the focus (review F10). */
  onClick?: (byKey: boolean) => void;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  return (
    <button
      ref={p.btnRef}
      class={`rail-entry ${p.cls} ${p.lit ? "lit" : ""} ${p.expanded ? "open" : ""}`}
      title={p.title}
      aria-label={p.ariaLabel ?? p.label}
      {...(p.expanded !== undefined ? { "aria-haspopup": "dialog", "aria-expanded": p.expanded } : {})}
      disabled={p.disabled}
      // The draft keeps the focus, so a menu's keys still come through the input (86).
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => p.onClick?.(e.detail === 0)}
      onMouseEnter={p.onEnter}
      onMouseLeave={p.onLeave}
    >
      <span class="rail-icon">
        {p.icon}
        {p.count ? <span class="count">{p.count}</span> : null}
        {p.spin && <span class="spinner" />}
      </span>
      <span class="rail-label">{p.label}</span>
    </button>
  );
}

/**
 * What the rail opens beside it (review F10): a dialog of its own that takes
 * the focus when the keys opened it — never on a hover, so typing in the
 * draft goes on — and that Esc closes, the focus going back where it was.
 */
function RailPop(p: { cls: string; label: string; focusIn: boolean; onClose: () => void; onEnter?: () => void; onLeave?: () => void; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.focusIn) return;
    const b = box.current;
    (b?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)") ?? b)?.focus();
  }, []);
  return (
    <div
      class={`rail-pop ${p.cls}`}
      ref={box}
      role="dialog"
      aria-label={p.label}
      tabIndex={-1}
      onMouseEnter={p.onEnter}
      onMouseLeave={p.onLeave}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        p.onClose();
      }}
    >
      {p.children}
    </div>
  );
}

/**
 * Promptu's card (95), on hover over its icon: on or off, what it does, a
 * pattern for the next prompt, Quick mode — nothing else. The icon itself
 * is not a switch: it lights when the next Enter runs the pass.
 */
export function PromptuCard(p: {
  state: PromptuState;
  lit: boolean;
  forced: string | null;
  onForce: (name: string | null) => void;
  onEnter: () => void;
  onLeave: () => void;
  focusIn: boolean;
  onClose: () => void;
}) {
  const s = p.state;
  const off = !s.available;
  return (
    <RailPop cls="promptu-card" label="Promptu" focusIn={p.focusIn} onClose={p.onClose} onEnter={p.onEnter} onLeave={p.onLeave}>
      <label class="promptu-switch">
        <input type="checkbox" checked={s.enabled && !off} disabled={off} onChange={(e) => post({ t: "promptuSettings", enabled: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>Promptu</b> {off ? "not installed" : s.enabled ? "on" : "off"}
        </span>
      </label>
      <div class="muted promptu-what">At the start of a task, Enter turns your prompt into a better one: Promptu asks only what is missing, then writes it into the draft. Nothing is sent until you press Enter again.</div>
      {off && s.why && <div class="warn">{s.why}</div>}
      <label class="promptu-row">
        <span>Pattern for the next prompt</span>
        <select disabled={off || !s.enabled} value={p.forced ?? ""} onChange={(e) => p.onForce((e.target as HTMLSelectElement).value || null)}>
          <option value="">Auto — Promptu picks</option>
          {s.patterns.map((x: PatternInfo) => (
            <option key={x.name} value={x.name} title={x.summary}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label class="promptu-switch">
        <input type="checkbox" checked={s.quick} disabled={off || !s.enabled} onChange={(e) => post({ t: "promptuSettings", quick: (e.target as HTMLInputElement).checked })} />
        <span>
          <b>Quick mode</b> <span class="muted">— no questions: every recommendation taken, the prompt still in your draft to check</span>
        </span>
      </label>
    </RailPop>
  );
}

// ------------------------------------------------------------ the Memory menu (98)

/** Each stale flag in words (contract §5's vocabulary; an unknown one shows as it is). */
export const FLAG_TEXT: Record<string, string> = {
  review_by_past: "review-by passed",
  source_missing: "source missing",
  bad_frontmatter: "frontmatter broken",
  no_kind: "no kind",
  no_review_by: "no review-by",
  no_source: "no source",
  no_domain: "no domain",
  unindexed: "not in the index",
  dead_link: "points nowhere",
};

const KIND_ORDER = ["preference", "rule", "trap", "reference", "status"];

export function usedTitle(used: MemoryUse[]): string {
  return used.map((u) => `pre-filled ${u.question} in ${u.pattern}, ${u.date}${u.changed ? " (you changed it)" : ""}`).join("\n");
}

/** Where a click on an entry goes: its file — the index line instead when the file is not there. */
export function entryTarget(e: MemoryEntry, index: string | null): { file: string; line?: number } {
  if (e.flags.includes("dead_link") && index) return { file: index, line: e.line_no ?? undefined };
  if (e.id === "claude-md") return { file: e.file, line: e.line_no ?? undefined };
  return { file: e.file };
}

/**
 * The tree: scope, then domain, then kind (decision 98, SYNTHESIS §9.8).
 * A `CLAUDE.md` contributes its sections as rows, with no kind.
 */
export function memoryTree(d: MemoryOut): Array<{ id: string; label: string; files: string[]; domains: Array<{ name: string | null; kinds: Array<{ kind: string | null; entries: MemoryEntry[] }> }>; count: number; stale: number }> {
  return d.scopes.map((s) => {
    const es = d.entries.filter((e) => e.scope === s.id);
    const order = [...s.domains, null];
    const names = [...new Set(es.map((e) => e.domain))].sort((a, b) => {
      const x = order.indexOf(a);
      const y = order.indexOf(b);
      return (x < 0 ? order.length : x) - (y < 0 ? order.length : y);
    });
    return {
      id: s.id,
      label: s.label,
      files: s.files,
      count: es.length,
      stale: es.filter((e) => e.stale).length,
      domains: names.map((name) => {
        const inDomain = es.filter((e) => e.domain === name);
        const kinds = [...new Set(inDomain.map((e) => e.kind))].sort((a, b) => (a === null ? 99 : KIND_ORDER.indexOf(a)) - (b === null ? 99 : KIND_ORDER.indexOf(b)));
        return { name, kinds: kinds.map((kind) => ({ kind, entries: inDomain.filter((e) => e.kind === kind) })) };
      }),
    };
  });
}

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

function Row({ e, index }: { e: MemoryEntry; index: string | null }) {
  const t = entryTarget(e, index);
  return (
    <button class={`mem-row ${e.stale ? "stale" : ""}`} title={`${e.line ?? e.title}\n${e.file}`} onClick={() => post({ t: "promptuOpen", file: t.file, line: t.line })}>
      <span class="mem-title">{e.title}</span>
      {e.id === "claude-md" && <span class="muted mem-file">{base(e.file)}</span>}
      {e.age_days !== null && <span class="muted mem-age">{e.age_days}d</span>}
      {e.flags.map((f) => (
        <span key={f} class="mem-flag">
          {FLAG_TEXT[f] ?? f}
        </span>
      ))}
      {e.used.length > 0 && (
        <span class="mem-used" title={usedTitle(e.used)}>
          used ×{e.used.length}
        </span>
      )}
    </button>
  );
}

export function MemoryPanel({ mem, onRefresh, focusIn, onClose }: { mem: { loading: boolean; data?: MemoryOut; error?: string }; onRefresh: () => void; focusIn: boolean; onClose: () => void }) {
  const d = mem.data;
  return (
    <RailPop cls="memory-pop" label="Memory" focusIn={focusIn} onClose={onClose}>
      <div class="mem-head">
        <b>Memory</b>
        {d && (
          <span class="muted">
            {" "}
            · {base(d.project_root)} · {d.counts?.entries ?? d.entries.length} entries, {d.counts?.stale ?? d.entries.filter((e) => e.stale).length} stale
          </span>
        )}
        <button class="icon" title="Read it again" onClick={onRefresh}>
          ↻
        </button>
      </div>
      {mem.loading && !d && (
        <div class="muted">
          <span class="spinner" /> Reading…
        </div>
      )}
      {mem.error && <div class="warn">{mem.error}</div>}
      {d && (
        <div class="mem-tree">
          {memoryTree(d).map((s) => (
            <details key={s.id} open={s.id === "auto"} class="mem-scope">
              <summary>
                {s.label}{" "}
                <span class="muted">
                  {s.count} · {s.stale} stale
                </span>
                {s.id === "user" && (d.used_claude_md?.length ?? 0) > 0 && (
                  <span class="mem-used" title={usedTitle(d.used_claude_md!)}>
                    CLAUDE.md used ×{d.used_claude_md!.length}
                  </span>
                )}
              </summary>
              {s.count === 0 && <div class="muted mem-empty">{s.id === "auto" ? (d.memory.exists ? "No memories yet." : "No auto-memory folder for this project yet.") : "Nothing here."}</div>}
              {s.domains.map((dom) =>
                s.id === "auto" ? (
                  <div key={dom.name ?? "-"} class="mem-domain">
                    <div class="mem-domain-name">{dom.name ?? "No domain"}</div>
                    {dom.kinds.map((k) => (
                      <div key={k.kind ?? "-"} class="mem-kind">
                        <div class="q-head">{k.kind ?? "no kind"}</div>
                        {k.entries.map((e) => (
                          <Row key={e.file} e={e} index={d.memory.index} />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  dom.kinds.flatMap((k) => k.entries).map((e) => <Row key={`${e.file}:${e.line_no}`} e={e} index={d.memory.index} />)
                ),
              )}
            </details>
          ))}
          <div class="muted mem-note">A click opens the entry's file beside the chat, to read or edit.</div>
        </div>
      )}
    </RailPop>
  );
}

// ------------------------------------------------------------ the Usage card (99)

const pct = (w: UsageWindow) => `${Math.round(w.used * 100)} %`;
/** A window's share in a line: its percent, "reset" past its reset (review F14), or "not reported". */
const share = (w: UsageWindow | null, now: number) => (!w ? "not reported" : expired(w, now) ? "reset" : pct(w));

/** One line for the icon's name and hover: each window's share, or that there is no reading. */
export function usageSummary(u: Usage | null, now = Date.now()): string {
  if (!u) return "no reading yet";
  if (limitHit(u, now)) return `${(u.limit && LIMIT_NAMES[u.limit]) || "usage limit"} reached`;
  return `session ${share(u.session, now)}, weekly ${share(u.weekly, now)}`;
}

/**
 * The time a reading shows at, the page drawn again at each reset still
 * ahead, so a window greys by itself when it resets (review F14).
 */
export function useUsageNow(u: Usage | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const next = nextReset(u);
    if (next === null) return;
    // A timer's longest wait is about 24 days; a reset further off waits in steps.
    const t = window.setTimeout(() => setTick((n) => n + 1), Math.min(Math.max(0, next - Date.now()) + 250, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [u, tick]);
  return Date.now();
}

/** A clock time, with the day when it is more than a day from now. */
function clock(resetsAt: number, now: number): string {
  const d = new Date(resetsAt * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return Math.abs(resetsAt * 1000 - now) > 86_400_000 ? `${d.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
}

/** When a window resets: in how long, and the clock time (with the day past a day). */
function resetText(resetsAt: number | null, now: number): string {
  if (!resetsAt) return "reset time not reported";
  return `resets ${resetsIn(resetsAt, now)} (${clock(resetsAt, now)})`;
}

/** How old a window's reading is: each keeps its own, as last heard (review F15). */
function heardAgo(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60000));
  if (min < 1) return "just now";
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

/** One window on the card; past its reset it shows as reset, grey, its bar empty (review F14). */
function UsageRow({ name, w, now, heard }: { name: string; w: UsageWindow | null; now: number; heard: number }) {
  const gone = expired(w, now);
  const level = !w || gone ? "none" : w.used >= USAGE_RED ? "red" : w.used >= USAGE_AMBER ? "amber" : "ok";
  return (
    <div class={`usage-row ${level}`}>
      <div class="usage-head">
        <span>{name}</span>
        <b>{!w ? "not reported" : gone ? "reset" : `${pct(w)} used`}</b>
      </div>
      <div class="usage-bar" aria-hidden="true">
        <span style={{ width: `${w && !gone ? Math.round(w.used * 100) : 0}%` }} />
      </div>
      {w && (
        <div class="muted usage-reset">
          {gone ? `reset at ${clock(w.resetsAt!, now)}; a chat's next reply reports it again` : `${resetText(w.resetsAt, now)} · reported ${heardAgo(w.at ?? heard, now)}`}
        </div>
      )}
    </div>
  );
}

/**
 * The Usage card (99), on hover over its icon: the 5-hour session's and the
 * week's share of the Claude plan used, with when each resets, as the
 * newest `rate_limit_event` any chat of this window heard says them.
 */
export function UsageCard(p: { usage: Usage | null; focusIn: boolean; onClose: () => void; onEnter: () => void; onLeave: () => void }) {
  const now = useNow(30_000, true);
  const u = p.usage;
  return (
    <RailPop cls="usage-card" label="Claude plan usage" focusIn={p.focusIn} onClose={p.onClose} onEnter={p.onEnter} onLeave={p.onLeave}>
      <div class="usage-title">
        <b>Claude plan usage</b>
      </div>
      {!u && <div class="muted">No reading yet: Claude Code reports it with a chat's reply, so it shows once a chat of this window has had one.</div>}
      {u && (
        <>
          {limitHit(u, now) && (
            <div class="warn">{u.grace ? "Limit reached — the turn under way is finishing." : `You've hit your ${(u.limit && LIMIT_NAMES[u.limit]) || "usage limit"}.`}</div>
          )}
          <UsageRow name="Session (5 hours)" w={u.session} now={now} heard={u.at} />
          <UsageRow name="Weekly" w={u.weekly} now={now} heard={u.at} />
          <div class="muted usage-note">
            Each window as Claude Code last reported it. The icon turns amber from {Math.round(USAGE_AMBER * 100)} % and red from {Math.round(USAGE_RED * 100)} %.
          </div>
        </>
      )}
    </RailPop>
  );
}
