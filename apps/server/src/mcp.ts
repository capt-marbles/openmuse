import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { botOf, type McpServer } from "./bots.ts";
import type { Config } from "./config.ts";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function withClient<T>(server: McpServer, use: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(server.url);
  const requestInit = { headers: server.headers };
  const transport =
    server.transport === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  const client = new Client({ name: "openmuse", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function listMcpTools(server: McpServer): Promise<McpTool[]> {
  return withClient(server, async (client) =>
    (await client.listTools()).tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
    })),
  );
}

/** Calls one tool and returns its text output; a tool-reported error is thrown. */
export function callMcpTool(
  server: McpServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  return withClient(server, async (client) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String(part.text)
          : JSON.stringify(part),
      )
      .join("\n")
      .slice(0, 30000);
    if (result.isError) throw new Error(text || `${server.name}.${tool} failed`);
    return text;
  });
}

/** Runs an approved bot tool call, resolving the server and its credentials from config. */
export function runMcpAction(
  config: Config,
  data: { botId: string; server: string; tool: string; arguments: Record<string, unknown> },
): Promise<string> {
  const server = botOf(config, data.botId).mcpServers.find((item) => item.name === data.server);
  if (!server) throw new Error(`${data.botId} no longer has the ${data.server} server`);
  return callMcpTool(server, data.tool, data.arguments);
}
