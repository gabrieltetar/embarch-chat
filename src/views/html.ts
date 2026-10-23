import * as crypto from "crypto";
import * as vscode from "vscode";
import { pageHtml } from "./page";

/** A webview page for one of the two bundles (chat, list): strict CSP, scripts by nonce only, the title escaped. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: "chat" | "list", title: string): string {
  return pageHtml({
    nonce: crypto.randomBytes(16).toString("base64"),
    cspSource: webview.cspSource,
    js: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${bundle}.js`)).toString(),
    css: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${bundle}.css`)).toString(),
    title,
  });
}
