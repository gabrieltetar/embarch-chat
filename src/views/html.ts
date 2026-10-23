import * as crypto from "crypto";
import * as vscode from "vscode";

/** A webview page for one of the two bundles (chat, list): strict CSP, scripts by nonce only. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: "chat" | "list", title: string): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${bundle}.js`));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${bundle}.css`));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
