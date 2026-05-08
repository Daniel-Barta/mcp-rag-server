import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Start the MCP stdio transport.
 *
 * @param createServer Factory returning a new, unconnected MCP Server instance.
 * @returns Promise resolving once the server is connected over stdio.
 */
export async function startStdioTransport(createServer: () => McpServer) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
