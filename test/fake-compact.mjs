#!/usr/bin/env node
// A scripted stand-in for the CLI around a /compact, where no recording
// helps: a stopped or failed compaction is not something to record on
// purpose. `/compact` starts compacting and waits; an interrupt then ends
// that turn without a boundary, as a stopped turn does. With FC_FAIL the
// compaction ends at once in an error result instead; with FC_OK it
// succeeds as CLI 2.1.287's does (boundary, "Compacted", a result naming
// the command, compact.jsonl), and with FC_UNNAMED too its result names
// no command, as an older CLI's might. `auto` is a normal turn that auto-compacts
// on the way; a message starting `slow` takes 300 ms. Messages are taken
// one at a time, in order, as the CLI's queue takes them; `set_model`
// echoes its line as the CLI does (effort.jsonl). FC_LOG: each line the
// client sends.
import * as fs from "node:fs";

const log = process.env.FC_LOG;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
let chain = Promise.resolve();
/** The turn running now: an interrupt ends it. */
let stop = null;

function turn(text) {
  return new Promise((done) => {
    out({ type: "user", isReplay: true, message: { role: "user", content: text } });
    if (text.startsWith("/compact")) {
      out({ type: "system", subtype: "status", status: "compacting" });
      if (process.env.FC_FAIL) {
        out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["the compaction failed"], local_command: "compact" });
        return done();
      }
      if (process.env.FC_OK) {
        out({ type: "system", subtype: "status", status: null, compact_result: "success" });
        out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1000 } });
        out({ type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } });
        out({ type: "result", subtype: "success", is_error: false, num_turns: 0, ...(process.env.FC_UNNAMED ? {} : { local_command: "compact" }) });
        return done();
      }
      stop = done;
      return;
    }
    out({ type: "system", subtype: "status", status: "requesting" });
    if (text === "auto") out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000 } });
    const finish = () => {
      out({ type: "assistant", message: { id: "m" + Math.random(), role: "assistant", content: [{ type: "text", text: "ok: " + text }] } });
      out({ type: "result", subtype: "success", is_error: false });
      done();
    };
    if (text.startsWith("slow")) setTimeout(finish, 300);
    else finish();
  });
}

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
      if (o.request.subtype === "set_model") out({ type: "user", isReplay: true, message: { role: "user", content: `<local-command-stdout>Set model to \`${o.request.model}\`</local-command-stdout>` } });
      if (o.request.subtype === "interrupt" && stop) {
        const done = stop;
        stop = null;
        out({ type: "system", subtype: "status", status: null });
        out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
        out({ type: "result", subtype: "error_during_execution", is_error: true });
        done();
      }
      continue;
    }
    if (o.type !== "user") continue;
    const text = typeof o.message.content === "string" ? o.message.content : "";
    chain = chain.then(() => turn(text));
  }
});
process.stdin.on("end", () => process.exit(0));
