// A menu with one submenu per category, as VS Code's Quick Fix bulb shows
// them (decision 38): the 💡's cards by kind, the 📚's entries by their
// `category:`. Categories on the left, the open one's items on the right;
// a click picks an item.
//
// One row is focused at a time, as in IntelliSense (86): the pointer focuses
// the row it enters, ↑/↓ move it within the open category and ←/→ to the
// category before or after, Enter picks it, Esc closes. The caller hears which
// row is focused (the 💡 previews its card in the draft, decision 37), and
// nothing else: leaving a row for another swaps it, leaving the menu clears
// it. The keys come through the input, which keeps the focus as an editor
// does under its suggestions, so typing goes on; no row is focused when the
// menu opens, so Enter still sends until ↑/↓ move in.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

export interface MenuItem<T> {
  key: string;
  label: string;
  detail?: string;
  title?: string;
  disabled?: boolean;
  value: T;
}

export interface MenuGroup<T> {
  id: string;
  label: string;
  items: Array<MenuItem<T>>;
}

/** The menu's keys, handed to it first while it shows: true when it took the key. */
export type MenuKeys = { current: ((e: KeyboardEvent) => boolean) | null };

interface Props<T> {
  kind: string;
  groups: Array<MenuGroup<T>>;
  onPick: (v: T) => void;
  onHover?: (v: T | null) => void;
  onClose: () => void;
  /** Elements whose clicks do not close the menu (the button that opens it). */
  anchor?: HTMLElement | null;
  /** Filled with the menu's key handler while it is open (86). */
  keys?: MenuKeys;
}

const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"];

export function CategoryMenu<T>({ kind, groups, onPick, onHover, onClose, anchor, keys }: Props<T>) {
  const [open, setOpen] = useState(groups[0]?.id ?? "");
  /** The focused row's key. */
  const [on, setOn] = useState<string | null>(null);
  /** The last move was a key's: the focused row is scrolled into view. */
  const byKey = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [anchor, onClose]);
  const cur = groups.find((g) => g.id === open) ?? groups[0];

  const focusRow = (it: MenuItem<T> | null, key = false) => {
    byKey.current = key && it !== null;
    setOn(it?.key ?? null);
    onHover?.(it ? it.value : null);
  };
  const openGroup = (g: MenuGroup<T>) => {
    if (g.id === cur?.id) return;
    setOpen(g.id);
    focusRow(null);
  };

  // A focused row whose item went (the cards changed under it) is focused no more.
  const stale = on !== null && !cur?.items.some((i) => i.key === on);
  useEffect(() => {
    if (stale) focusRow(null);
  }, [stale]);
  useEffect(() => {
    if (!byKey.current) return;
    byKey.current = false;
    ref.current?.querySelector(".menu-item.on")?.scrollIntoView({ block: "nearest" });
  }, [on, open]);

  const handle = (e: KeyboardEvent): boolean => {
    if (!cur || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return false;
    const rows = cur.items.filter((i) => !i.disabled);
    const at = rows.findIndex((i) => i.key === on);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) {
      // While the menu shows, ↑/↓ are its own, as under IntelliSense.
      const n = rows.length;
      const down = e.key === "ArrowDown";
      if (n) focusRow(rows[at < 0 ? (down ? 0 : n - 1) : (at + (down ? 1 : n - 1)) % n], true);
      return true;
    }
    if (on === null) return false;
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.shiftKey) {
      const n = groups.length;
      const g = groups[(groups.indexOf(cur) + (e.key === "ArrowRight" ? 1 : n - 1)) % n];
      setOpen(g.id);
      focusRow(g.items.find((i) => !i.disabled) ?? null, true);
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const it = cur.items.find((i) => i.key === on);
      if (it && !it.disabled) onPick(it.value);
      return true;
    }
    // Any other key goes back to the draft: the focused row, and its preview, go.
    if (!MODIFIERS.includes(e.key)) focusRow(null);
    return false;
  };
  const handleNow = useRef(handle);
  handleNow.current = handle;
  const stable = useMemo(() => (e: KeyboardEvent) => handleNow.current(e), []);
  useEffect(() => {
    if (!keys) return;
    keys.current = stable;
    return () => {
      if (keys.current === stable) keys.current = null;
    };
  }, [keys]);

  if (!cur) return null;
  return (
    <div class={`menu ${kind}`} ref={ref} onMouseLeave={() => focusRow(null)}>
      <div class="menu-cats">
        {groups.map((g) => (
          <div key={g.id} class={`menu-cat ${g.id === cur.id ? "on" : ""}`} onMouseEnter={() => openGroup(g)} onMouseDown={(e) => (e.preventDefault(), openGroup(g))}>
            <span class="menu-label">{g.label}</span>
            <span class="menu-n">{g.items.length}</span>
            <span class="menu-arrow">▸</span>
          </div>
        ))}
      </div>
      <div class="menu-items">
        {cur.items.map((it) => (
          <div
            key={it.key}
            class={`menu-item ${it.disabled ? "disabled" : ""} ${it.key === on ? "on" : ""}`}
            title={it.title ?? it.detail}
            // No leave of its own (86): the next row's enter swaps the preview, the menu's leave ends it.
            onMouseEnter={() => it.key !== on && focusRow(it)}
            onMouseDown={(e) => {
              e.preventDefault();
              if (!it.disabled) onPick(it.value);
            }}
          >
            <div class="menu-item-label">{it.label}</div>
            {it.detail && <div class="menu-item-detail">{it.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
