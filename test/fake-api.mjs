#!/usr/bin/env node
// A stand-in `embarch-api` for the chat's tests: `--json list-instruments`
// prints `{success, instruments}` with an `eload` and a `psu`, `list-studies
// [--limit N]` prints three studies, and it never reaches a Core. Env:
// FAKE_API_LOG (a file each call appends its argv and cwd to), FAKE_API_FAIL (a stderr line: it exits 3 with it), FAKE_API_JUNK (1: it
// prints no JSON), FAKE_API_NONE (1: no instruments are declared).

import * as fs from "node:fs";

if (process.env.FAKE_API_LOG) fs.appendFileSync(process.env.FAKE_API_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\n");
if (process.env.FAKE_API_FAIL) {
  process.stderr.write(`embarch-api: ${process.env.FAKE_API_FAIL}\n`);
  process.exit(3);
}
if (process.env.FAKE_API_JUNK) {
  process.stdout.write("not json\n");
  process.exit(0);
}
if (process.argv.includes("list-studies")) {
  // Three studies, newest first as the verb sorts them; the oldest has unreadable taps (null).
  const at = (d) => Date.UTC(2026, 10, d, 10);
  const tap = (name, kind, rendered = true) => ({ name, encoding: kind, encoding_kind: kind, rendered });
  const all = [
    { study_id: "soak-300", study_name: "Soak run", status: "completed", started_utc_ms: at(25), ended_utc_ms: at(25) + 1000, taps: [tap("vbus", "samples"), tap("pd-trace", "outpost_trace"), tap("console", "text")], note: null },
    { study_id: "sweep-200", study_name: "PD sweep", status: "completed", started_utc_ms: at(24), ended_utc_ms: at(24) + 1000, taps: [tap("cc-trace", "outpost_trace", false), tap("vbus", "samples")], note: null },
    { study_id: "boot-100", study_name: "Boot check", status: "completed", started_utc_ms: at(20), ended_utc_ms: null, taps: null, note: "events.json unreadable" },
  ];
  const i = process.argv.indexOf("--limit");
  process.stdout.write(JSON.stringify({ success: true, keep: 50, studies: i > 0 ? all.slice(0, Number(process.argv[i + 1])) : all }) + "\n");
  process.exit(0);
}
const inst = (name, port) => ({ name, protocol: "scpi", port, baud: 115200, tx_terminator: "\\n", rx_terminator: "\\n" });
process.stdout.write(JSON.stringify({ success: true, instruments: process.env.FAKE_API_NONE ? [] : [inst("eload", "COM7"), inst("psu", "COM8")] }) + "\n");
