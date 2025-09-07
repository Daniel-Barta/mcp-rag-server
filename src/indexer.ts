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

/** Options used to build an index (mirrors previous function options) */
export interface BuildIndexOptions {
  root: string; // repository root directory
  allowedExt: string[]; // list of file extensions WITHOUT leading dot
  embeddings: Embeddings; // initialized embeddings instance
  verbose?: boolean; // extra logging
}

/** Class-based encapsulation of indexing + embeddings lifecycle */
export class Indexer {
  private root: string;
  private allowedExt: string[];
  private embeddings: Embeddings;
  private verbose: boolean;
  private docs: Doc[] = [];
  private built = false;

  constructor(opts: BuildIndexOptions) {
    this.root = opts.root;
    this.allowedExt = opts.allowedExt;
    this.embeddings = opts.embeddings;
    this.verbose = !!opts.verbose;
  }

  /** Access in-memory documents */
  getDocs(): Doc[] {
    return this.docs;
  }

  /** Whether build() has completed */
  isReady(): boolean {
    return this.built;
  }

  /** Split text into overlapping chunks */
  static splitChunks(text: string, size = 800, overlap = 120): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      out.push(text.slice(i, i + size));
      i += Math.max(1, size - overlap);
    }
    return out;
  }

  /** Perform file discovery, chunking, and embedding generation */
  async build(): Promise<void> {
    this.docs.length = 0; // reset
    const patterns = this.allowedExt.map((ext) => `**/*.${ext}`);
    const files = await fg(patterns, { cwd: this.root, dot: false, absolute: true });
    console.error(`[MCP] Loading files from ${this.root} ... (${files.length} files)`);
    if (this.verbose) console.error(`[MCP][verbose] Extensions: ${this.allowedExt.join(", ")}`);

    let idCounter = 0;
    let fileCounter = 0;
    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf8");
        const chunks = Indexer.splitChunks(content);
        chunks.forEach((chunk, idx) => {
          this.docs.push({
            id: `${idCounter++}`,
            path: path.relative(this.root, file),
            chunk: idx,
            text: chunk,
          });
        });
        fileCounter++;
        if (this.verbose && fileCounter % 100 === 0) {
          console.error(`[MCP][verbose] Processed ${fileCounter}/${files.length} files`);
        }
      } catch {
        /* ignore unreadable files */
      }
    }
    console.error(
      `[MCP] Created ${this.docs.length} chunks. Generating embeddings... (first run may take a while)`,
    );
    setIndexTotals(files.length, this.docs.length);

    for (let i = 0; i < this.docs.length; i++) {
      if (i % 200 === 0) console.error(`[MCP] Embedding ${i}/${this.docs.length}`);
      if (this.verbose && i % 50 === 0) {
        const pct = ((i / Math.max(1, this.docs.length)) * 100).toFixed(1);
        console.error(`[MCP][verbose] Embedding progress: ${i}/${this.docs.length} (${pct}%)`);
      }
      this.docs[i].emb = await this.embeddings.embed(this.docs[i].text);
      incEmbedded();
    }
    console.error(`[MCP] Embeddings ready.`);
    markReady();
    this.built = true;
  }

  /** Ensure a relative path stays within the indexer's root */
  ensureWithinRoot(relPath: string): string {
    return Indexer.ensureWithinRoot(this.root, relPath);
  }

  /** Static helper retaining previous external signature */
  static ensureWithinRoot(root: string, relPath: string): string {
    const abs = path.resolve(root, relPath);
    const normRoot = path.resolve(root) + path.sep;
    if (!abs.startsWith(normRoot))
      throw new McpError(ErrorCode.InvalidRequest, "Path outside ROOT");
    return abs;
  }
}
// Backwards-compatible named exports for previous function-based API (optional)
// These allow existing imports to transition gradually. They can be removed later.
export const splitChunks = Indexer.splitChunks;
