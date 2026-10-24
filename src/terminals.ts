// A VS Code terminal's output, sent with a message (decision 58), read as
// Claude Code's panel reads it (2.1.309, `getTerminalContents`): VS Code
// gives an extension no way to read a terminal's buffer, so the terminal is
// shown, all of it selected and copied, and the clipboard put back as it
// was; the last 100 lines go. One read at a time: they share the
// clipboard. Unlike Claude Code's, a terminal is the one picked — by its
// process id, else its place in the list, not the first of its name — and
// it is shown without taking focus, so keys typed meanwhile stay in the
// panel's input and never reach the shell (review r4 L2). The clipboard's
// text is put back; anything else on it (an image) cannot be, and the
// chip says so.

import * as vscode from "vscode";
import type { TerminalRef } from "../webview/shared/protocol";

/** As many lines as Claude Code sends. */
export const TERMINAL_LINES = 100;

/** A terminal's process id, or undefined when it has none (an extension's pseudoterminal) or does not say within a second. */
function pidOf(t: vscode.Terminal): Promise<number | undefined> {
  return Promise.race([
    Promise.resolve(t.processId).then((p) => (typeof p === "number" ? p : undefined)),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000).unref?.()),
  ]);
}

/** The window's terminals, every one, for the @ list. */
export async function terminalRefs(): Promise<TerminalRef[]> {
  return Promise.all(
    vscode.window.terminals.map(async (t, index) => {
      const pid = await pidOf(t);
      return { name: t.name, index, ...(pid !== undefined ? { pid } : {}) };
    }),
  );
}

/** The terminal the @ list offered: the one with that process id, else the one at that place still of that name and with none. */
async function find(ref: TerminalRef): Promise<vscode.Terminal | undefined> {
  const ts = vscode.window.terminals;
  if (typeof ref.pid === "number") {
    for (const t of ts) if ((await pidOf(t)) === ref.pid) return t;
    return undefined;
  }
  const t = ts[ref.index];
  return t && t.name === ref.name && (await pidOf(t)) === undefined ? t : undefined;
}

let queue: Promise<unknown> = Promise.resolve();

/** The last lines of the terminal, or null when it is gone or nothing could be copied. */
export function terminalOutput(ref: TerminalRef, log: (s: string) => void): Promise<string | null> {
  const run = queue.then(() => read(ref, log));
  queue = run.catch(() => null);
  return run;
}

async function read(ref: TerminalRef, log: (s: string) => void): Promise<string | null> {
  const t = await find(ref);
  const name = ref.name;
  if (!t) return null;
  const clip = vscode.env.clipboard;
  const saved = await clip.readText();
  // Claude Code reads whatever the clipboard then holds; a copy that did
  // not happen must not send the owner's own clipboard as the output.
  const marker = `embarch-chat:${Date.now()}:${Math.random()}`;
  try {
    await clip.writeText(marker);
    // Shown so that it is the active terminal the copy reads, but the focus
    // stays where the owner types (Claude Code's own `show()` takes it).
    t.show(true);
    await vscode.commands.executeCommand("workbench.action.terminal.selectAll");
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    await vscode.commands.executeCommand("workbench.action.terminal.clearSelection");
    const got = await clip.readText();
    if (got === marker) {
      log(`terminal "${name}": nothing copied`);
      return null;
    }
    const lines = got.replace(/\s+$/, "").split(/\r?\n/);
    return lines.slice(-TERMINAL_LINES).join("\n");
  } catch (e) {
    log(`terminal "${name}": ${(e as Error).message}`);
    return null;
  } finally {
    await clip.writeText(saved);
  }
}
