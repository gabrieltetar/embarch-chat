#!/usr/bin/env node
// A one-tool MCP server over stdio for record.mjs: its `pick_port` tool
// asks the client for input with an MCP elicitation (a form, or with
// ELICIT_MODE=url a link to open) and returns what came back. It is how the
// `elicit` recording gets the CLI to send the panel an `elicitation`
// control request (decision 66). No dependencies: JSON-RPC, one line each.

import { createInterface } from "node:readline";

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const mode = process.env.ELICIT_MODE === "url" ? "url" : "form";
/** Tool calls waiting on the client's answer, by our request id. */
const waiting = new Map();
let next = 1;

const FORM = {
  message: "Which serial port should the test use?",
  requestedSchema: {
    type: "object",
    properties: {
      port: { type: "string", title: "Serial port", description: "The board's console, e.g. /dev/ttyACM0" },
      baud: { type: "integer", title: "Baud rate", minimum: 9600, default: 115200 },
      parity: { type: "string", title: "Parity", enum: ["none", "even", "odd"] },
      verbose: { type: "boolean", title: "Verbose log" },
    },
    required: ["port"],
  },
};
const URL_ASK = { mode: "url", message: "Sign in to the test bench to continue.", url: "https://example.com/bench/sign-in", elicitationId: "bench-sign-in-1" };

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  // The client's answer to one of our requests.
  if (m.id !== undefined && !m.method) {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    const r = m.result ?? { action: "error", error: m.error?.message };
    send({ jsonrpc: "2.0", id: w, result: { content: [{ type: "text", text: `action=${r.action}${r.content ? ` content=${JSON.stringify(r.content)}` : ""}` }] } });
    return;
  }
  switch (m.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bench", version: "0.0.1" } } });
      return;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: { tools: [{ name: "pick_port", description: "Asks the user which serial port the test should use.", inputSchema: { type: "object", properties: {} } }] },
      });
      return;
    case "tools/call": {
      const id = `e${next++}`;
      waiting.set(id, m.id);
      send({ jsonrpc: "2.0", id, method: "elicitation/create", params: mode === "url" ? URL_ASK : FORM });
      return;
    }
    default:
      if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
