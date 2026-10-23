// Bench result cards (decision 15): the pure card data, without a webview.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

const serialCard = (lines) => core.benchCard("serial_log", { status: "done", result: JSON.stringify({ port: "COM7", lines }) });

test("a serial log with a crash marker is a FAIL, its line shown", () => {
  for (const line of [
    "ASSERTION FAIL [0] @ WEST_TOPDIR/zephyr/kernel/sem.c:136",
    "[00:00:01.000,000] <err> os: >>> ZEPHYR FATAL ERROR 4: Kernel panic on CPU 0",
    "[00:00:01.000,000] <err> os: ***** HARD FAULT *****",
    "[00:00:01.000,000] <err> os: ***** BUS FAULT *****",
    "HardFault at 0x0800123c",
    'assertion "len > 0" failed: file "src/main.c", line 12, function: main',
    "app: src/main.c:12: main: Assertion `len > 0' failed.",
    "assert failed: xQueueGenericSend queue.c:832",
    "thread 'main' panicked at src/main.rs:4:5",
    "Kernel panic - not syncing: Fatal exception",
    "Guru Meditation Error: Core  0 panic'ed (LoadProhibited).",
  ]) {
    const c = serialCard(["boot ok", line, "idle"]);
    assert.equal(c.ok, false, line);
    assert.equal(c.error, line.trim(), line);
  }
});

test("a serial log that only says asserted, assertion or no panic is not a FAIL", () => {
  for (const line of ["DRDY asserted, reading FIFO", "nRESET asserted for 10 ms", "CS asserted", "assertion checks enabled", "no panic, all good", "IRQ line deasserted", "fatal errors: 0"]) {
    const c = serialCard(["boot ok", line, "idle"]);
    assert.equal(c.ok, true, line);
    assert.equal(c.error, undefined, `${line}: nothing shown as an error`);
  }
  // An error line that is not a crash is shown, not judged.
  const c = serialCard(["boot ok", "<err> spi: transfer error -5", "idle"]);
  assert.equal(c.ok, true);
  assert.equal(c.error, "<err> spi: transfer error -5");
});
