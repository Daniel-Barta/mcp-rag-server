import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Start the MCP stdio transport.
 * Expects a factory that creates a fresh MCP Server instance.
 */
export async function startStdioTransport(createServer: () => Server) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
