// A VS Code terminal's output, sent with a message (decision 58), read as
// Claude Code's panel reads it (2.1.309, `getTerminalContents`): VS Code
// gives an extension no way to read a terminal's buffer, so the terminal is
// shown, all of it selected and copied, and the clipboard put back as it
// was; the last 100 lines go. One read at a time: they share the
// clipboard.

import * as vscode from "vscode";

/** As many lines as Claude Code sends. */
export const TERMINAL_LINES = 100;

/** The window's terminals by name, for the @ list. */
export function terminalNames(): string[] {
  return [...new Set(vscode.window.terminals.map((t) => t.name))];
}

let queue: Promise<unknown> = Promise.resolve();

/** The last lines of the terminal named so, or null when it is gone or nothing could be copied. */
export function terminalOutput(name: string, log: (s: string) => void): Promise<string | null> {
  const run = queue.then(() => read(name, log));
  queue = run.catch(() => null);
  return run;
}

async function read(name: string, log: (s: string) => void): Promise<string | null> {
  const t = vscode.window.terminals.find((x) => x.name === name);
  if (!t) return null;
  const clip = vscode.env.clipboard;
  const saved = await clip.readText();
  // Claude Code reads whatever the clipboard then holds; a copy that did
  // not happen must not send the owner's own clipboard as the output.
  const marker = `embarch-chat:${Date.now()}:${Math.random()}`;
  try {
    await clip.writeText(marker);
    t.show();
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
