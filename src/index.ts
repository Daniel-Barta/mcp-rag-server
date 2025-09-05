import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { pipeline, env } from "@xenova/transformers";

type Doc = {
  id: string;
  path: string;
  chunk: number;
  text: string;
  emb?: Float32Array;
};

// Load environment variables from .env (support both CWD and project root when running from build/)
dotenv.config();
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
} catch {}

// Configure transformers cache directory ASAP, before any model/pipeline is created
try {
  const cacheDir = (process.env.TRANSFORMERS_CACHE || "").trim() || path.resolve(process.cwd(), ".cache/transformers");
  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
  // Tell @xenova/transformers to use this cache
  env.useBrowserCache = false; // ensure filesystem cache in Node
  env.cacheDir = cacheDir;
  // Optional: allow local models if the user places them there
  env.allowLocalModels = true;
  console.error(`[MCP] Using TRANSFORMERS cache at: ${env.cacheDir}`);
} catch (e) {
  console.error("[MCP] Failed to set TRANSFORMERS cache directory:", e);
}

const ROOT = process.env.REPO_ROOT?.trim() || "C:/path/to/your/repository";
const ALLOWED_EXT = (process.env.ALLOWED_EXT?.split(",")
  .map(s => s.trim())
  .filter(Boolean) ?? [
    // Common code/text extensions (customize via ALLOWED_EXT)
    "ts", "tsx", "js", "jsx",
    "py", "cs", "java", "kt", "kts",
    "go", "rs", "cpp", "c", "h", "hpp",
    "rb", "php", "swift", "scala",
    "md", "txt",
    "gradle", "groovy",
    "json", "yaml", "yml", "xml",
    "proto", "properties"
  ]);

// Split text into overlapping chunks
function splitChunks(text: string, size = 800, overlap = 120) {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += Math.max(1, size - overlap);
  }
  return out;
}

// Cosine similarity
function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

let docs: Doc[] = [];
let embedder: any;

// Initialize local embedding pipeline
async function initEmbedder() {
  // Lightweight multilingual sentence-embedding model
  // You can try "Xenova/intfloat-multilingual-e5-small" if available, at the cost of speed.
  //embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  //embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L12-v2");
  embedder = await pipeline("feature-extraction", "Xenova/bge-base-en-v1.5");
}

// Compute an embedding vector for a text (mean pooling + normalization)
async function embedText(text: string): Promise<Float32Array> {
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return output.data as Float32Array;
}

// Build the in-memory index (chunks + embeddings)
async function buildIndex() {
  docs = [];
  const patterns = ALLOWED_EXT.map(ext => `**/*.${ext}`);
  const files = await fg(patterns, { cwd: ROOT, dot: false, absolute: true });
  console.error(`[MCP] Loading files from ${ROOT} ... (${files.length} files)`);

  let idCounter = 0;
  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const chunks = splitChunks(content);
      chunks.forEach((chunk, idx) => {
        docs.push({
          id: `${idCounter++}`,
          path: path.relative(ROOT, file),
          chunk: idx,
          text: chunk
        });
      });
    } catch { }
  }
  console.error(`[MCP] Created ${docs.length} chunks. Generating embeddings... (first run may take a while)`);

  for (let i = 0; i < docs.length; i++) {
    if (i % 200 === 0) console.error(`[MCP] Embedding ${i}/${docs.length}`);
    docs[i].emb = await embedText(docs[i].text);
  }
  console.error(`[MCP] Embeddings ready.`);
}

function ensureWithinRoot(relPath: string) {
  const abs = path.resolve(ROOT, relPath);
  const normRoot = path.resolve(ROOT) + path.sep;
  if (!abs.startsWith(normRoot)) throw new McpError(ErrorCode.InvalidRequest, "Path outside ROOT");
  return abs;
}

const server = new Server(
  { name: "mcp-rag-server", version: "0.2.0-emb" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "rag_query",
        description: "Semantically search files under REPO_ROOT and return relevant snippets (path, snippet, score).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            top_k: { type: "number" }
          },
          required: ["query"]
        }
      },
      {
        name: "read_file",
        description: "Read a specific file (optionally a line range).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" }
          },
          required: ["path"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "rag_query") {
    const { query, top_k = 5 } = (req.params.arguments ?? {}) as any;
    if (!query) throw new McpError(ErrorCode.InvalidRequest, "Missing query");

    const qEmb = await embedText(String(query));
    const scored = docs.map(d => ({
      d,
      s: cosine(d.emb!, qEmb)
    }));
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, Math.max(1, Math.min(50, top_k))).map(r => ({
      path: r.d.path,
      score: Number(r.s.toFixed(4)),
      snippet: r.d.text
    }));
    return { toolResult: { matches: top } };
  }

  if (req.params.name === "read_file") {
    const { path: rel, startLine, endLine } = (req.params.arguments ?? {}) as any;
    if (!rel) throw new McpError(ErrorCode.InvalidRequest, "Missing path");
    const abs = ensureWithinRoot(rel);
    const content = await fs.readFile(abs, "utf8");
    if (startLine != null || endLine != null) {
      const lines = content.split(/\r?\n/);
      const s = Math.max(0, (startLine ?? 1) - 1);
      const e = Math.min(lines.length, (endLine ?? lines.length));
      return { toolResult: lines.slice(s, e).join("\n") };
    }
    return { toolResult: content };
  }

  throw new McpError(ErrorCode.MethodNotFound, "Unknown method");
});

const transport = new StdioServerTransport();

await initEmbedder();
await buildIndex();
await server.connect(transport);
