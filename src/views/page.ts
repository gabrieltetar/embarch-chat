// The webview page itself, without VS Code: the strict CSP (scripts by
// nonce only) and the escaped title. html.ts fills it in for a webview; the
// webview tests load the same page in Firefox.

export interface PageParts {
  nonce: string;
  /** The webview's own origin for styles, images and fonts (`webview.cspSource`). */
  cspSource: string;
  js: string;
  css: string;
  /** A chat's title — an issue's, Claude's, Haiku's: escaped here. */
  title: string;
  /** Extra markup at the end of <head> (the tests' stand-in for the webview's API). */
  head?: string;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function pageHtml(p: PageParts): string {
  const csp = [
    "default-src 'none'",
    `img-src ${p.cspSource} data:`,
    `style-src ${p.cspSource} 'unsafe-inline'`,
    `font-src ${p.cspSource}`,
    `script-src 'nonce-${p.nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)}</title>
<link rel="stylesheet" href="${escapeHtml(p.css)}">${p.head ?? ""}
</head>
<body>
<div id="app"></div>
<script nonce="${p.nonce}" src="${escapeHtml(p.js)}"></script>
</body>
</html>`;
}
