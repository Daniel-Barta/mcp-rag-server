import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Embeddings } from "./embeddings";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { statusManager } from "./status";
import { Persistence } from "./persistence";
import { Doc } from "./types";
import { PdfExtractor } from "./pdf-extractor";

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
 * Construction options for an {@link Indexer} instance.
 *
 * Invariants / expectations:
 *  - `root` must exist & be an accessible directory before {@link build} is invoked.
 *  - `allowedExt` items are provided without a leading dot (e.g. `"ts"`, not `".ts"`).
 *  - If both `storePath` and `persistence` are supplied, the explicit `persistence`
 *    instance is used (allowing DI / testing) and `storePath` is still forwarded in
 *    load / save calls.
 *  - `chunkOverlap < chunkSize` (the constructor will clamp & warn if violated).
 */
export interface BuildIndexOptions {
  /** Absolute repository (or corpus) root directory */
  root: string;
  /** File extensions (no leading dots) that will be indexed */
  allowedExt: string[];
  /** Optional folder names / glob patterns to exclude (example: ["node_modules", "dist"]) */
  excludedFolders?: string[];
  /** Initialized embeddings provider (must be ready before build) */
  embeddings: Embeddings;
  /** Enable additional progress logging to stderr */
  verbose?: boolean;
  /** Characters per chunk (default 800). Larger => fewer vectors, less locality */
  chunkSize?: number;
  /** Trailing character overlap between consecutive chunks (default 120) */
  chunkOverlap?: number;
  /** Optional JSON persistence path (for warm start / incremental updates) */
  storePath?: string;
  /** Optional injected persistence implementation (useful for tests / alternates) */
  persistence?: Persistence;
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
  private readonly excludedFolders: string[];
  private readonly embeddings: Embeddings;
  private readonly verbose: boolean;
  private readonly docs: Doc[] = [];
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly storePath?: string;
  private readonly persistence?: Persistence;
  private readonly pdfExtractor: PdfExtractor;
  private built = false;

  public constructor(opts: BuildIndexOptions) {
    this.root = opts.root;
    this.allowedExt = opts.allowedExt;
    this.excludedFolders = opts.excludedFolders ?? [];
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
    this.pdfExtractor = new PdfExtractor(this.storePath, this.root, this.verbose);
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

  /** Access the PDF extractor instance. */
  public getPdfExtractor(): PdfExtractor {
    return this.pdfExtractor;
  }

  /**
   * Read file content, handling both regular text files and PDFs.
   * For PDFs, extracts text via the PDF extractor (with caching).
   * For other files, reads as UTF-8 text.
   *
   * @param absPath Absolute path to the file.
   * @param relPath Relative path (used for PDF cache metadata).
   * @param fileSize File size in bytes (used for PDF cache validation).
   * @returns File content as string, or null if the file could not be read
   *          (e.g., empty PDF, extraction failure, or unreadable file).
   */
  private async readFileContent(
    absPath: string,
    relPath: string,
    fileSize: number,
  ): Promise<string | null> {
    try {
      if (PdfExtractor.isPdf(absPath)) {
        const content = await this.pdfExtractor.extractText(absPath, relPath, fileSize);
        if (!content) {
          if (this.verbose) {
            console.error(`[MCP][verbose] Skipping empty PDF: ${relPath}`);
          }
          return null;
        }
        return content;
      }
      return await fs.readFile(absPath, "utf8");
    } catch (e) {
      if (this.verbose) {
        console.error(`[MCP][verbose] Failed to read file ${relPath}:`, e);
      }
      return null;
    }
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
    // NOTE: This splitter is intentionally naïve (pure character length). For
    // better semantic coherence consider: token-aware splitting (tiktoken),
    // markdown / code block boundary detection, or AST / LSP assisted segmenting.
    // Complexity: O(n) where n = text.length (single pass slicing arithmetic).
    // Memory: Each chunk is a substring copy (JS engines may slice lazily but
    // callers should treat memory proportional to number_of_chunks * size).
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
      const content = await this.readFileContent(info.abs, info.rel, info.size);
      if (content === null) {
        continue; // Skip unreadable or empty files
      }

      const chunks = Indexer.splitChunks(content, this.chunkSize, this.chunkOverlap);
      const lineCount = content.split(/\r?\n/).length;
      chunks.forEach((chunk, idx) => {
        this.docs.push({
          id: `${idCounter++}`,
          path: info.rel,
          chunk: idx,
          text: chunk,
          fileSize: info.size,
          lineCount,
        });
      });
      processedFiles++;
      if (this.verbose && processedFiles % 100 === 0) {
        console.error(`[MCP][verbose] Processed ${processedFiles}/${fileInfos.length} files`);
      }
    }
    console.error(
      `[MCP] Created ${this.docs.length} chunks. Generating embeddings... (first run may take a while)`,
    );
    statusManager.setIndexTotals(fileInfos.length, this.docs.length);

    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i];
      if (!doc) continue; // Should never happen, but satisfies strict type checking
      if (i % 200 === 0) console.error(`[MCP] Embedding ${i}/${this.docs.length}`);
      if (this.verbose && i % 50 === 0) {
        const pct = ((i / Math.max(1, this.docs.length)) * 100).toFixed(1);
        console.error(`[MCP][verbose] Embedding progress: ${i}/${this.docs.length} (${pct}%)`);
      }
      doc.emb = await this.embeddings.embed(doc.text);
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
    // Permit the root directory itself (abs === root). Original logic required
    // a trailing separator which excluded the root path when listing it.
    if (abs !== path.resolve(root) && !abs.startsWith(normRoot)) {
      throw new McpError(ErrorCode.InvalidRequest, "Path outside ROOT");
    }
    return abs;
  }

  // -------------------- Persistence & Incremental Logic --------------------

  /**
   * File discovery
   *  - Uses fast-glob for pattern expansion (extension based filtering only).
   *  - Excludes dot files/directories by default (dot: false).
   *  - Filters out files in excluded folder patterns.
   *  - Returns only regular files with their relative path & size for later
   *    lightweight change detection.
   */
  private async discoverFiles(): Promise<{ rel: string; abs: string; size: number }[]> {
    const patterns = this.allowedExt.map((ext) => `**/*.${ext}`);

    // Build ignore patterns for excluded folders
    const ignorePatterns = this.excludedFolders.map((folder) => {
      // Support both exact folder names and glob patterns
      if (folder.includes("*") || folder.includes("?")) {
        return folder; // It's already a glob pattern
      }
      return `**/${folder}/**`; // Convert folder name to glob pattern
    });

    const files = await fg(patterns, {
      cwd: this.root,
      dot: false,
      absolute: true,
      ignore: ignorePatterns,
    });

    const infos: { rel: string; abs: string; size: number }[] = [];
    for (const abs of files) {
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        if (st.size === 0) continue; // skip empty files
        const rel = path.relative(this.root, abs);
        infos.push({ rel, abs, size: st.size });
      } catch {
        /* ignore */
      }
    }

    if (this.verbose && this.excludedFolders.length > 0) {
      console.error(`[MCP][verbose] Excluded folder patterns: ${this.excludedFolders.join(", ")}`);
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
        for (let i = this.docs.length - 1; i >= 0; i--) {
          const doc = this.docs[i];
          if (doc && doc.path === r) this.docs.splice(i, 1);
        }
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
        for (let i = this.docs.length - 1; i >= 0; i--) {
          const doc = this.docs[i];
          if (doc && doc.path === rel) this.docs.splice(i, 1);
        }
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
    console.error(`[MCP] Number of changed or new files: ${changed.length}`);
    for (const file of changed) {
      console.error(`[MCP] Embedding ${file.rel}`);

      const content = await this.readFileContent(file.abs, file.rel, file.size);
      if (content === null) {
        continue; // Skip unreadable or empty files
      }

      const chunks = Indexer.splitChunks(content, this.chunkSize, this.chunkOverlap);
      const lineCount = content.split(/\r?\n/).length;
      for (let idx = 0; idx < chunks.length; idx++) {
        const text = chunks[idx];
        if (!text) continue; // Should never happen, but satisfies strict type checking
        const emb = await this.embeddings.embed(text);
        this.docs.push({
          id: `${idCounter++}`,
          path: file.rel,
          chunk: idx,
          text,
          fileSize: file.size,
          lineCount,
          emb,
        });
        statusManager.incEmbedded();
        embeddedChunks++;
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
