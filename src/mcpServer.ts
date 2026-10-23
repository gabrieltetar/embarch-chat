// An MCP server of the panel's own, spoken to over the chat's stdio as
// `mcp_message` control requests (decision 65) — what the SDK's
// `createSdkMcpServer` is to Claude Code's panel, cut to tools: no process,
// no port, no lock file. Each message in is one JSON-RPC message; each
// reply is the JSON-RPC answer, or null for a notification.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** The tool's text result; a throw is a tool error Claude reads. */
  call: (args: Record<string, unknown>) => Promise<string>;
}

type Message = Record<string, unknown>;

/** The protocol version answered when the CLI names none. */
const PROTOCOL = "2025-06-18";

export function mcpServer(info: { name: string; version: string }, tools: McpTool[]): (m: Message) => Promise<Message | null> {
  return async (m) => {
    const id = m.id as string | number | undefined;
    const method = String(m.method ?? "");
    if (id === undefined) return null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const params = (m.params ?? {}) as Message;
    switch (method) {
      case "initialize":
        return ok({ protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: info });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: tools.map(({ call: _call, ...t }) => t) });
      case "tools/call": {
        const tool = tools.find((t) => t.name === params.name);
        if (!tool) return fail(-32602, `no tool ${String(params.name)}`);
        try {
          return ok({ content: [{ type: "text", text: await tool.call((params.arguments ?? {}) as Message) }] });
        } catch (e) {
          return ok({ content: [{ type: "text", text: (e as Error).message }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  };
}
