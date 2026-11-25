#!/usr/bin/env node
// A stand-in `embarch-api` for the chat's tests: `--json list-instruments`
// prints `{success, instruments}` with an `eload` and a `psu`, and never
// reaches a Core. Env: FAKE_API_LOG (a file each call appends its argv and cwd
// to), FAKE_API_FAIL (a stderr line: it exits 3 with it), FAKE_API_JUNK (1: it
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
const inst = (name, port) => ({ name, protocol: "scpi", port, baud: 115200, tx_terminator: "\\n", rx_terminator: "\\n" });
process.stdout.write(JSON.stringify({ success: true, instruments: process.env.FAKE_API_NONE ? [] : [inst("eload", "COM7"), inst("psu", "COM8")] }) + "\n");
