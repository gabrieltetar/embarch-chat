// Bench results as card data (decision 15): an embarch-api build, flash,
// bootload, study or serial_log result becomes pass or fail, the board, the
// first error, steps passed and a link into embarch-ui — read from the tool
// result already in the stream, nothing polled. The result shapes are
// embarch-api's own (its interfaces/tools-*.md): one JSON object as text, or
// prose for an error raised before there was an object. Pure, so the node
// tests run it; bench.tsx draws it.

import type { ToolEntry } from "../../src/wire/reducer";

const API = /^mcp__(?:.*?[_-])?embarch-api__(\w+)$/;

/**
 * A line that says the firmware stopped: an assert failure, a panic, a
 * hard fault, a fatal error. Whole markers, not words — firmware logs say
 * a pin is "asserted" all the time, and "assertion checks enabled" or "no
 * panic" is no crash.
 */
const CRASH = [
  /\bASSERTION FAIL\b/, // Zephyr's __ASSERT: "ASSERTION FAIL [x] @ file:line"
  /\bassert(?:ion)?\s+failed\b/i, // "assert failed", "Assertion failed"
  /\bassertion\s+(?:"[^"\n]*"|`[^'\n]*')\s+failed\b/i, // newlib's assertion "x" failed, glibc's Assertion `x' failed
  /\bFATAL ERROR\b/, // Zephyr's ">>> ZEPHYR FATAL ERROR n: ..."
  /\*{3,}\s*[A-Z ]*\bFAULT\s*\*{3,}/, // Zephyr's "***** HARD FAULT *****", BUS, MPU, USAGE
  /\bhard ?fault\b/i, // "HardFault", "Hard fault"
  /\bkernel (?:panic|oops)\b/i,
  /\bpanicked at\b/, // Rust
  /\bGuru Meditation Error\b/, // ESP-IDF
];

/** Whether a log line is one of the crash markers above. */
export function isCrashLine(line: string): boolean {
  return CRASH.some((r) => r.test(line));
}

export function benchTool(name: string): string | null {
  return API.exec(name)?.[1] ?? null;
}

type J = Record<string, unknown> & {
  target?: { board?: string; app?: string; chip?: string; dev_bench?: boolean };
  build?: J;
};

function parse(text: string | undefined): J | null {
  if (!text) return null;
  const s = text.trim();
  if (!s.startsWith("{")) return null;
  try {
    return JSON.parse(s) as J;
  } catch {
    return null;
  }
}

/** The line a person would look at first: a compiler's `error:`, else a failure word, else the last line. */
export function firstError(text: unknown): string | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    lines.find((l) => /\berror\b\s*[:(]/i.test(l) || /^error\b/i.test(l)) ??
    lines.find((l) => /\b(fatal|failed|failure|undefined reference|assert(ion)?|panic|hardfault|refus\w+)\b/i.test(l)) ??
    lines[lines.length - 1]
  );
}

export interface BenchCardData {
  ok: boolean | null;
  title: string;
  board?: string;
  error?: string;
  steps?: string;
  detail: string[];
  link?: { label: string; hash: string };
  log?: string[];
}

const TITLES: Record<string, string> = {
  build: "Build",
  build_dev_bench: "Build (dev bench)",
  flash: "Flash",
  flash_dev_bench: "Flash (dev bench)",
  build_and_flash: "Build and flash",
  build_and_flash_dev_bench: "Build and flash (dev bench)",
  bootload: "Bootload",
  build_and_bootload: "Build and bootload",
  run_study: "Study",
  study_status: "Study",
  serial_log: "Serial log",
};

/** Whether a tool's result becomes a card: such a call stands alone, never folded into a run of steps (decision 50). */
export function hasBenchCard(name: string): boolean {
  const tool = benchTool(name);
  return tool !== null && tool in TITLES;
}

function board(j: J | null | undefined): string | undefined {
  const t = j?.target ?? j?.build?.target;
  if (!t) return undefined;
  return [t.board, t.app].filter(Boolean).join(" · ") || t.chip;
}

export function benchCard(tool: string, t: Pick<ToolEntry, "status" | "result">): BenchCardData | null {
  if (!(tool in TITLES)) return null;
  const title = TITLES[tool];
  if (t.status === "running" || t.status === "awaiting") return { ok: null, title, detail: ["running…"] };
  const j = parse(t.result);
  const failed = t.status === "error" || t.status === "denied";
  if (!j) return { ok: !failed && t.status === "done", title, error: failed ? firstError(t.result) : undefined, detail: failed ? [] : [String(t.result ?? "").slice(0, 200)] };
  const detail: string[] = [];
  const card: BenchCardData = { ok: !failed, title, board: board(j), detail, link: { label: "embarch-ui", hash: "debug" } };
  switch (tool) {
    case "build":
    case "build_dev_bench":
      card.ok = j.success === true && !failed;
      if (!card.ok) card.error = (j.timed_out ? "timed out" : undefined) ?? firstError(j.stderr) ?? firstError(j.stdout);
      if (j.exit_code !== undefined && j.exit_code !== 0) detail.push(`exit ${j.exit_code}`);
      if (typeof j.warning === "string") detail.push(j.warning);
      break;
    case "flash":
    case "flash_dev_bench":
      card.ok = j.flashed !== false && !failed;
      if (j.chip) detail.push(String(j.chip));
      break;
    case "build_and_flash":
    case "build_and_flash_dev_bench": {
      const b = j.build ?? j;
      const built = b.exit_code === 0 && b.timed_out !== true;
      card.ok = j.success === true && !failed;
      card.steps = `build ${built ? "✓" : "✗"} · flash ${card.ok ? "✓" : built ? "✗" : "–"}`;
      const reason = typeof j.reason === "string" ? j.reason : undefined;
      if (!card.ok) card.error = built ? reason : (firstError(b.stderr) ?? firstError(b.stdout) ?? reason);
      if (j.chip) detail.push(String(j.chip));
      break;
    }
    case "bootload":
    case "build_and_bootload":
      card.ok = j.success === true && !failed;
      if (typeof j.bytes === "number") detail.push(`${Math.round((j.bytes as number) / 1024)} KB`);
      if (j.entered_via) detail.push(String(j.entered_via));
      if (j.app_reappeared === false) detail.push("the application did not come back");
      if (typeof j.warning === "string") card.error = j.warning;
      break;
    case "run_study":
      card.ok = !failed;
      card.link = { label: "Live Study", hash: `live-study?study=${encodeURIComponent(String(j.study_id ?? ""))}` };
      if (j.study_id) detail.push(`study ${j.study_id}`);
      if (j.reflashed) detail.push("reflashed");
      break;
    case "study_status": {
      const st = String(j.status ?? "");
      card.ok = st === "completed" ? true : st === "failed" ? false : null;
      if (typeof j.current_step === "number" && typeof j.total_steps === "number") card.steps = `${j.current_step} of ${j.total_steps} steps`;
      if (j.reason) card.error = String(j.reason);
      detail.push(st);
      card.link = { label: "Live Study", hash: "live-study" };
      break;
    }
    case "serial_log": {
      const lines = Array.isArray(j.lines) ? (j.lines as unknown[]).map(String) : [];
      // The firmware stopped: an assert, a panic, a fault, a fatal error. A
      // log that holds one is a failed run whatever the tool call said; any
      // other error line is shown, not judged.
      const crash = lines.find(isCrashLine);
      card.ok = !failed && !crash;
      if (j.port) detail.push(String(j.port));
      detail.push(`${lines.length} lines`);
      // An error-looking line is shown; "asserted" or "panic" in passing is not one.
      const bad = crash ?? lines.find((l) => /\b(error|err|fail\w*|fault)\b/i.test(l));
      if (bad) card.error = bad.trim();
      card.log = lines.slice(-8);
      break;
    }
  }
  return card;
}
