// The rail's Usage icon (decision 99): what a `rate_limit_event` says of the
// plan's 5-hour session and week, the icon's level, and the window's newest
// reading. Invented readings; the event's shape is Claude Code 2.1.287's
// (`unifiedWindows.five_hour` / `.seven_day`, `{utilization, resetsAt}`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../test-out/core.js");

const W = (u, at = 1900000000) => ({ utilization: u, resetsAt: at });

test("both windows come from unifiedWindows, with their reset times", () => {
  const u = core.usageOf({ status: "allowed", resetsAt: 1900000000, rateLimitType: "five_hour", unifiedWindows: { five_hour: W(0.42, 1900001000), seven_day: W(0.61, 1900500000) } }, 7);
  assert.deepEqual(u, { session: { used: 0.42, resetsAt: 1900001000, at: 7 }, weekly: { used: 0.61, resetsAt: 1900500000, at: 7 }, status: "allowed", limit: "five_hour", grace: false, at: 7 });
});

test("without the windows, the one limit the event names still gives its own share; nothing else is made up", () => {
  const u = core.usageOf({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.83, resetsAt: 1900500000 }, 9);
  assert.deepEqual([u.session, u.weekly], [null, { used: 0.83, resetsAt: 1900500000, at: 9 }]);
  const bare = core.usageOf({ status: "allowed" });
  assert.deepEqual([bare.session, bare.weekly], [null, null]);
  assert.equal(core.usageOf({ nope: 1 }), null);
  assert.equal(core.usageOf(null), null);
  // A share out of range is clamped; a window without one is not a window.
  const odd = core.usageOf({ status: "allowed", unifiedWindows: { five_hour: { utilization: 1.4, resetsAt: 1 }, seven_day: { resetsAt: 2 } } });
  assert.deepEqual([odd.session.used, odd.weekly], [1, null]);
});

test("the icon: no reading, fine, amber from 70 %, red from 90 % or a limit hit", () => {
  const at = (s, w, extra = {}) => core.usageLevel(core.usageOf({ status: "allowed", unifiedWindows: { five_hour: W(s), seven_day: W(w) }, ...extra }));
  assert.equal(core.usageLevel(null), "none");
  assert.equal(at(0.2, 0.69), "ok");
  assert.equal(at(0.7, 0.1), "amber", "either window");
  assert.equal(at(0.1, 0.89), "amber");
  assert.equal(at(0.1, 0.9), "red");
  assert.equal(at(0.1, 0.1, { status: "rejected" }), "red", "a limit hit, whatever the shares");
  assert.equal(at(0.1, 0.1, { rateLimitGraceActive: true }), "red");
  assert.deepEqual([core.USAGE_AMBER, core.USAGE_RED], [0.7, 0.9]);
});

test("the window keeps the newest reading any chat heard, and says when it changes", () => {
  const s = new core.UsageStore();
  const seen = [];
  s.on("changed", () => seen.push(s.current.session.used));
  s.take({ status: "allowed", unifiedWindows: { five_hour: W(0.3), seven_day: W(0.5) } });
  s.take({ not: "a reading" });
  s.take({ status: "allowed", unifiedWindows: { five_hour: W(0.35), seven_day: W(0.5) } });
  assert.deepEqual(seen, [0.3, 0.35]);
});

test("each window is kept as last heard, with its own age: an event without unifiedWindows never blanks the other (review F15)", () => {
  const s = new core.UsageStore();
  s.take({ status: "allowed", unifiedWindows: { five_hour: W(0.3, 1900001000), seven_day: W(0.5, 1900500000) } });
  const first = s.current;
  // The one limit an event names, without the windows: that window moves, the other stays as it was.
  s.take({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.74, resetsAt: 1900002000 });
  assert.deepEqual(s.current.weekly, first.weekly, "the week stays, with the age it had");
  assert.deepEqual([s.current.session.used, s.current.session.resetsAt, s.current.status], [0.74, 1900002000, "allowed_warning"]);
  assert.ok(s.current.session.at >= first.weekly.at);
  // An event that names no window at all keeps both.
  s.take({ status: "allowed" });
  assert.deepEqual([s.current.session.used, s.current.weekly.used, s.current.status], [0.74, 0.5, "allowed"]);
  assert.deepEqual(core.mergeUsage(null, core.usageOf({ status: "allowed" }, 3)), core.usageOf({ status: "allowed" }, 3));
});
