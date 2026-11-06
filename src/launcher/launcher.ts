// The embarch-ui launcher, moved in from embarch-ui's vscode-extension
// (decision 29): one sideloaded extension, so the silent drop a VS Code
// server update causes costs one reinstall. Its commands, status bar item
// and `embarchUi.*` settings keep their names.
//
// It spawns nothing (decision 102, embarch-ui decision 101): embarch-ui runs
// as the systemd user unit `embarch-ui.service`, one per machine and alive
// with no window open. This reads the unit's state, drives it through
// `systemctl --user` and shows the page in the system browser. Nothing
// renders inside the editor — no webview, no custom TreeView/editor
// (embarch-ui decision 3).

import * as cp from "child_process";
import * as http from "http";
import * as vscode from "vscode";

import { focusExistingTab } from "./focus";

/** The `<title>` embarch-ui serves, and therefore the string the focus
 * strategies match a browser tab on — a load-bearing interface between two
 * components that otherwise don't know about each other (embarch-ui
 * decision 28). Renaming the page's title without changing this breaks
 * focus *silently*: Start keeps working, it just opens a duplicate tab
 * again, which is the original bug back with no error anywhere. */
const PAGE_TITLE = "EmbArch";

const UNIT = "embarch-ui.service";
const INSTALL_HINT = "Run `embarch-ui service install` with the binary the service should run.";

/** How often the status bar re-reads the unit: a Stop or Restart from
 * another window, a terminal or a crash shows here within this. */
const REFRESH_MS = 5000;

/** How long Start waits for the address to answer before showing it. */
const READY_MS = 5000;

/** What the status bar is reporting. `external` is a server answering on
 * the configured address while the unit is not running it: started by
 * hand, so nothing here can stop it. `missing` is no unit at all. */
type ServerState = "running" | "stopped" | "external" | "missing";

let statusItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let refreshing = false;

function config() {
  const cfg = vscode.workspace.getConfiguration("embarchUi");
  return {
    host: cfg.get<string>("host", "127.0.0.1"),
    port: cfg.get<number>("port", 4890),
  };
}

export function serverUrl(): string {
  const { host, port } = config();
  return `http://${host}:${port}/`;
}

/** `systemctl --user ARGS`; rejects with its own words on a non-zero exit. */
function systemctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile("systemctl", ["--user", ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || stdout || err.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

/** The unit's load and active state; `not-found` / `inactive` when
 * `systemctl` itself cannot answer. */
async function unitState(): Promise<{ load: string; active: string }> {
  try {
    const out = await systemctl(["show", UNIT, "--property=LoadState,ActiveState"]);
    const prop = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "";
    return { load: prop("LoadState"), active: prop("ActiveState") };
  } catch (e) {
    output.appendLine(`systemctl --user show ${UNIT}: ${(e as Error).message}`);
    return { load: "not-found", active: "inactive" };
  }
}

/** Is something already serving the configured address? A 400 ms GET that
 * resolves true on *any* response — the question is whether the address is
 * answered, not what it answers. Loopback, so a real server replies in
 * single-digit milliseconds and the timeout only ever covers a dropped
 * packet. */
function probe(): Promise<boolean> {
  const { host, port } = config();
  return new Promise<boolean>((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: 400 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/** Waits for the address to answer after a start, so the tab opens on a
 * page rather than on a refused connection. */
async function answered(): Promise<boolean> {
  for (const deadline = Date.now() + READY_MS; Date.now() < deadline; ) {
    if (await probe()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function readState(): Promise<ServerState> {
  const { load, active } = await unitState();
  if (active === "active") {
    return "running";
  }
  if (await probe()) {
    return "external";
  }
  return load === "not-found" ? "missing" : "stopped";
}

/** Every state's click goes to `start()`, which shows a running server and
 * starts a stopped one; Stop and Restart are palette commands, since the
 * unit is shared by every window. */
function setStatus(state: ServerState) {
  statusItem.command = "embarchUi.start";
  if (state === "running") {
    statusItem.text = "$(server-process) embarch-ui";
    statusItem.tooltip = `${UNIT} is running at ${serverUrl()} — click to show it`;
    return;
  }
  if (state === "external") {
    statusItem.text = "$(server-process) embarch-ui (external)";
    statusItem.tooltip = `embarch-ui is answering at ${serverUrl()}, but not as ${UNIT} — click to show it`;
    return;
  }
  if (state === "missing") {
    statusItem.text = "$(server-process) embarch-ui (not installed)";
    statusItem.tooltip = `${UNIT} is not installed. ${INSTALL_HINT}`;
    return;
  }
  statusItem.text = "$(server-process) embarch-ui (stopped)";
  statusItem.tooltip = `${UNIT} is stopped — click to start it`;
}

async function refresh(): Promise<ServerState> {
  const state = await readState();
  setStatus(state);
  return state;
}

/** Show the running server: focus the tab that already has it open, and
 * only open a new one if there is no such tab. Every `start()` path goes
 * through here; `embarchUi.openInBrowser` deliberately does not, so there
 * is always an unconditional way to get a second tab. */
async function reveal(): Promise<void> {
  if (await focusExistingTab(PAGE_TITLE, (message) => output.appendLine(message))) {
    return;
  }
  await openInBrowser();
}

/** Runs one `systemctl --user` verb on the unit, then refreshes the status
 * bar; false, with the error shown, when it fails. */
async function drive(verb: "start" | "stop" | "restart"): Promise<boolean> {
  output.appendLine(`systemctl --user ${verb} ${UNIT}`);
  try {
    await systemctl([verb, UNIT]);
    return true;
  } catch (e) {
    const message = (e as Error).message;
    output.appendLine(message);
    vscode.window.showErrorMessage(`systemctl --user ${verb} ${UNIT} failed: ${message} Its log: journalctl --user -u embarch-ui`);
    return false;
  } finally {
    await refresh();
  }
}

/** Starts the unit unless something already serves its address, then
 * shows it — focusing the tab that already has it open rather than opening
 * another one. */
async function start(): Promise<void> {
  const state = await refresh();
  if (state === "running" || state === "external") {
    await reveal();
    return;
  }
  if (state === "missing") {
    vscode.window.showErrorMessage(`${UNIT} is not installed. ${INSTALL_HINT}`);
    return;
  }
  if ((await drive("start")) && (await answered())) {
    await reveal();
  }
}

async function stop(): Promise<void> {
  const state = await refresh();
  if (state === "missing") {
    vscode.window.showInformationMessage(`${UNIT} is not installed.`);
    return;
  }
  if (state === "external") {
    vscode.window.showInformationMessage(`embarch-ui at ${serverUrl()} was not started by ${UNIT}; stop it where it was started.`);
    return;
  }
  await drive("stop");
}

/** Restarts the unit — after a dev build, onto the new binary. The open
 * tab reconnects by itself, so nothing is opened. */
async function restart(): Promise<void> {
  if ((await refresh()) === "missing") {
    vscode.window.showErrorMessage(`${UNIT} is not installed. ${INSTALL_HINT}`);
    return;
  }
  await drive("restart");
}

async function openInBrowser(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(serverUrl()));
}

export function activateLauncher(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("EmbArch UI");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  setStatus("stopped");
  statusItem.show();

  // Unref'd: a status refresh never keeps the extension host alive.
  const timer = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    void refresh().finally(() => (refreshing = false));
  }, REFRESH_MS);
  timer.unref();

  context.subscriptions.push(
    output,
    statusItem,
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand("embarchUi.start", start),
    vscode.commands.registerCommand("embarchUi.stop", stop),
    vscode.commands.registerCommand("embarchUi.restart", restart),
    vscode.commands.registerCommand("embarchUi.openInBrowser", openInBrowser)
  );

  void refresh();
}
