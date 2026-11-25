#!/usr/bin/env node
// A stand-in `embarch-atlas` for the chat's tests: `refs --json` prints an
// `atlas_refs` document (embarch-atlas's refs verb) with invented sections of
// two documents, and never reads an atlas. Env: FAKE_ATLAS_LOG (a file each
// call appends its argv and cwd to), FAKE_ATLAS_FAIL (a stderr line: it exits
// 3 with it), FAKE_ATLAS_JUNK (1: it prints no JSON), FAKE_ATLAS_STALE (1: the
// atlas is behind its commit), FAKE_ATLAS_NOATLAS (1: documents, no built atlas).

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
const built = !process.env.FAKE_ATLAS_NOATLAS;
const sec = (doc, kind, part, id, title, page) => ({ doc, kind, part, id, title, level: 1, page });
process.stdout.write(
  JSON.stringify({
    atlas_refs: 1,
    atlas_dir: process.cwd(),
    atlas: built ? "a1" : null,
    commit: built ? "abc" : null,
    stale: built && process.env.FAKE_ATLAS_STALE ? ["the repo is at def, the atlas at abc"] : [],
    sections: [
      sec("tps2595@A", "datasheet", "TPS2595", "7.3", "Protection features", 14),
      sec("tps2595@A", "datasheet", "TPS2595", "8.1", "Application information", 20),
      sec("nrf54l15-rm@B", "reference-manual", "nRF54L15", "6.2", "Clock control", 120),
      sec("nrf54l15-rm@B", "reference-manual", "nRF54L15", "6.9", "Protection of the peripheral bus", 131),
    ],
    symbols: built
      ? [
          { name: "SHELL_HISTORY", prompt: "Enable shell history", type: "bool" },
          { name: "SHELL_CMD_BUFF_SIZE", prompt: "Shell command buffer size", type: "int" },
          { name: "I2C", prompt: "I2C bus drivers", type: "bool" },
          { name: "HIDDEN", prompt: null, type: "int" },
        ]
      : [],
    nodes: built
      ? [
          { path: "/soc/i2c@40003000", labels: ["i2c0"], compats: ["nordic,nrf-twim"], status: "okay", aliases: [] },
          { path: "/soc/i2c@40004000", labels: ["i2c1"], compats: ["nordic,nrf-twim"], status: "okay", aliases: ["sensor-bus"] },
          { path: "/leds/led_0", labels: [], compats: ["gpio-leds"], status: "okay", aliases: [] },
        ]
      : [],
  }) + "\n",
);
