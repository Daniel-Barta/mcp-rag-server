/**
 * Application entry point: initializes environment/config, builds an in-memory
 * semantic index over the target repository, then starts either STDIO or
 * streamable HTTP MCP transport exposing RAG + read_file tools.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Embeddings } from "./embeddings";
import { Indexer } from "./indexer";
import { startHttpTransport } from "./transport/http";
import { startStdioTransport } from "./transport/stdio";
import { statusManager } from "./status";

// Centralized single dotenv.config() call.
// If executing compiled code inside build/, resolve ../.env (project root). Otherwise use default.
(() => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const rootEnv = path.resolve(__dirname, "../.env");
    if (fsSync.existsSync(rootEnv)) {
      dotenv.config({ path: rootEnv });
      return;
    }
  } catch {
    /* ignore and fall back */
  }
  dotenv.config();
})();

// Configure transformers cache directory ASAP, before any model/pipeline is created
await Embeddings.configureCache().catch((e) =>
  console.error("[MCP] Failed to set TRANSFORMERS cache directory:", e),
);

const ROOT = process.env.REPO_ROOT?.trim() || "C:/path/to/your/repository";
statusManager.setRepoRoot(ROOT);
const ALLOWED_EXT = process.env.ALLOWED_EXT?.split(",")
  .map((s) => s.trim())
  .filter(Boolean) ?? [
  // Common code/text extensions (customize via ALLOWED_EXT)
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "cs",
  "java",
  "kt",
  "kts",
  "go",
  "rs",
  "cpp",
  "c",
  "h",
  "hpp",
  "rb",
  "php",
  "swift",
  "scala",
  "md",
  "txt",
  "gradle",
  "groovy",
  "json",
  "yaml",
  "yml",
  "xml",
  "proto",
  "properties",
];

const VERBOSE = (() => {
  const v = (process.env.VERBOSE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

// Initialize embedding model (model name resolved internally). Errors surface
// early rather than lazily inside the first tool invocation.
const embeddings = new Embeddings();
await embeddings.init();
statusManager.setModelName(embeddings.getModelName());
// Instantiate indexer (will build below)
const indexer = new Indexer({
  root: ROOT,
  allowedExt: ALLOWED_EXT,
  embeddings,
  verbose: VERBOSE,
});

/**
 * Factory to construct a new MCP Server instance with tool handlers. A fresh
 * server is created per transport session (esp. for HTTP streamable sessions).
 */
function createServer() {
  const server = new Server(
    { name: "mcp-rag-server", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  // Tool discovery: list available tool names + schemas.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "rag_query",
          description:
            "Semantically search files under REPO_ROOT and return relevant snippets (path, snippet, score).",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              top_k: { type: "number" },
            },
            required: ["query"],
          },
        },
        {
          name: "read_file",
          description: "Read a specific file (optionally a line range).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              startLine: { type: "number" },
              endLine: { type: "number" },
            },
            required: ["path"],
          },
        },
      ],
    };
  });

  // Tool execution router (RAG similarity search + basic file read helper).
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    if (req.params.name === "rag_query") {
      const { query, top_k = 5 } = (req.params.arguments ?? {}) as any;
      if (!query) throw new McpError(ErrorCode.InvalidRequest, "Missing query");

      const qEmb = await embeddings.embed(String(query));
      const scored = indexer.getDocs().map((d) => ({ d, s: Embeddings.cosine(d.emb!, qEmb) }));
      scored.sort((a, b) => b.s - a.s);
      const top = scored.slice(0, Math.max(1, Math.min(50, top_k))).map((r) => ({
        path: r.d.path,
        score: Number(r.s.toFixed(4)),
        snippet: r.d.text,
      }));
      return { toolResult: { matches: top } };
    }

    if (req.params.name === "read_file") {
      const { path: rel, startLine, endLine } = (req.params.arguments ?? {}) as any;
      if (!rel) throw new McpError(ErrorCode.InvalidRequest, "Missing path");
      const abs = indexer.ensureWithinRoot(rel);
      const content = await fs.readFile(abs, "utf8");
      if (startLine != null || endLine != null) {
        const lines = content.split(/\r?\n/);
        const s = Math.max(0, (startLine ?? 1) - 1);
        const e = Math.min(lines.length, endLine ?? lines.length);
        return { toolResult: lines.slice(s, e).join("\n") };
      }
      return { toolResult: content };
    }

    throw new McpError(ErrorCode.MethodNotFound, "Unknown method");
  });

  return server;
}

// Build the semantic index (blocking startup until ready). The status manager
// tracks progress which can be polled (HTTP mode) via /health.
await indexer.build();

// Choose transport: stdio (default) or streamable HTTP via MCP_TRANSPORT=http|stdio
const transportEnv = (process.env.MCP_TRANSPORT ?? "").trim().toLowerCase();
const useHttp = transportEnv === "http" || transportEnv === "streamable-http";

if (useHttp) {
  statusManager.markTransport("http");
  await startHttpTransport(createServer);
} else {
  statusManager.markTransport("stdio");
  await startStdioTransport(createServer);
}
