import fs from "node:fs/promises";
import fsSync from "node:fs";
import { Doc } from "./types";

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
    if (!fsSync.existsSync(storePath)) return null;
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.docs)) return null;
      const meta = parsed.meta || {};
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
      const docs: Doc[] = [];
      for (const d of parsed.docs) {
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
              arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
              arr = new Float32Array(arr); // copy
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
      console.error(`[MCP] Loaded persisted index: ${docs.length} chunks.`);
      if (verbose) console.error(`[MCP][verbose] Loaded from ${storePath}`);
      return docs;
    } catch (e) {
      console.error(`[MCP] Failed to load store at ${storePath}:`, e);
      return null;
    }
  }

  /** Persist the current in-memory index to disk (if configured). */
  public async save(
    params: Omit<SaveParams, "storePath" | "verbose"> & { storePath?: string; verbose?: boolean },
  ): Promise<void> {
    const storePath = params.storePath ?? this.storePath;
    const verbose = params.verbose ?? this.verbose ?? params.verbose;
    const { docs, chunkSize, chunkOverlap, modelName } = params;
    if (!storePath) return;
    try {
      const out = {
        version: 1,
        meta: {
          chunkSize,
          chunkOverlap,
          modelName,
          savedAt: new Date().toISOString(),
          embEncoding: "f32-base64",
        },
        docs: docs.map((d) => ({
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
      await fs.writeFile(storePath, JSON.stringify(out));
      if (verbose) console.error(`[MCP][verbose] Persisted index to ${storePath}`);
    } catch (e) {
      console.error(`[MCP] Failed to save index store:`, e);
    }
  }
}
