import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Embeddings } from "./embeddings";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { statusManager } from "./status";

/**
 * Represents a single chunk of source content (post splitting) with an optional
 * embedding vector. Chunks are addressed by monotonically increasing string
 * IDs (unique only within the current process lifecycle) plus their file path
 * and in-file chunk index. The raw text is retained in-memory for fast scoring.
 */
export type Doc = {
  id: string;
  path: string; // file path relative to repo root
  chunk: number; // chunk index within file
  text: string; // chunk text content
  emb?: Float32Array; // embedding vector once generated
};

/**
 * Options required to construct an {@link Indexer}. All fields are mandatory
 * except `verbose` which enables periodic progress logging.
 */
export interface BuildIndexOptions {
  root: string; // repository root directory
  allowedExt: string[]; // list of file extensions WITHOUT leading dot
  embeddings: Embeddings; // initialized embeddings instance
  verbose?: boolean; // extra logging
}

/**
 * High-level orchestrator for: file discovery, content chunking, and embedding
 * generation. The full corpus (chunks + embeddings) is kept in-memory for
 * simplicity / speed; for large repositories consider persisting to disk or a
 * vector store. A single "build" pass is currently supported (no incremental
 * update logic yet).
 */
export class Indexer {
  private readonly root: string;
  private readonly allowedExt: string[];
  private readonly embeddings: Embeddings;
  private readonly verbose: boolean;
  private readonly docs: Doc[] = [];
  private built = false;

  public constructor(opts: BuildIndexOptions) {
    this.root = opts.root;
    this.allowedExt = opts.allowedExt;
    this.embeddings = opts.embeddings;
    this.verbose = !!opts.verbose;
  }

  /**
   * Access all in-memory documents (mutable array reference). Treat as
   * read-only in callers to avoid corrupting internal state.
   */
  public getDocs(): Doc[] {
    return this.docs;
  }

  /** Whether {@link build} has completed successfully. */
  public isReady(): boolean {
    return this.built;
  }

  /**
   * Split arbitrary text into (roughly) fixed-size overlapping chunks. The
   * final chunk may be shorter. Overlap helps retain context continuity across
   * chunk boundaries for embedding similarity.
   *
   * @param text Full input string to divide.
   * @param size Target maximum characters per chunk (default 800).
   * @param overlap Number of characters of trailing overlap to retain from the
   * previous chunk (default 120). Must be < size for forward progress.
   * @returns Ordered list of chunk strings.
   */
  public static splitChunks(text: string, size = 800, overlap = 120): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      out.push(text.slice(i, i + size));
      i += Math.max(1, size - overlap);
    }
    return out;
  }

  /**
   * Perform a full corpus (re)build: discover files, load contents, chunk, and
   * generate embeddings sequentially. Existing state is cleared first. Errors
   * reading individual files are intentionally swallowed to maximize coverage.
   *
   * Note: This is a blocking, single-threaded process; large repositories will
   * take time. Consider future enhancements (parallelism, incremental update,
   * persistence) if performance becomes a concern.
   */
  public async build(): Promise<void> {
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
    statusManager.setIndexTotals(files.length, this.docs.length);

    for (let i = 0; i < this.docs.length; i++) {
      if (i % 200 === 0) console.error(`[MCP] Embedding ${i}/${this.docs.length}`);
      if (this.verbose && i % 50 === 0) {
        const pct = ((i / Math.max(1, this.docs.length)) * 100).toFixed(1);
        console.error(`[MCP][verbose] Embedding progress: ${i}/${this.docs.length} (${pct}%)`);
      }
      this.docs[i].emb = await this.embeddings.embed(this.docs[i].text);
      statusManager.incEmbedded();
    }
    console.error(`[MCP] Embeddings ready.`);
    statusManager.markReady();
    this.built = true;
  }

  /** Ensure a (possibly user-supplied) relative path stays within the indexer's root. */
  public ensureWithinRoot(relPath: string): string {
    return Indexer.ensureWithinRoot(this.root, relPath);
  }

  /**
   * Static helper variant of {@link ensureWithinRoot}. Throws an MCP
   * InvalidRequest error if the resolved absolute path attempts directory
   * traversal outside the configured repository root.
   */
  public static ensureWithinRoot(root: string, relPath: string): string {
    const abs = path.resolve(root, relPath);
    const normRoot = path.resolve(root) + path.sep;
    if (!abs.startsWith(normRoot))
      throw new McpError(ErrorCode.InvalidRequest, "Path outside ROOT");
    return abs;
  }
}
