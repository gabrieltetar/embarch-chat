// A menu with one submenu per category, as VS Code's Quick Fix bulb shows
// them (decision 38): the 💡's cards by kind, the 📚's entries by their
// `category:`. Categories on the left, the open one's items on the right;
// hovering an item tells the caller (the 💡 previews its card in the draft,
// decision 37), a click picks it.

import { useEffect, useRef, useState } from "preact/hooks";

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

interface Props<T> {
  kind: string;
  groups: Array<MenuGroup<T>>;
  onPick: (v: T) => void;
  onHover?: (v: T | null) => void;
  onClose: () => void;
  /** Elements whose clicks do not close the menu (the button that opens it). */
  anchor?: HTMLElement | null;
}

export function CategoryMenu<T>({ kind, groups, onPick, onHover, onClose, anchor }: Props<T>) {
  const [open, setOpen] = useState(groups[0]?.id ?? "");
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
  if (!cur) return null;
  return (
    <div class={`menu ${kind}`} ref={ref} onMouseLeave={() => onHover?.(null)}>
      <div class="menu-cats">
        {groups.map((g) => (
          <div key={g.id} class={`menu-cat ${g.id === cur.id ? "on" : ""}`} onMouseEnter={() => setOpen(g.id)} onMouseDown={(e) => (e.preventDefault(), setOpen(g.id))}>
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
            class={`menu-item ${it.disabled ? "disabled" : ""}`}
            title={it.title ?? it.detail}
            onMouseEnter={() => onHover?.(it.value)}
            onMouseLeave={() => onHover?.(null)}
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
