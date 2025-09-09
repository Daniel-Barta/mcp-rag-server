/**
 * Application entry point.
 *
 * High‑level flow:
 * 1. Load environment configuration (supports running from src/ or build/).
 * 2. Configure local on-disk cache for transformer / embedding artifacts.
 * 3. Parse and normalize all runtime configuration (env-driven knobs).
 * 4. Initialize the embedding model eagerly so the first tool call is fast.
 * 5. Recursively walk the target repository, chunk files, embed, and build an
 *    in‑memory semantic index (optionally persisted if INDEX_STORE_PATH set).
 * 6. Start a Model Context Protocol (MCP) server over either:
 *      - STDIO (default): good for local editor integration.
 *      - Streamable HTTP (MCP_TRANSPORT=http|streamable-http): enables polling
 *        /health for readiness & status.
 *
 * Exposed tools:
 *  - rag_query : Vector similarity search returning top matching code/text chunks.
 *  - read_file : Targeted file (or line range) retrieval for follow‑up inspection.
 *
 * Design goals:
 *  - Zero external DB: all embeddings live in process (optionally disk cache for reuse).
 *  - Fast cold start for modest repos; linear scan + embedding upfront for predictability.
 *  - Minimal, explicit environment surface area (documented below).
 *
 * ENVIRONMENT VARIABLES (all optional unless marked required):
 *  - REPO_ROOT            Absolute path to repository root to index. Default placeholder.
 *  - ALLOWED_EXT          Comma list of file extensions to include (no leading dots).
 *  - EXCLUDED_FOLDERS     Comma list of folder names to skip during indexing.
 *  - VERBOSE              If '1'/'true'/etc enables extra logging during indexing.
 *  - CHUNK_SIZE           Max characters per text chunk (default 800, hard cap 8000).
 *  - CHUNK_OVERLAP        Overlap characters between adjacent chunks (default 120).
 *  - FOLDER_INFO_NAME     Display name used in tool descriptions (default 'REPO_ROOT').
 *  - INDEX_STORE_PATH     If set, path to persist / reload serialized index artifacts.
 *  - MCP_TRANSPORT        'stdio' (default) or 'http'/'streamable-http'.
 *  - TRANSFORMERS_CACHE   Directory for model downloads (set by Embeddings.configureCache()).
 *
 * NOTE: This file intentionally keeps business logic thin; heavy lifting is delegated
 * to Embeddings + Indexer. That separation simplifies future swaps (different models,
 * alt persistence backends, streaming chunk generation, etc.).
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
// Keeping this logic isolated avoids multiple dotenv loads & accidental override order issues.
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

// Configure transformers cache directory ASAP, before any model/pipeline is created.
// Doing this early ensures downstream libraries (e.g. HuggingFace) honor the path.
await Embeddings.configureCache().catch((e) =>
  console.error("[MCP] Failed to set TRANSFORMERS cache directory:", e),
);

// Canonical repository root. If unset we keep a conspicuous placeholder to nudge configuration.
const ROOT = process.env.REPO_ROOT?.trim() || "C:/path/to/your/repository";
statusManager.setRepoRoot(ROOT);
// Normalize ALLOWED_EXT once; downstream components assume a clean string[].
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

// Folder names (not globs) pruned early during directory traversal.
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

// Verbosity toggle with tolerant truthy parsing (supports several common forms).
const VERBOSE = (() => {
  const v = (process.env.VERBOSE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

// Chunk sizing (optional env overrides; defaults 800 / 120)
// Chunk size impacts recall (too large) vs. precision (too small). Trade‑off is tunable.
const CHUNK_SIZE = (() => {
  const raw = process.env.CHUNK_SIZE?.trim();
  if (!raw) return 800;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.floor(n)) : 800; // clamp to sane upper bound
})();
// Overlap helps preserve context continuity across semantic chunks.
const CHUNK_OVERLAP = (() => {
  const raw = process.env.CHUNK_OVERLAP?.trim();
  if (!raw) return 120;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(4000, Math.floor(n)) : 120;
})();

// Human‑friendly label used purely in tool descriptions; does not affect disk paths.
const FOLDER_INFO_NAME = process.env.FOLDER_INFO_NAME?.trim() || "REPO_ROOT";

// Initialize embedding model (model name resolved internally). Errors surface
// early rather than lazily inside the first tool invocation, improving debuggability
// for mis‑configured model environments.
const embeddings = new Embeddings();
await embeddings.init();
statusManager.setModelName(embeddings.getModelName());
// Instantiate indexer (build happens below; may hydrate from INDEX_STORE_PATH if supported).
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
 * Factory to construct a new MCP Server instance with tool handlers.
 *
 * A fresh server instance is created per transport session (important for HTTP
 * streamable mode where multiple independent clients may connect). The shared
 * semantic index + embeddings are closed over from the outer scope to avoid
 * re‑building expensive state per session.
 *
 * Tool contracts:
 *  rag_query
 *    Input:  { query: string, top_k?: number }
 *    Output: { matches: Array<{ path: string, score: number, snippet: string, totalLines: number, fileSize: number }> }
 *    Errors: InvalidRequest if query missing.
 *
 *  read_file
 *    Input:  { path: string, startLine?: number, endLine?: number }
 *    Output: string (entire file or requested 1‑based inclusive line range)
 *    Errors: InvalidRequest if path missing; MethodNotFound for unknown tool names.
 *
 * Security considerations:
 *  - Path traversal is prevented by Indexer.ensureWithinRoot (throws if outside ROOT).
 *  - Only whitelisted extensions were embedded; read_file may still read any file under ROOT
 *    (could be narrowed further if desired by reusing ALLOWED_EXT filter there too).
 */
function createServer() {
  const server = new Server(
    { name: "mcp-rag-server", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  // Tool discovery: list available tool names + schemas.
  // Tool discovery endpoint — returns static schemas (cheap & synchronous aside from signature).
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "rag_query",
          description: `Semantically search files under '${FOLDER_INFO_NAME}' folder and return relevant chunks with metadata: id, path, snippet (chunk text), score, totalLines (original file lineCount), fileSize (bytes).`,
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
                description: `Path to file relative to '${FOLDER_INFO_NAME}' folder (use forward slashes).`,
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

  // Tool execution router: branch on tool name. Keep logic compact; heavy work delegated.
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    if (req.params.name === "rag_query") {
      const { query, top_k = 5 } = (req.params.arguments ?? {}) as any;
      if (!query) throw new McpError(ErrorCode.InvalidRequest, "Missing query");

      // Embed query once then compute cosine similarity against all chunk vectors (in‑memory scan).
      // For mid/large repos this could evolve to an ANN structure (e.g. HNSW) or WASM accelerated BLAS.
      const qEmb = await embeddings.embed(String(query));
      const scored = indexer.getDocs().map((d) => ({ d, s: Embeddings.cosine(d.emb!, qEmb) }));
      scored.sort((a, b) => b.s - a.s); // descending score
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
      const abs = indexer.ensureWithinRoot(rel); // throws on traversal escape attempt
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

// Build the semantic index (blocking startup until ready).
// Status manager exposes progress snapshots consumed by /health (HTTP mode) so
// clients can wait for readiness before issuing tool calls.
//
// Future extension ideas:
//  - Incremental watch mode (fs events) to re-embed changed files.
//  - On-demand lazy embedding to reduce cold start for huge monorepos.
await indexer.build();

// Choose transport: stdio (default) or streamable HTTP via MCP_TRANSPORT=http|stdio
// HTTP mode enables readiness probing & potential horizontal scaling (each process
// maintaining its own in‑memory index) behind a load balancer.
const transportEnv = (process.env.MCP_TRANSPORT ?? "").trim().toLowerCase();
const useHttp = transportEnv === "http" || transportEnv === "streamable-http";

if (useHttp) {
  statusManager.markTransport("http");
  await startHttpTransport(createServer);
} else {
  statusManager.markTransport("stdio");
  await startStdioTransport(createServer);
}
