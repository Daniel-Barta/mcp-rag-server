import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Doc } from "./types";

/**
 * Maximum number of documents to store in a single JSON file.
 * This prevents JSON.stringify from creating excessively large strings.
 */
const DOCS_PER_FILE = 10000;

/**
 * Parameters controlling a load attempt for a previously persisted embedding/chunk index.
 *
 * Notes:
 * - If `storePath` is omitted here and the instance was constructed with a path, the instance path is used.
 * - `chunkSize`, `chunkOverlap`, and `modelName` must match the metadata found on disk; otherwise the load
 *   is treated as incompatible and will return `null` (triggering a cold rebuild by callers).
 */
export interface LoadParams {
  storePath?: string;
  chunkSize: number;
  chunkOverlap: number;
  modelName: string;
  verbose?: boolean;
}

/**
 * Parameters used when persisting the in-memory index to disk.
 *
 * The `docs` array must contain embeddings (Float32Array) which will be serialized as base64-encoded
 * 32-bit floats (little-endian) under the `emb` property in the output JSON. Metadata is stored alongside
 * to allow compatibility checks on subsequent loads.
 */
export interface SaveParams {
  storePath?: string;
  docs: Doc[];
  chunkSize: number;
  chunkOverlap: number;
  modelName: string;
  verbose?: boolean;
}

/**
 * Encapsulates persistence logic (load/save) for the chunk/embedding index.
 * An instance can be configured with a default store path + verbosity while each
 * call may still override those values if desired.
 */
export class Persistence {
  /** Filesystem path where the JSON index will be stored / read. */
  private storePath?: string;
  /** Default verbosity for the instance (can be overridden per call). */
  private verbose: boolean;

  /**
   * Create a new persistence helper.
   * @param storePath Optional default file path for the persisted index (JSON file).
   * @param verbose   Whether to emit verbose logging by default.
   */
  public constructor(storePath?: string, verbose = false) {
    this.storePath = storePath;
    this.verbose = verbose;
  }

  /**
   * Update (or clear) the default store path used when callers do not supply one.
   * @param p New path or undefined to clear.
   */
  public setStorePath(p?: string): void {
    this.storePath = p;
  }

  /**
   * Enable / disable verbose logging globally for subsequent calls.
   * @param v True for verbose mode.
   */
  public setVerbose(v: boolean): void {
    this.verbose = v;
  }

  /**
   * Attempt to load a previously persisted index from disk.
   * Returns an array of docs if successful and compatible with the provided params, else null.
   */
  public async load(
    params: Omit<LoadParams, "storePath" | "verbose"> & { storePath?: string; verbose?: boolean },
  ): Promise<Doc[] | null> {
    const storePath = params.storePath ?? this.storePath;
    const verbose = params.verbose ?? this.verbose;
    const { chunkSize, chunkOverlap, modelName } = params;
    if (!storePath) return null;

    const storeDir = path.dirname(storePath);
    const storeBaseName = path.basename(storePath, ".json");
    const manifestPath = path.join(storeDir, `${storeBaseName}.manifest.json`);

    if (!fsSync.existsSync(manifestPath)) return null;

    try {
      return await this.loadMultiFile(manifestPath, {
        chunkSize,
        chunkOverlap,
        modelName,
        verbose,
      });
    } catch (e) {
      console.error(`[MCP] Failed to load store at ${storePath}:`, e);
      return null;
    }
  }

  /**
   * Load from multiple JSON files using a manifest.
   */
  private async loadMultiFile(
    manifestPath: string,
    params: { chunkSize: number; chunkOverlap: number; modelName: string; verbose: boolean },
  ): Promise<Doc[] | null> {
    const { chunkSize, chunkOverlap, modelName, verbose } = params;
    try {
      const manifestRaw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw);

      if (!manifest || !manifest.meta || !Array.isArray(manifest.files)) {
        return null;
      }

      const meta = manifest.meta;
      if (
        meta.chunkSize !== chunkSize ||
        meta.chunkOverlap !== chunkOverlap ||
        (meta.modelName && meta.modelName !== modelName)
      ) {
        console.error(
          `[MCP] Stored index incompatible (model/chunk params differ). Performing cold rebuild.`,
        );
        return null;
      }

      const storeDir = path.dirname(manifestPath);
      const allDocs: Doc[] = [];

      // Load all data files
      for (const fileName of manifest.files) {
        const filePath = path.join(storeDir, fileName);
        if (!fsSync.existsSync(filePath)) {
          console.error(`[MCP] Missing data file: ${fileName}`);
          return null;
        }
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.docs)) {
          console.error(`[MCP] Invalid data file format: ${fileName}`);
          return null;
        }
        const docs = this.parseDocs(parsed.docs);
        allDocs.push(...docs);
      }

      console.error(
        `[MCP] Loaded persisted index: ${allDocs.length} chunks from ${manifest.files.length} files.`,
      );
      if (verbose) console.error(`[MCP][verbose] Loaded from ${manifestPath}`);
      return allDocs;
    } catch (e) {
      console.error(`[MCP] Failed to load multi-file store:`, e);
      return null;
    }
  }

  /**
   * Parse raw document objects into Doc instances with embeddings.
   */
  private parseDocs(rawDocs: any[]): Doc[] {
    const docs: Doc[] = [];
    for (const d of rawDocs) {
      if (!d || typeof d !== "object") continue;
      const { id, path: p, chunk, text, fileSize, lineCount, emb } = d as any;
      if (
        typeof id !== "string" ||
        typeof p !== "string" ||
        typeof chunk !== "number" ||
        typeof text !== "string" ||
        typeof fileSize !== "number"
      )
        continue;
      let arr: Float32Array | null = null;
      if (Array.isArray(emb)) {
        arr = new Float32Array(emb.map((n: any) => Number(n) || 0));
      } else if (typeof emb === "string") {
        try {
          const buf = Buffer.from(emb, "base64");
          if (buf.byteLength % 4 === 0) {
            // Create a view into the buffer, then copy to detach from the underlying
            // Buffer memory. Without copying, the Float32Array would share memory with
            // the Buffer which can lead to unexpected behavior if the Buffer is reused.
            const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            arr = new Float32Array(view);
          }
        } catch {
          /* ignore */
        }
      }
      if (!arr) continue; // require embedding
      docs.push({
        id,
        path: p,
        chunk,
        text,
        fileSize,
        lineCount: typeof lineCount === "number" && lineCount > 0 ? lineCount : -1,
        emb: arr,
      });
    }
    return docs;
  }

  /** Persist the current in-memory index to disk (if configured). */
  public async save(
    params: Omit<SaveParams, "storePath" | "verbose"> & { storePath?: string; verbose?: boolean },
  ): Promise<void> {
    const storePath = params.storePath ?? this.storePath;
    const verbose = params.verbose ?? this.verbose;
    const { docs, chunkSize, chunkOverlap, modelName } = params;
    if (!storePath) return;

    try {
      const storeDir = path.dirname(storePath);
      const storeBaseName = path.basename(storePath, ".json");

      // Ensure directory exists
      await fs.mkdir(storeDir, { recursive: true });

      // Always use multi-file format
      await this.saveMultiFile(storeDir, storeBaseName, {
        docs,
        chunkSize,
        chunkOverlap,
        modelName,
        verbose,
      });
    } catch (e) {
      console.error(`[MCP] Failed to save index store:`, e);
    }
  }

  /**
   * Remove old cache part files that may remain from previous runs with more documents.
   * This prevents orphaned files when the index shrinks (e.g., after deleting files).
   */
  private async cleanupOldCacheFiles(
    storeDir: string,
    storeBaseName: string,
    verbose: boolean,
  ): Promise<void> {
    try {
      // Check if directory exists
      if (!fsSync.existsSync(storeDir)) return;

      // Read all files in the store directory
      const allFiles = await fs.readdir(storeDir);

      // Pattern to match cache part files: <baseName>.part####.json
      const partFilePattern = new RegExp(`^${storeBaseName}\\.part\\d{4}\\.json$`);

      // Find all matching part files
      const oldPartFiles = allFiles.filter((file) => partFilePattern.test(file));

      if (oldPartFiles.length > 0) {
        if (verbose) {
          console.error(`[MCP][verbose] Cleaning up ${oldPartFiles.length} old cache part files`);
        }

        // Delete all old part files
        for (const file of oldPartFiles) {
          const filePath = path.join(storeDir, file);
          try {
            await fs.unlink(filePath);
          } catch (e) {
            // Log but don't fail the save operation
            console.error(`[MCP] Warning: Failed to delete old cache file ${file}:`, e);
          }
        }
      }
    } catch (e) {
      // Log but don't fail the save operation
      console.error(`[MCP] Warning: Failed to cleanup old cache files:`, e);
    }
  }

  /**
   * Save to multiple JSON files with a manifest.
   */
  private async saveMultiFile(
    storeDir: string,
    storeBaseName: string,
    params: {
      docs: Doc[];
      chunkSize: number;
      chunkOverlap: number;
      modelName: string;
      verbose: boolean;
    },
  ): Promise<void> {
    const { docs, chunkSize, chunkOverlap, modelName, verbose } = params;

    // Clean up old cache files before writing new ones
    await this.cleanupOldCacheFiles(storeDir, storeBaseName, verbose);

    // Split docs into chunks
    const fileCount = Math.ceil(docs.length / DOCS_PER_FILE);
    const dataFiles: string[] = [];

    for (let i = 0; i < fileCount; i++) {
      const start = i * DOCS_PER_FILE;
      const end = Math.min((i + 1) * DOCS_PER_FILE, docs.length);
      const chunkDocs = docs.slice(start, end);

      const fileName = `${storeBaseName}.part${i.toString().padStart(4, "0")}.json`;
      const filePath = path.join(storeDir, fileName);
      dataFiles.push(fileName);

      const out = {
        docs: chunkDocs.map((d) => ({
          id: d.id,
          path: d.path,
          chunk: d.chunk,
          text: d.text,
          fileSize: d.fileSize,
          lineCount: d.lineCount,
          emb: d.emb
            ? Buffer.from(d.emb.buffer, d.emb.byteOffset, d.emb.byteLength).toString("base64")
            : "",
        })),
      };

      await fs.writeFile(filePath, JSON.stringify(out));
    }

    // Create manifest file
    const manifest = {
      version: 2,
      meta: {
        chunkSize,
        chunkOverlap,
        modelName,
        savedAt: new Date().toISOString(),
        embEncoding: "f32-base64",
        totalDocs: docs.length,
        fileCount: dataFiles.length,
      },
      files: dataFiles,
    };

    const manifestPath = path.join(storeDir, `${storeBaseName}.manifest.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    console.error(`[MCP] Persisted index: ${docs.length} chunks split into ${fileCount} files.`);
    if (verbose) console.error(`[MCP][verbose] Persisted multi-file index to ${manifestPath}`);
  }
}
