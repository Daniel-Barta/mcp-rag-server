import fs from "node:fs/promises";
import fsSync from "node:fs";

// Lightweight structural type (kept duplicate to avoid circular import with indexer)
export type PersistDoc = {
  id: string;
  path: string;
  chunk: number;
  text: string;
  fileSize: number;
  emb?: Float32Array;
};

export interface LoadParams {
  storePath?: string;
  chunkSize: number;
  chunkOverlap: number;
  modelName: string;
  verbose?: boolean;
}

export interface SaveParams {
  storePath?: string;
  docs: PersistDoc[];
  chunkSize: number;
  chunkOverlap: number;
  modelName: string;
  verbose?: boolean;
}

/**
 * Class encapsulating persistence logic (load/save) for the chunk/embedding index.
 * An instance can be configured with a default store path + verbosity while each
 * call may still override those values if desired.
 */
export class Persistence {
  private storePath?: string;
  private verbose: boolean;

  constructor(storePath?: string, verbose = false) {
    this.storePath = storePath;
    this.verbose = verbose;
  }

  setStorePath(p?: string) {
    this.storePath = p;
  }

  setVerbose(v: boolean) {
    this.verbose = v;
  }

  /**
   * Attempt to load a previously persisted index from disk. Returns an array of
   * docs if successful and compatible with the provided params, else null.
   */
  async load(
    params: Omit<LoadParams, "storePath" | "verbose"> & { storePath?: string; verbose?: boolean },
  ): Promise<PersistDoc[] | null> {
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
      const docs: PersistDoc[] = [];
      for (const d of parsed.docs) {
        if (!d || typeof d !== "object") continue;
        const { id, path: p, chunk, text, fileSize, emb } = d as any;
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
        docs.push({ id, path: p, chunk, text, fileSize, emb: arr });
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
  async save(
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
