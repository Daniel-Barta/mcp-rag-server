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
import fs from "node:fs/promises";
import path from "node:path";
import { Embeddings } from "./embeddings";
import { Indexer } from "./indexer";
import { startHttpTransport } from "./transport/http";
import { startStdioTransport } from "./transport/stdio";
import { statusManager } from "./status";
import { getConfig, Config } from "./config";

const config: Config = await getConfig();
const {
  ROOT,
  ALLOWED_EXT,
  EXCLUDED_FOLDERS,
  VERBOSE,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  FOLDER_INFO_NAME,
  INDEX_STORE_PATH,
  MCP_TRANSPORT,
} = config;

statusManager.setRepoRoot(ROOT);

// Tool argument interfaces
interface RagQueryArgs {
  query: string;
  top_k?: number;
}
interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}
interface ListFilesArgs {
  /** Directory relative to ROOT to list. Omit or use "." for repo root. */
  dir?: string;
  /** Whether to recurse into subfolders (default false). */
  recursive?: boolean;
  /** Maximum recursion depth (only when recursive=true). 0 = only the dir itself. */
  maxDepth?: number;
  /** Optional list of extensions (no leading dot) to include (files only). */
  includeExtensions?: string[];
  /** Maximum number of total entries (files + dirs) to return. Default 500. */
  limit?: number;
}

// Configure transformers cache directory ASAP, before any model/pipeline is created.
// Doing this early ensures downstream libraries (e.g. HuggingFace) honor the path.
await Embeddings.configureCache().catch((e) =>
  console.error("[MCP] Failed to set TRANSFORMERS cache directory:", e),
);

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
  storePath: INDEX_STORE_PATH,
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
          description: `Read a specific file under '${FOLDER_INFO_NAME}' folder (optionally a line range).`,
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
        {
          name: "list_files",
          description: `List files (and subdirectories) within a directory under '${FOLDER_INFO_NAME}' folder. Supports optional recursion, depth limit, and extension filtering. Returned paths are always relative to '${FOLDER_INFO_NAME}'.`,
          inputSchema: {
            type: "object",
            description: "List directory contents parameters.",
            properties: {
              dir: {
                type: "string",
                description: "Directory path relative to root. Omit or '.' for repository root.",
              },
              recursive: {
                type: "boolean",
                description: "Recurse into subdirectories (default false).",
              },
              maxDepth: {
                type: "number",
                description:
                  "Maximum recursion depth when recursive=true (default unlimited). Depth 0 lists only the directory itself.",
                minimum: 0,
              },
              includeExtensions: {
                type: "array",
                description:
                  "Optional whitelist of file extensions (no leading dots). If provided, only files with these extensions are returned.",
                items: { type: "string" },
              },
              limit: {
                type: "number",
                description:
                  "Maximum number of entries to return (files + dirs). Default 500; hard cap 5000.",
                minimum: 1,
              },
            },
          },
        },
      ],
    };
  });

  // Tool execution router: branch on tool name. Keep logic compact; heavy work delegated.
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    if (req.params.name === "rag_query") {
      const { query, top_k = 5 } = (req.params.arguments ?? {}) as RagQueryArgs;
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
      const { path: rel, startLine, endLine } = (req.params.arguments ?? {}) as ReadFileArgs;
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

    if (req.params.name === "list_files") {
      const {
        dir = ".",
        recursive = false,
        maxDepth,
        includeExtensions,
        limit = 500,
      } = (req.params.arguments ?? {}) as ListFilesArgs;

      // Basic validation
      const cap = Math.min(5000, Math.max(1, limit));
      // Normalize the requested directory path without stripping leading dots on real names
      // Previous implementation used: dir.replace(/^\.\/?/, "") which incorrectly turned
      // ".git" into "git" (same for any dot‑prefixed folder), making it impossible to list
      // hidden folders. We only collapse a solitary "." or leading "./" now.
      let normalizedDir: string;
      if (dir === "." || dir === "./") {
        normalizedDir = ""; // repository root
      } else if (dir.startsWith("./")) {
        normalizedDir = dir.slice(2); // drop leading ./
      } else if (/^[\\/]/.test(dir)) {
        // Trim a single leading slash/backslash if user provided an absolute-looking root ref
        normalizedDir = dir.replace(/^[\\/]+/, "");
      } else {
        normalizedDir = dir; // keep dot‑prefixed names like .git, .vscode, etc.
      }
      const absBase = indexer.ensureWithinRoot(normalizedDir);
      // Confirm it's a directory
      let st: any;
      try {
        st = await fs.stat(absBase);
      } catch {
        throw new McpError(ErrorCode.InvalidRequest, "Directory does not exist");
      }
      if (!st.isDirectory()) {
        throw new McpError(ErrorCode.InvalidRequest, "Path is not a directory");
      }

      const extsSet = includeExtensions?.length
        ? new Set(includeExtensions.map((e) => e.toLowerCase().replace(/^\./, "")))
        : null;

      type Entry = { path: string; type: "file" | "dir"; size?: number };
      const out: Entry[] = [];

      async function walk(currentAbs: string, depth: number) {
        if (out.length >= cap) return; // respect limit
        let dirents: any[];
        try {
          dirents = await fs.readdir(currentAbs, { withFileTypes: true });
        } catch {
          return; // unreadable directory
        }
        for (const d of dirents) {
          if (out.length >= cap) break;
          // Compute relative path using platform-agnostic forward slashes
          const relAbs = path.join(currentAbs, d.name);
          const relToRoot = path.relative(ROOT, relAbs).split(path.sep).join("/");
          if (d.isDirectory()) {
            // If an extension whitelist is active, suppress directory entries in results
            // (still traverse them when recursion is enabled).
            if (!extsSet) {
              out.push({ path: relToRoot, type: "dir" });
            }
            if (recursive) {
              const nextDepth = depth + 1;
              if (maxDepth == null || nextDepth <= maxDepth) {
                await walk(relAbs, nextDepth);
              }
            }
          } else if (d.isFile()) {
            const ext = d.name.includes(".") ? d.name.split(".").pop()!.toLowerCase() : "";
            if (extsSet && !extsSet.has(ext)) continue;
            try {
              const fst = await fs.stat(relAbs);
              out.push({ path: relToRoot, type: "file", size: fst.size });
            } catch {
              /* ignore file stat errors */
            }
          }
        }
      }

      await walk(absBase, 0);
      // deterministic alphabetical ordering (directories first, then files)
      out.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
      return { toolResult: { entries: out } };
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
const transportEnv = MCP_TRANSPORT;
const useHttp = transportEnv === "http" || transportEnv === "streamable-http";

if (useHttp) {
  statusManager.markTransport("http");
  await startHttpTransport(createServer);
} else {
  statusManager.markTransport("stdio");
  await startStdioTransport(createServer);
}
