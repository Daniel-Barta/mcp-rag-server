import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Embeddings } from "./embeddings";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { setIndexTotals, incEmbedded, markReady } from "./status";

/** Represents a single chunk of source content with optional embedding */
export type Doc = {
  id: string;
  path: string; // file path relative to repo root
  chunk: number; // chunk index within file
  text: string; // chunk text content
  emb?: Float32Array; // embedding vector once generated
};

// Internal in-memory document store
const docs: Doc[] = [];

/** Accessor for current documents */
export function getDocs(): Doc[] {
  return docs;
}

/** Split text into overlapping chunks */
export function splitChunks(text: string, size = 800, overlap = 120): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += Math.max(1, size - overlap);
  }
  return out;
}

export interface BuildIndexOptions {
  root: string; // repository root directory
  allowedExt: string[]; // list of file extensions WITHOUT leading dot
  embeddings: Embeddings; // initialized embeddings instance
  verbose?: boolean; // extra logging
}

/**
 * Build in-memory vector index: enumerate files, chunk content, embed chunks.
 * Side effects: updates status module counters, fills internal docs array.
 */
export async function buildIndex(options: BuildIndexOptions): Promise<void> {
  const { root, allowedExt, embeddings, verbose = false } = options;
  docs.length = 0; // reset

  const patterns = allowedExt.map((ext) => `**/*.${ext}`);
  const files = await fg(patterns, { cwd: root, dot: false, absolute: true });
  console.error(`[MCP] Loading files from ${root} ... (${files.length} files)`);
  if (verbose) console.error(`[MCP][verbose] Extensions: ${allowedExt.join(", ")}`);

  let idCounter = 0;
  let fileCounter = 0;
  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf8");
      const chunks = splitChunks(content);
      chunks.forEach((chunk, idx) => {
        docs.push({
          id: `${idCounter++}`,
          path: path.relative(root, file),
          chunk: idx,
          text: chunk,
        });
      });
      fileCounter++;
      if (verbose && fileCounter % 100 === 0) {
        console.error(`[MCP][verbose] Processed ${fileCounter}/${files.length} files`);
      }
    } catch {
      /* ignore unreadable files */
    }
  }
  console.error(
    `[MCP] Created ${docs.length} chunks. Generating embeddings... (first run may take a while)`,
  );
  setIndexTotals(files.length, docs.length);

  for (let i = 0; i < docs.length; i++) {
    if (i % 200 === 0) console.error(`[MCP] Embedding ${i}/${docs.length}`);
    if (verbose && i % 50 === 0) {
      const pct = ((i / Math.max(1, docs.length)) * 100).toFixed(1);
      console.error(`[MCP][verbose] Embedding progress: ${i}/${docs.length} (${pct}%)`);
    }
    docs[i].emb = await embeddings.embed(docs[i].text);
    incEmbedded();
  }
  console.error(`[MCP] Embeddings ready.`);
  markReady();
}

/** Ensure a relative path stays within the provided root */
export function ensureWithinRoot(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const normRoot = path.resolve(root) + path.sep;
  if (!abs.startsWith(normRoot)) throw new McpError(ErrorCode.InvalidRequest, "Path outside ROOT");
  return abs;
}
