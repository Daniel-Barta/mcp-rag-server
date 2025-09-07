import fs from "node:fs/promises";
import path from "node:path";
import { env, pipeline } from "@xenova/transformers";

/**
 * Embeddings class encapsulates model initialization, cache configuration,
 * embedding generation and cosine similarity helpers.
 */
export class Embeddings {
  private modelName: string;
  private embedder: any | null = null;

  constructor(modelName?: string) {
    // Precedence: explicit constructor arg > MODEL_NAME env > default
    this.modelName =
      modelName?.trim() || process.env.MODEL_NAME?.trim() || "jinaai/jina-embeddings-v2-base-code";
  }

  /** Expose current model name */
  getModelName(): string {
    return this.modelName;
  }

  /**
   * Configure @xenova/transformers cache directory for Node.js.
   * Should be called before first init() to ensure on-disk cache usage.
   */
  static async configureCache(cacheDir?: string): Promise<string> {
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

  /**
   * Lazily initialize the underlying embedding pipeline.
   */
  async init(): Promise<void> {
    if (this.embedder) return; // already initialized
    console.error(`[MCP] Loading embedding model: ${this.modelName}`);
    this.embedder = await pipeline("feature-extraction", this.modelName);
    console.error(`[MCP] Model ready: ${this.modelName}`);
  }

  /**
   * Compute an embedding for the given text (mean pooling + normalization).
   * Ensures the model is initialized.
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.embedder) throw new Error("Embedder not initialized. Call init() first.");
    const output = await this.embedder(text, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  }

  /**
   * Cosine similarity between two vectors.
   */
  static cosine(a: Float32Array, b: Float32Array): number {
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
