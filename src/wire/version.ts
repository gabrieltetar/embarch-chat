// The panel runs the `claude` on PATH (decision 30); outside the versions a
// panel release was tested with, it warns in one line and keeps working —
// refusing would let a CLI auto-update lock the owner out.

import * as cp from "child_process";

/** The range this release's wire tests ran against (test/fixtures/wire/ and a live smoke run). */
export const TESTED_RANGE = { min: "2.1.287", max: "2.1.308" };

export function parseVersion(s: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** One line when `claude --version` printed something outside the tested range, else null. */
export function versionWarning(output: string, range = TESTED_RANGE): string | null {
  const v = parseVersion(output);
  if (!v) return `Could not read the claude version ("${output.trim().slice(0, 40)}"); chats will try anyway.`;
  const lo = parseVersion(range.min)!;
  const hi = parseVersion(range.max)!;
  if (cmp(v, lo) < 0 || cmp(v, hi) > 0) {
    return `claude ${v.join(".")} is outside the versions this panel was tested with (${range.min}–${range.max}); it keeps working, but the wire may have moved.`;
  }
  return null;
}

export function claudeVersion(claudePath: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(claudePath, ["--version"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}
