import fs from "node:fs/promises";
import path from "node:path";
import { env, pipeline } from "@xenova/transformers";

/**
 * Encapsulates embedding model initialization, cache directory configuration
 * and helper utilities for generating embeddings + computing cosine similarity.
 * A single instance can be reused for any number of embed() calls.
 */
export class Embeddings {
  private modelName: string;
  private embedder: any | null = null;

  public constructor(modelName?: string) {
    // Resolution precedence: explicit ctor arg > MODEL_NAME env var > default model
    this.modelName =
      modelName?.trim() || process.env.MODEL_NAME?.trim() || "jinaai/jina-embeddings-v2-base-code";
  }

  /** @returns Resolved (possibly defaulted) underlying model identifier. */
  public getModelName(): string {
    return this.modelName;
  }

  /**
   * Configure the @xenova/transformers cache directory for Node.js execution.
   * Should be invoked before {@link init} so model weights are persisted.
   *
   * @param cacheDir Optional explicit directory. Falls back to TRANSFORMERS_CACHE,
   *                 then a project-local .cache/transformers folder.
   * @returns Resolved cache directory path actually used.
   */
  public static async configureCache(cacheDir?: string): Promise<string> {
    const dir =
      cacheDir?.trim() ||
      process.env.TRANSFORMERS_CACHE?.trim() ||
      "" ||
      path.resolve(process.cwd(), ".cache/transformers");
    try {
      await fs.mkdir(dir, { recursive: true }).catch(() => {
        /* noop */
      });
    } catch {
      // ignore
    }
    env.useBrowserCache = false; // ensure filesystem cache in Node
    env.cacheDir = dir;
    env.allowLocalModels = true;
    console.error(`[MCP] Using TRANSFORMERS cache at: ${env.cacheDir}`);
    return dir;
  }

  /** Lazily initialize the underlying embedding pipeline (idempotent). */
  public async init(): Promise<void> {
    if (this.embedder) return; // already initialized
    console.error(`[MCP] Loading embedding model: ${this.modelName}`);
    this.embedder = await pipeline("feature-extraction", this.modelName);
    console.error(`[MCP] Model ready: ${this.modelName}`);
  }

  /**
   * Compute an embedding for a single text string using mean pooling and
   * L2 normalization (as provided by the pipeline options).
   *
   * @param text Input text (no length hard limit enforced here but extremely
   *             large inputs may be truncated by the model tokenizer).
   * @returns Normalized embedding vector.
   * @throws Error if {@link init} has not been called.
   */
  public async embed(text: string): Promise<Float32Array> {
    if (!this.embedder) throw new Error("Embedder not initialized. Call init() first.");
    const output = await this.embedder(text, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  }

  /**
   * Compute cosine similarity between two Float32 vectors. Length mismatch is
   * handled by comparing up to the shortest length.
   *
   * @param a First embedding vector
   * @param b Second embedding vector
   * @returns Cosine similarity in range [-1, 1]
   */
  public static cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0,
      na = 0,
      nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i],
        y = b[i];
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
  }
}
