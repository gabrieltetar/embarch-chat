#!/usr/bin/env node
// A scripted stand-in for the CLI around a /compact, where no recording
// helps: a stopped or failed compaction is not something to record on
// purpose. `/compact` starts compacting and waits; an interrupt then ends
// that turn without a boundary, as a stopped turn does. With FC_FAIL the
// compaction ends at once in an error result instead. `auto` is a normal
// turn that auto-compacts on the way. FC_LOG: each line the client sends.
import * as fs from "node:fs";

const log = process.env.FC_LOG;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const o = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (log) fs.appendFileSync(log, JSON.stringify(o) + "\n");
    if (o.type === "control_request") {
      out({ type: "control_response", response: { subtype: "success", request_id: o.request_id, response: {} } });
      if (o.request.subtype === "interrupt") {
        out({ type: "system", subtype: "status", status: null });
        out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
        out({ type: "result", subtype: "error_during_execution", is_error: true });
      }
      continue;
    }
    if (o.type !== "user") continue;
    const text = typeof o.message.content === "string" ? o.message.content : "";
    out({ type: "user", isReplay: true, message: { role: "user", content: text } });
    if (text.startsWith("/compact")) {
      out({ type: "system", subtype: "status", status: "compacting" });
      if (process.env.FC_FAIL) out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["the compaction failed"] });
      continue;
    }
    out({ type: "system", subtype: "status", status: "requesting" });
    if (text === "auto") out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000 } });
    out({ type: "assistant", message: { id: "m" + Math.random(), role: "assistant", content: [{ type: "text", text: "ok: " + text }] } });
    out({ type: "result", subtype: "success", is_error: false });
  }
});
process.stdin.on("end", () => process.exit(0));
