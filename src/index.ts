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

const EXCLUDED_FOLDERS = process.env.EXCLUDED_FOLDERS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean) ?? [
  // Common folders to exclude (customize via EXCLUDED_FOLDERS)
  "node_modules",
  "dist",
  "build",
  ".git",
  "target",
  "bin",
  "obj",
  ".cache",
  "coverage",
  ".nyc_output",
];

const VERBOSE = (() => {
  const v = (process.env.VERBOSE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

// Chunk sizing (optional env overrides; defaults 800 / 120)
const CHUNK_SIZE = (() => {
  const raw = process.env.CHUNK_SIZE?.trim();
  if (!raw) return 800;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.floor(n)) : 800; // clamp to sane upper bound
})();
const CHUNK_OVERLAP = (() => {
  const raw = process.env.CHUNK_OVERLAP?.trim();
  if (!raw) return 120;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(4000, Math.floor(n)) : 120;
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
  excludedFolders: EXCLUDED_FOLDERS,
  embeddings,
  verbose: VERBOSE,
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
  storePath: process.env.INDEX_STORE_PATH?.trim() || undefined,
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
            "Semantically search files under REPO_ROOT and return relevant chunks with metadata: id, path, snippet (chunk text), score, totalLines (original file lineCount), fileSize (bytes).",
          inputSchema: {
            type: "object",
            description: "RAG semantic search request parameters.",
            properties: {
              query: {
                type: "string",
                description:
                  "Natural language search query. Use concise, specific terms for best semantic matches.",
              },
              top_k: {
                type: "number",
                description:
                  "Maximum number of matches to return (1-50). Defaults to 5 if omitted.",
                minimum: 1,
                maximum: 50,
              },
            },
            required: ["query"],
          },
        },
        {
          name: "read_file",
          description: "Read a specific file (optionally a line range).",
          inputSchema: {
            type: "object",
            description: "Read file request parameters.",
            properties: {
              path: {
                type: "string",
                description: "Path to file relative to REPO_ROOT (use forward slashes).",
              },
              startLine: {
                type: "number",
                description:
                  "1-based starting line (inclusive). If omitted, starts at beginning of file.",
                minimum: 1,
              },
              endLine: {
                type: "number",
                description:
                  "1-based ending line (inclusive). If omitted, reads until end of file.",
                minimum: 1,
              },
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
        totalLines: r.d.lineCount,
        fileSize: r.d.fileSize,
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
