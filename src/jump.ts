// Jump brings up the window or terminal running a thread this window does
// not run (decision 31). Another window's folder is opened (VS Code focuses
// the window that has it); a chat of this panel's in that window also gets a
// focus entry in the desk's mailbox, which that window takes and opens. In
// this window, a terminal running it is shown; failing that, Claude Code's
// own panel is asked for the session.

import * as cp from "child_process";
import * as fs from "fs";
import * as vscode from "vscode";
import type { DeskClient } from "./desk/client";
import type { Thread } from "./desk/threads";

function agentPid(claudePath: string, sid: string): Promise<number | null> {
  return new Promise((resolve) => {
    cp.execFile(claudePath, ["agents", "--json"], { timeout: 8000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const a = (JSON.parse(out) as Array<{ sessionId?: string; pid?: number }>).find((x) => x.sessionId === sid);
        resolve(a?.pid ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

function parentOf(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may hold spaces and parentheses: fields resume after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    return ppid > 1 ? ppid : null;
  } catch {
    return null;
  }
}

async function terminalRunning(pid: number): Promise<vscode.Terminal | null> {
  const shells = new Map<number, vscode.Terminal>();
  for (const t of vscode.window.terminals) {
    const p = await t.processId;
    if (p) shells.set(p, t);
  }
  for (let p: number | null = pid, hops = 0; p && hops < 12; p = parentOf(p), hops++) {
    const t = shells.get(p);
    if (t) return t;
  }
  return null;
}

export async function jump(t: Thread, inThisWindow: boolean, desk: DeskClient, claudePath: string, log: (s: string) => void): Promise<void> {
  if (!inThisWindow && t.cwd) {
    if (t.client === "embarch-chat") {
      await desk.postFocus(t.sessionId, t.cwd).catch((e) => log(`jump: focus entry: ${(e as Error).message}`));
    }
    if (t.folderUri) await vscode.env.openExternal(vscode.Uri.parse(t.folderUri));
    else await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(t.cwd), { forceNewWindow: true });
    return;
  }
  const pid = await agentPid(claudePath, t.sessionId);
  if (pid) {
    const term = await terminalRunning(pid);
    if (term) {
      term.show();
      return;
    }
  }
  const uri = t.sessionUri ?? `vscode://anthropic.claude-code/open?session=${encodeURIComponent(t.sessionId)}`;
  await vscode.env.openExternal(vscode.Uri.parse(uri));
}
