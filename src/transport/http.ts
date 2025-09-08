/**
 * HTTP Transport bootstrap for the MCP RAG Server.
 *
 * This module exposes a single factory function `startHttpTransport` that starts an
 * Express application and wires it to the Model Context Protocol (MCP) SDK's
 * `StreamableHTTPServerTransport` in a per-session fashion.
 *
 * Session model:
 *  - A client begins by sending a JSON-RPC `initialize` request (per MCP spec) to POST /mcp
 *    WITHOUT an `mcp-session-id` header.
 *  - A new transport + MCP Server instance are created. A unique session id is generated
 *    (UUID v4) and (handled internally by the SDK) returned to the client via headers.
 *  - All subsequent HTTP requests for that session MUST include the same `mcp-session-id`
 *    header. For streaming / follow-up calls, the same transport instance is re-used.
 *  - When the transport or server closes, the session is evicted from the in-memory map.
 *
 * Endpoints:
 *  - POST /mcp    : JSON-RPC requests (initial + subsequent). Body must be JSON.
 *  - GET  /mcp    : Optional streaming / follow-up channel (delegated to transport).
 *  - DELETE /mcp  : Allows the client to request session teardown.
 *  - GET  /health : Lightweight status / readiness (delegates to `statusManager`).
 *
 * Security defaults (can be tuned via environment variables):
 *  - DNS rebinding protection is ENABLED unless `ENABLE_DNS_REBINDING_PROTECTION=false`.
 *  - Allowed hosts are restricted to 127.0.0.1 / localhost and the configured host/port
 *    unless overridden via `ALLOWED_HOSTS` (comma-separated list of host[:port]).
 *
 * Environment variables:
 *  MCP_PORT: Port to bind (number, default 3000)
 *  HOST: Interface / hostname to bind (default 127.0.0.1)
 *  ALLOWED_HOSTS: Comma-separated explicit host[:port] whitelist; if unset a secure
 *                 local-only default set is used.
 *  ENABLE_DNS_REBINDING_PROTECTION: Set to "false" to disable (NOT recommended).
 *
 * Error handling strategy:
 *  - Malformed / out-of-order session usage => 400 with JSON-RPC error (-32000).
 *  - Uncaught internal errors => 500 with JSON-RPC error (-32603).
 *
 * Implementation notes:
 *  - We keep a simple in-memory map `transports` keyed by session id. This is intentionally
 *    ephemeral; persistence / distributed coordination would require an alternate design.
 *  - The `onclose` handler is made idempotent and detaches itself before invoking
 *    `server.close()` to avoid recursive re-entrancy (since `server.close` may attempt to
 *    close the transport again inside the SDK).
 *  - Request objects are cast to `any` where the MCP SDK expects its own narrowed types.
 *
 * Possible future enhancements:
 *  - Pluggable session store (Redis / memory LRU) with TTL eviction.
 *  - Structured logging hooks (pino / winston) instead of console.error.
 *  - Metrics (Prometheus endpoint) for active sessions & request latency.
 *  - Rate limiting / auth middleware before reaching the transport.
 *
 * Minimal client (pseudo-code):
 *  const init = await fetch("http://127.0.0.1:3000/mcp", { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(initializeRequest) });
 *  const sessionId = init.headers.get("mcp-session-id");
 *  const next = await fetch("http://127.0.0.1:3000/mcp", { method: "POST", headers: {"content-type": "application/json", "mcp-session-id": sessionId}, body: JSON.stringify(nextRequest) });
 *
 * NOTE: Keep this file free of heavy business logic; it should remain a thin transport shim.
 */
import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { statusManager } from "../status";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * Start the streamable HTTP transport. Each distinct session (identified by
 * the generated session ID header) owns its own MCP Server + transport pair.
 *
 * Security: defaults restrict allowed hosts and enable DNS rebinding
 * protection unless explicitly disabled via environment variables.
 *
 * @param createServer Factory producing a fresh MCP Server instance per new session.
 */
/**
 * Bootstraps the Express HTTP server & per-session MCP transport layer.
 *
 * @param createServer Factory producing a new, unconnected MCP `Server` instance for each session.
 * @returns Resolves once the HTTP listener is bound and ready.
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
  /** Active session transports mapped by session id. */
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: express.Request, res: express.Response) => {
    try {
      const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
      let transport: StreamableHTTPServerTransport | undefined = sessionId
        ? transports[sessionId]
        : undefined;

      // Session creation path: only when no header AND the body is a valid initialize request.
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
          if (closing) return; // Idempotent guard to avoid recursion.
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

  /**
   * Shared handler for GET /mcp and DELETE /mcp where only an existing session
   * is valid. These routes delegate to the underlying transport (e.g. for
   * streaming or lifecycle control) and return 400 if the session id is
   * missing or unknown.
   */
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

  // Health / readiness endpoint
  app.get("/health", (_req, res) => {
    // Provide current server / embedding / indexing status (implementation in statusManager).
    res.json(statusManager.getStatus());
  });

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.error(`[MCP] Streamable HTTP listening at http://${host}:${port}/mcp`);
      resolve();
    });
  });
}
