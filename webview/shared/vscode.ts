// The one VS Code API handle a webview may acquire.

interface VsApi {
  postMessage(m: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsApi;

export const vscodeApi: VsApi =
  typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log("post", m), getState: () => undefined, setState: () => undefined };

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function duration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
