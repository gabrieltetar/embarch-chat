// The thread list (decision 9): the window's own desk's threads, by work
// item, waiting-on-you first — every live session in its repos (terminal and
// Claude Code-panel ones too, from the desk's /view), this window's own chats
// (from their streams), plus past chats from their transcripts; Untracked
// last. Pure, so the ordering is tested without VS Code or a desk.

import type { DeskView, PrRef, ViewCard, ViewDesk } from "./client";

export type ThreadState = "waiting" | "busy" | "idle" | "ended";

export interface Thread {
  sessionId: string;
  title: string;
  state: ThreadState;
  waitingFor?: string | null;
  lastMs: number;
  cwd: string | null;
  /** Run by this window: answerable here. Anything else is read-only with Jump (decision 31). */
  ours: boolean;
  /** Running somewhere right now. */
  live: boolean;
  client?: string | null;
  folderUri?: string;
  sessionUri?: string;
}

export interface GroupItem {
  id: string;
  title: string;
  issueKey?: string;
  issueUrl?: string;
  stateName?: string;
  prs: PrRef[];
  todaySeconds: number;
  repoPath?: string | null;
}

export interface ThreadGroup {
  key: string;
  item: GroupItem | null;
  threads: Thread[];
  waiting: number;
  lastMs: number;
}

export interface OwnChat {
  sessionId: string;
  title: string | null;
  status: "waiting" | "busy" | "idle" | "closed";
  itemId: string | null;
  itemTitle?: string | null;
  lastMs: number;
  cwd: string;
  waitingFor?: string | null;
}

export interface PastChat {
  sessionId: string;
  title: string | null;
  firstPrompt: string | null;
  cwd: string | null;
  lastMs: number;
}

export interface ThreadInputs {
  view: DeskView | null;
  /** The window's desk (resolveDesk), or null when the desk is down or has none. */
  desk: ViewDesk | null;
  /** The desk's repos and their worktrees: whose sessions this list shows. */
  repos: string[];
  own: OwnChat[];
  past: PastChat[];
  /** A past session's work item, from the desk's GET /sessions/{sid}; null = untracked. */
  itemOf: Record<string, { id: string; title: string } | null>;
  now: number;
}

export function isUnder(child: string | null | undefined, parent: string): boolean {
  if (!child) return false;
  const p = parent.replace(/\/+$/, "");
  return child === p || child.startsWith(p + "/");
}

/** The desk whose repo the window's folder is in, else the open desk (decision 9). */
export function resolveDesk(folders: string[], desks: ViewDesk[], openDesk: ViewDesk | null): ViewDesk | null {
  for (const d of desks) {
    if (d.firmware_repos.some((r) => folders.some((f) => isUnder(f, r) || isUnder(r, f)))) return d;
  }
  return openDesk;
}

const RANK: Record<ThreadState, number> = { waiting: 0, busy: 1, idle: 2, ended: 3 };

function normState(s: string | undefined | null): ThreadState {
  if (s === "waiting" || s === "busy" || s === "idle" || s === "ended") return s;
  return "idle";
}

function itemOfCard(c: ViewCard, today: string): GroupItem {
  const tile = c.tiles?.find((t) => t.date === today);
  return {
    id: c.id,
    title: c.issue?.title ?? c.title,
    issueKey: c.issue?.key,
    issueUrl: c.issue?.url,
    stateName: c.issue?.state_name,
    prs: c.prs ?? [],
    todaySeconds: tile?.seconds ?? 0,
    repoPath: c.repo_path,
  };
}

export function buildThreads(inp: ThreadInputs): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  const order: string[] = [];
  const placed = new Set<string>();
  const view = inp.view;
  const today = view?.today ?? "";
  const ignore = view?.ignore ?? [];
  const inRepos = (cwd: string | null | undefined) => inp.repos.some((r) => isUnder(cwd, r));
  const ownBySid = new Map(inp.own.map((o) => [o.sessionId, o]));

  const group = (key: string, item: GroupItem | null): ThreadGroup => {
    let g = groups.get(key);
    if (!g) {
      g = { key, item, threads: [], waiting: 0, lastMs: 0 };
      groups.set(key, g);
      order.push(key);
    }
    return g;
  };

  // The desk's cards. /view carries the open desk's; when the window's desk
  // is another one, only cards working in its repos belong here.
  const foreignDesk = !!(inp.desk && view?.open_desk && inp.desk.id !== view.open_desk.id);
  for (const c of view?.cards ?? []) {
    if (foreignDesk && !(inRepos(c.repo_path) || c.live_sessions?.some((s) => inRepos(s.cwd)))) continue;
    const g = group(c.id, itemOfCard(c, today));
    g.lastMs = Math.max(g.lastMs, c.last_activity_ms ?? 0);
    for (const s of c.live_sessions ?? []) {
      if (placed.has(s.session_id)) continue;
      const own = ownBySid.get(s.session_id);
      if (own) continue; // placed below, from its own stream
      placed.add(s.session_id);
      g.threads.push({
        sessionId: s.session_id,
        title: s.name ?? "session",
        state: normState(s.state ?? s.status),
        waitingFor: s.waiting_for ?? null,
        lastMs: s.last_ms ?? s.last_reply_ms ?? c.last_activity_ms ?? 0,
        cwd: s.cwd ?? null,
        ours: false,
        live: normState(s.state ?? s.status) !== "ended",
        client: s.client ?? null,
        folderUri: s.folder_uri,
        sessionUri: s.session_uri,
      });
    }
  }

  // Live sessions on no card here: untracked ones, and ones whose item the
  // view did not carry. Kept to the window's desk by its id, else by repo.
  for (const s of view?.sessions ?? []) {
    if (placed.has(s.session_id) || ownBySid.has(s.session_id)) continue;
    const mine = inp.desk && s.desk_id ? s.desk_id === inp.desk.id : inRepos(s.cwd);
    if (!mine) continue;
    if (ignore.some((i) => isUnder(s.cwd, i))) continue;
    placed.add(s.session_id);
    const it = s.item_id ? (inp.itemOf[s.session_id] ?? { id: s.item_id, title: s.item_id }) : null;
    const key = it ? it.id : "untracked";
    const g = groups.get(key) ?? group(key, it ? { id: it.id, title: it.title, prs: [], todaySeconds: 0 } : null);
    const state = normState(s.state ?? s.status);
    g.threads.push({
      sessionId: s.session_id,
      title: s.name ?? "session",
      state,
      waitingFor: s.waiting_for ?? null,
      lastMs: s.last_ms ?? 0,
      cwd: s.cwd ?? null,
      ours: false,
      live: state !== "ended",
      client: s.client ?? null,
    });
  }

  // This window's own chats: live state from their streams.
  for (const o of inp.own) {
    placed.add(o.sessionId);
    const key = o.itemId ?? "untracked";
    const g = groups.get(key) ?? group(key, o.itemId ? { id: o.itemId, title: o.itemTitle ?? o.itemId, prs: [], todaySeconds: 0 } : null);
    g.threads.push({
      sessionId: o.sessionId,
      title: o.title ?? "New chat",
      state: o.status === "closed" ? "idle" : o.status,
      waitingFor: o.waitingFor ?? null,
      lastMs: o.lastMs,
      cwd: o.cwd,
      ours: true,
      live: o.status !== "closed",
      client: "embarch-chat",
    });
  }

  // Past chats in the desk's repos, from their transcripts.
  for (const p of [...inp.past].sort((a, b) => b.lastMs - a.lastMs)) {
    if (placed.has(p.sessionId)) continue;
    if (!inRepos(p.cwd)) continue;
    if (ignore.some((i) => isUnder(p.cwd, i))) continue;
    placed.add(p.sessionId);
    const it = inp.itemOf[p.sessionId];
    const key = it ? it.id : "untracked";
    const g = groups.get(key) ?? group(key, it ? { id: it.id, title: it.title, prs: [], todaySeconds: 0 } : null);
    g.threads.push({
      sessionId: p.sessionId,
      title: p.title ?? p.firstPrompt ?? "chat",
      state: "ended",
      lastMs: p.lastMs,
      cwd: p.cwd,
      ours: false,
      live: false,
    });
  }

  const out: ThreadGroup[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    if (!g.threads.length && g.item === null) continue;
    g.threads.sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastMs - a.lastMs);
    g.waiting = g.threads.filter((t) => t.state === "waiting").length;
    g.lastMs = Math.max(g.lastMs, ...g.threads.map((t) => t.lastMs));
    out.push(g);
  }
  // Waiting-on-you first, the desk's own order (pinned, then recent) next,
  // groups only past chats made after that by age, Untracked last.
  const idx = new Map(out.map((g, i) => [g.key, i]));
  out.sort((a, b) => {
    if (a.key === "untracked" || b.key === "untracked") return a.key === "untracked" ? 1 : -1;
    if (!!a.waiting !== !!b.waiting) return a.waiting ? -1 : 1;
    return idx.get(a.key)! - idx.get(b.key)!;
  });
  return out;
}

/** The chats waiting on the owner, oldest first: the badge count, and what a click opens (decision 35). */
export function waitingThreads(groups: ThreadGroup[]): Thread[] {
  return groups
    .flatMap((g) => g.threads)
    .filter((t) => t.state === "waiting")
    .sort((a, b) => a.lastMs - b.lastMs);
}
