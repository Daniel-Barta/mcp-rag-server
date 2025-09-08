import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Embeddings } from "./embeddings";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { statusManager } from "./status";
import { Persistence } from "./persistence";
import { Doc } from "./types";

/**
 * Indexer module
 * ----------------
 * Responsible for turning a repository (or arbitrary directory tree) into an in‑memory
 * semantic index:
 *   1. Discover source files by allowed extensions.
 *   2. Read & chunk file contents with optional overlap for better context recall.
 *   3. Generate embeddings via an {@link Embeddings} implementation.
 *   4. (Optionally) Persist / reload the index for fast incremental startup.
 *
 * The current implementation favors simplicity over ultimate performance:
 *   - Single threaded / sequential embedding generation.
 *   - Naïve change detection (file size heuristic) for incremental updates.
 *   - Entire corpus retained in memory (sufficient for medium repos / prototypes).
 *
 * For large monorepos or production scale you might extend this with:
 *   - Parallel file reads & batched embedding calls.
 *   - Stronger change detection (hashes, mtime, content diff windows).
 *   - Pluggable vector store (e.g. SQLite / pgvector / Qdrant / LanceDB / etc.).
 *   - Smarter chunking (semantic boundaries, token aware splitting).
 *
 * Security note: {@link ensureWithinRoot} defends against directory traversal when
 * user‑supplied relative paths are resolved. Always use it before reading a file path
 * received from an external request.
 */

/**
 * Options required to construct an {@link Indexer}. All fields are mandatory
 * except `verbose` which enables periodic progress logging.
 */
export interface BuildIndexOptions {
  root: string; // repository root directory
  allowedExt: string[]; // list of file extensions WITHOUT leading dot
  embeddings: Embeddings; // initialized embeddings instance
  verbose?: boolean; // extra logging
  chunkSize?: number; // optional override (default 800)
  chunkOverlap?: number; // optional override (default 120)
  storePath?: string; // optional persistent JSON store path (env-provided)
  persistence?: Persistence; // optional injected persistence instance
}

/**
 * High-level orchestrator for file discovery, chunking, embedding generation, and
 * optional persistence / incremental refresh.
 *
 * Typical lifecycle:
 * ```ts
 * const embeddings = new Embeddings();
 * await Embeddings.configureCache();
 * await embeddings.init();
 *
 * const indexer = new Indexer({
 *   root: repoRoot,
 *   allowedExt: ["ts", "tsx", "js", "md"],
 *   embeddings,
 *   storePath: path.join(repoRoot, ".mcp-index.json"),
 *   verbose: true,
 * });
 * await indexer.build();
 * if (!indexer.isReady()) throw new Error("Index failed");
 * const docs = indexer.getDocs(); // inspect / search over docs & embeddings
 * ```
 *
 * Concurrency: a single instance is not currently thread-safe for concurrent
 * build operations; call {@link build} once and reuse the resulting in-memory
 * data. Reading via {@link getDocs} is safe after readiness.
 */
export class Indexer {
  private readonly root: string;
  private readonly allowedExt: string[];
  private readonly embeddings: Embeddings;
  private readonly verbose: boolean;
  private readonly docs: Doc[] = [];
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly storePath?: string;
  private readonly persistence?: Persistence;
  private built = false;

  public constructor(opts: BuildIndexOptions) {
    this.root = opts.root;
    this.allowedExt = opts.allowedExt;
    this.embeddings = opts.embeddings;
    this.verbose = !!opts.verbose;
    this.chunkSize = opts.chunkSize ?? 800;
    // Resolve requested overlap then clamp if invalid (must be < chunk size). We compute
    // final value up-front so the property can remain readonly (no later mutation).
    const requestedOverlap = opts.chunkOverlap ?? 120;
    this.chunkOverlap =
      requestedOverlap >= this.chunkSize
        ? Math.max(0, Math.floor(this.chunkSize * 0.15)) // conservative fallback (~15%)
        : requestedOverlap;
    this.storePath = opts.storePath;
    this.persistence =
      opts.persistence ??
      (opts.storePath ? new Persistence(opts.storePath, this.verbose) : undefined);
    // If fallback was applied, emit a warning (compare to originally requested value).
    if (this.chunkOverlap !== requestedOverlap && requestedOverlap >= this.chunkSize) {
      console.error(
        `[MCP] Provided chunkOverlap (=${requestedOverlap}) >= chunkSize (=${this.chunkSize}). Using fallback overlap ${this.chunkOverlap}.`,
      );
    }
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
    // Attempt incremental build if a persistent store exists and is compatible.
    const loadedDocs = this.persistence
      ? await this.persistence.load({
          storePath: this.storePath,
          chunkSize: this.chunkSize,
          chunkOverlap: this.chunkOverlap,
          modelName: this.embeddings.getModelName(),
          verbose: this.verbose,
        })
      : null;
    if (loadedDocs) {
      this.docs.length = 0;
      this.docs.push(...loadedDocs);
      await this.incrementalUpdate();
      if (this.persistence) {
        await this.persistence.save({
          storePath: this.storePath,
          docs: this.docs,
          chunkSize: this.chunkSize,
          chunkOverlap: this.chunkOverlap,
          modelName: this.embeddings.getModelName(),
          verbose: this.verbose,
        });
      }
      this.built = true;
      return;
    }

    // Full (cold) build path
    this.docs.length = 0; // reset
    const fileInfos = await this.discoverFiles();
    console.error(
      `[MCP] Cold build: loading files from ${this.root} ... (${fileInfos.length} files)`,
    );
    if (this.verbose) console.error(`[MCP][verbose] Extensions: ${this.allowedExt.join(", ")}`);

    let idCounter = 0;
    let processedFiles = 0;
    for (const info of fileInfos) {
      try {
        const content = await fs.readFile(info.abs, "utf8");
        const chunks = Indexer.splitChunks(content, this.chunkSize, this.chunkOverlap);
        chunks.forEach((chunk, idx) => {
          this.docs.push({
            id: `${idCounter++}`,
            path: info.rel,
            chunk: idx,
            text: chunk,
            fileSize: info.size,
          });
        });
        processedFiles++;
        if (this.verbose && processedFiles % 100 === 0) {
          console.error(`[MCP][verbose] Processed ${processedFiles}/${fileInfos.length} files`);
        }
      } catch {
        /* ignore unreadable files */
      }
    }
    console.error(
      `[MCP] Created ${this.docs.length} chunks. Generating embeddings... (first run may take a while)`,
    );
    statusManager.setIndexTotals(fileInfos.length, this.docs.length);

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
    if (this.persistence) {
      await this.persistence.save({
        storePath: this.storePath,
        docs: this.docs,
        chunkSize: this.chunkSize,
        chunkOverlap: this.chunkOverlap,
        modelName: this.embeddings.getModelName(),
        verbose: this.verbose,
      });
    }
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

  // -------------------- Persistence & Incremental Logic --------------------

  /**
   * File discovery
   *  - Uses fast-glob for pattern expansion (extension based filtering only).
   *  - Excludes dot files/directories by default (dot: false).
   *  - Returns only regular files with their relative path & size for later
   *    lightweight change detection.
   */
  private async discoverFiles(): Promise<{ rel: string; abs: string; size: number }[]> {
    const patterns = this.allowedExt.map((ext) => `**/*.${ext}`);
    const files = await fg(patterns, { cwd: this.root, dot: false, absolute: true });
    const infos: { rel: string; abs: string; size: number }[] = [];
    for (const abs of files) {
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        infos.push({ rel: path.relative(this.root, abs), abs, size: st.size });
      } catch {
        /* ignore */
      }
    }
    return infos;
  }

  /**
   * Determine the current maximum numeric chunk id so newly added chunks can
   * continue the monotonic sequence after an incremental update load.
   */
  private getMaxId(): number {
    let max = -1;
    for (const d of this.docs) {
      const n = Number(d.id);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  /**
   * Incremental update strategy:
   *  1. Re-scan current file list & sizes.
   *  2. Remove chunks for deleted files.
   *  3. For each existing file compare stored size to current size; if changed,
   *     drop old chunks & re-ingest (size acts as a coarse change heuristic).
   *  4. Embed only new / changed chunks, credit existing ones in status metrics.
   *
   * NOTE: File size collisions (different content, same size) won’t trigger a re-embed.
   * For higher fidelity consider hashing content or comparing mtimes.
   */
  private async incrementalUpdate(): Promise<void> {
    console.error(`[MCP] Incremental index check starting...`);
    const fileInfos = await this.discoverFiles();
    const currentMap = new Map<string, { abs: string; size: number }>();
    for (const fi of fileInfos) currentMap.set(fi.rel, { abs: fi.abs, size: fi.size });

    // Group existing docs by file path
    const docsByFile = new Map<string, Doc[]>();
    for (const d of this.docs) {
      let arr = docsByFile.get(d.path);
      if (!arr) {
        arr = [];
        docsByFile.set(d.path, arr);
      }
      arr.push(d);
    }

    // Detect removed files
    const removed: string[] = [];
    for (const existing of docsByFile.keys()) {
      if (!currentMap.has(existing)) removed.push(existing);
    }
    if (removed.length) {
      console.error(`[MCP] Detected removed files: ${removed.length}`);
      for (const r of removed) {
        for (let i = this.docs.length - 1; i >= 0; i--)
          if (this.docs[i].path === r) this.docs.splice(i, 1);
      }
    }

    // Detect new or changed files
    const changed: { rel: string; abs: string; size: number }[] = [];
    for (const [rel, info] of currentMap.entries()) {
      const existingDocs = docsByFile.get(rel);
      if (!existingDocs) {
        changed.push({ rel, abs: info.abs, size: info.size });
        continue;
      }
      const storedSize = existingDocs[0]?.fileSize;
      if (storedSize !== info.size) {
        // remove old chunks first
        for (let i = this.docs.length - 1; i >= 0; i--)
          if (this.docs[i].path === rel) this.docs.splice(i, 1);
        changed.push({ rel, abs: info.abs, size: info.size });
      }
    }

    if (!removed.length && !changed.length) {
      console.error(`[MCP] No changes detected. Using cached embeddings.`);
      statusManager.setIndexTotals(currentMap.size, this.docs.length);
      statusManager.incEmbedded(this.docs.length); // count all as embedded
      statusManager.markReady();
      return;
    }

    // Re-embed changed/new files
    let idCounter = this.getMaxId() + 1;
    let embeddedChunks = 0;
    for (const file of changed) {
      try {
        const content = await fs.readFile(file.abs, "utf8");
        const chunks = Indexer.splitChunks(content, this.chunkSize, this.chunkOverlap);
        for (let idx = 0; idx < chunks.length; idx++) {
          const text = chunks[idx];
          const emb = await this.embeddings.embed(text);
          this.docs.push({
            id: `${idCounter++}`,
            path: file.rel,
            chunk: idx,
            text,
            fileSize: file.size,
            emb,
          });
          statusManager.incEmbedded();
          embeddedChunks++;
        }
      } catch (e) {
        console.error(`[MCP] Failed to re-index file ${file.rel}:`, e);
      }
    }
    statusManager.setIndexTotals(currentMap.size, this.docs.length);
    // Pre-existing docs lacked embedded increment counts: credit them now.
    const credited = this.docs.length - embeddedChunks;
    if (credited > 0) statusManager.incEmbedded(credited);
    statusManager.markReady();
    console.error(
      `[MCP] Incremental update complete. Changed files: ${changed.length}, removed: ${removed.length}. Total chunks: ${this.docs.length}`,
    );
  }
}
