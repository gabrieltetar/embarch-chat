// Every link the webviews draw. It never carries an `href`: VS Code's
// webview host listens for clicks on the page itself (`handleInnerClick` in
// its pre/index.html), takes any clicked <a> with an href — whatever the
// page's own handler did, `preventDefault` included — and opens it on its
// side: http(s) a second time, and `vscode:` or `mailto:` links the
// extension would refuse. Without an href that handler never sees a link;
// the click is the page's alone and goes to the extension's own routing
// (`openLink`: http(s) only, opened once).

import type { ComponentChildren } from "preact";

export function Link({ onOpen, class: cls, title, children }: { onOpen: () => void; class?: string; title?: string; children: ComponentChildren }) {
  return (
    <a
      role="link"
      tabIndex={0}
      class={cls}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </a>
  );
}

/** A link that opens in the browser: http(s) only. */
export const isWebLink = (url: string): boolean => /^https?:\/\//.test(url);

/** A URI with a scheme of its own (`vscode:`, `mailto:`, `command:`, `file:`, ...) — not a path. One letter is a Windows drive, not a scheme. */
export const hasScheme = (url: string): boolean => /^[a-z][a-z0-9+.-]+:/i.test(url);
