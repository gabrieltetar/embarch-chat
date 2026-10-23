// A chat's history as the owner works with it (decision 75): a name
// given by hand, appended to the transcript Claude writes — nothing new is
// stored (decision 12).

import * as fs from "fs";

/**
 * Names a session Claude Code's own way when no process of it runs: the
 * `custom-title` line its panel appends to the transcript, which wins over
 * Claude's ai-title on every read (decision 12).
 */
export function appendTitle(file: string, sessionId: string, title: string): void {
  const st = fs.statSync(file);
  let lead = "";
  if (st.size > 0) {
    const fd = fs.openSync(file, "r");
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, st.size - 1);
      if (b[0] !== 10) lead = "\n";
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.appendFileSync(file, `${lead}${JSON.stringify({ type: "custom-title", sessionId, customTitle: title })}\n`);
}
