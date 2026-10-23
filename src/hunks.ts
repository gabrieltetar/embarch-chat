// A proposed Edit or Write, change by change (decision 64): the owner keeps
// some of its changes in the diff tab and rejects the rest, and the
// permission is answered with an input that makes only the kept ones —
// Claude Code's accept/reject per hunk. Pure: diff.ts shows it.

/** One change: from line `at` of the file before, the lines `old` give way to `add`. */
export interface Hunk {
  at: number;
  old: string[];
  add: string[];
}

/** Past this many line pairs in the changed middle, it counts as one change (the table would cost too much). */
const MAX_CELLS = 4_000_000;

/** The changes from `before` to `after`, line by line, in order. */
export function lineHunks(before: string, after: string): Hunk[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length && !B.length) return [];
  const n = A.length;
  const m = B.length;
  if (n * m > MAX_CELLS) return [{ at: pre, old: A, add: B }];
  // The longest common subsequence from each pair on; equal lines split the changes.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      if (cur) out.push(cur);
      cur = null;
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      (cur ??= { at: pre + i, old: [], add: [] }).old.push(A[i++]);
    } else {
      (cur ??= { at: pre + i, old: [], add: [] }).add.push(B[j++]);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** `before` with only the kept changes made; `starts` is where each change begins in the result, by line. */
export function applyHunks(before: string, hunks: Hunk[], keep: boolean[]): { text: string; starts: number[] } {
  const a = before.split("\n");
  const out: string[] = [];
  const starts: number[] = [];
  let i = 0;
  hunks.forEach((h, k) => {
    while (i < h.at) out.push(a[i++]);
    starts.push(out.length);
    out.push(...(keep[k] ? h.add : h.old));
    i += h.old.length;
  });
  while (i < a.length) out.push(a[i++]);
  return { text: out.join("\n"), starts };
}

/** Whether a tool call can be taken change by change: a Write, or an Edit of one place in the file. */
export function perChange(name: string, input: Record<string, unknown>, before: string): boolean {
  if (name === "Write") return true;
  const old = String(input.old_string ?? "");
  return name === "Edit" && !input.replace_all && !!old && before.includes(old);
}

/**
 * The input that makes only the kept changes: the Write's content, or the
 * Edit's `new_string` for the same `old_string`. Null when nothing is kept
 * (that answer is a deny).
 */
export function keptInput(name: string, input: Record<string, unknown>, before: string, hunks: Hunk[], keep: boolean[]): Record<string, unknown> | null {
  if (!keep.some(Boolean)) return null;
  if (keep.every(Boolean)) return input;
  const { text } = applyHunks(before, hunks, keep);
  if (name === "Write") return { ...input, content: text };
  const old = String(input.old_string ?? "");
  const at = before.indexOf(old);
  const head = before.slice(0, at);
  const tail = before.slice(at + old.length);
  // Every change lies inside the replaced span, so what is around it stays.
  if (at < 0 || !text.startsWith(head) || !text.endsWith(tail) || text.length < head.length + tail.length) throw new Error("these changes cannot be sent as one Edit");
  return { ...input, new_string: text.slice(head.length, text.length - tail.length) };
}
