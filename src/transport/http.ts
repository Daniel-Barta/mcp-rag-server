import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport, isInitializeRequest, Server } from "../mcp-sdk";

/**
 * Start the MCP HTTP transport using StreamableHTTPServerTransport.
 * Expects a factory that creates a fresh MCP Server instance per session.
 */
export async function startHttpTransport(createServer: () => Server) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const port = Number(process.env.MCP_PORT ?? 3000);
  const host = (process.env.HOST ?? "127.0.0.1").trim();
  const defaultAllowedHosts = (() => {
    const base = new Set<string>([
      "127.0.0.1",
      `127.0.0.1:${port}`,
      "localhost",
      `localhost:${port}`,
      host,
      `${host}:${port}`,
    ]);
    return Array.from(base);
  })();

  // sessionId -> transport
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: express.Request, res: express.Response) => {
    try {
      const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
      let transport: StreamableHTTPServerTransport | undefined = sessionId
        ? transports[sessionId]
        : undefined;

      if (!transport && !sessionId && isInitializeRequest(req.body as any)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport!;
          },
          // Stronger local security defaults
          enableDnsRebindingProtection:
            (process.env.ENABLE_DNS_REBINDING_PROTECTION ?? "true") !== "false",
          allowedHosts: (process.env.ALLOWED_HOSTS ?? defaultAllowedHosts.join(","))
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });

        const server = createServer();
        let closing = false;
        transport.onclose = () => {
          if (closing) return; // idempotent guard to avoid recursion
          closing = true;
          if (transport?.sessionId) delete transports[transport.sessionId];
          try {
            // Detach handler before calling server.close() because server.close()
            // will attempt transport.close(), which would re-trigger onclose.
            (transport as any).onclose = undefined;
            server.close();
          } catch {
            /* noop */
          }
        };
        await server.connect(transport);
      }

      if (!transport) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req as any, res as any, req.body);
    } catch (err) {
      console.error("[MCP] HTTP POST error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req as any, res as any);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.error(`[MCP] Streamable HTTP listening at http://${host}:${port}/mcp`);
      resolve();
    });
  });
}
