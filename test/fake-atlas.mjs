#!/usr/bin/env node
// A stand-in `embarch-atlas` for the chat's tests: `refs --json` prints an
// `atlas_refs` document (embarch-atlas's refs verb) with invented sections of
// two documents, and never reads an atlas. Env: FAKE_ATLAS_LOG (a file each
// call appends its argv and cwd to), FAKE_ATLAS_FAIL (a stderr line: it exits
// 3 with it), FAKE_ATLAS_JUNK (1: it prints no JSON).

import * as fs from "node:fs";

if (process.env.FAKE_ATLAS_LOG) fs.appendFileSync(process.env.FAKE_ATLAS_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\n");
if (process.env.FAKE_ATLAS_FAIL) {
  process.stderr.write(`embarch-atlas: ${process.env.FAKE_ATLAS_FAIL}\n`);
  process.exit(3);
}
if (process.env.FAKE_ATLAS_JUNK) {
  process.stdout.write("not json\n");
  process.exit(0);
}
const sec = (doc, kind, part, id, title, page) => ({ doc, kind, part, id, title, level: 1, page });
process.stdout.write(
  JSON.stringify({
    atlas_refs: 1,
    atlas_dir: process.cwd(),
    atlas: "a1",
    commit: "abc",
    stale: [],
    sections: [
      sec("tps2595@A", "datasheet", "TPS2595", "7.3", "Protection features", 14),
      sec("tps2595@A", "datasheet", "TPS2595", "8.1", "Application information", 20),
      sec("nrf54l15-rm@B", "reference-manual", "nRF54L15", "6.2", "Clock control", 120),
      sec("nrf54l15-rm@B", "reference-manual", "nRF54L15", "6.9", "Protection of the peripheral bus", 131),
    ],
    symbols: [],
    nodes: [],
  }) + "\n",
);
