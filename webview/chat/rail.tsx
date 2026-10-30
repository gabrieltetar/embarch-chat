// The rail on the chat's left edge (decision 94): Memory, Promptu, the 📚
// and the 💡, one icon each, folded like VS Code's activity bar until the
// pointer is on it, when their names show. The composer draws the entries
// into it (composer.tsx), since the 📚's and 💡's menus are the draft's;
// this file holds what they open beside the rail: Promptu's card (95) and
// the Memory menu (98).

import type { Ref } from "preact";
import type { MemoryEntry, MemoryOut, MemoryUse, PatternInfo } from "../../src/promptu/cli";
import type { PromptuState } from "../../src/promptu/service";
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
  pressed?: boolean;
  btnRef?: Ref<HTMLButtonElement>;
  onClick?: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  return (
    <button
      ref={p.btnRef}
      class={`rail-entry ${p.cls} ${p.lit ? "lit" : ""} ${p.pressed ? "pressed" : ""}`}
      title={p.title}
      aria-label={p.label}
      aria-pressed={p.pressed}
      disabled={p.disabled}
      // The draft keeps the focus, so a menu's keys still come through the input (86).
      onMouseDown={(e) => e.preventDefault()}
      onClick={p.onClick}
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
}) {
  const s = p.state;
  const off = !s.available;
  return (
    <div class="rail-pop promptu-card" role="dialog" aria-label="Promptu" onMouseEnter={p.onEnter} onMouseLeave={p.onLeave}>
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
    </div>
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

export function MemoryPanel({ mem, onRefresh }: { mem: { loading: boolean; data?: MemoryOut; error?: string }; onRefresh: () => void }) {
  const d = mem.data;
  return (
    <div class="rail-pop memory-pop" role="dialog" aria-label="Memory">
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
    </div>
  );
}
