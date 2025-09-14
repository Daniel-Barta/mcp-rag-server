import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Start the MCP stdio transport.
 *
 * @param createServer Factory returning a new, unconnected MCP Server instance.
 * @returns Promise resolving once the server is connected over stdio.
 */
export async function startStdioTransport(createServer: () => Server) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
