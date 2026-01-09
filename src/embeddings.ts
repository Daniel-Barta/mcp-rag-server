import { pipeline, FeatureExtractionPipeline } from "@xenova/transformers";

/** Small epsilon value to prevent division by zero in cosine similarity. */
const COSINE_EPSILON = 1e-10;

/** Default embedding model used when none is specified. */
export const DEFAULT_EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-code";

/** Error thrown when attempting to embed before initialization. */
export class EmbedderNotInitializedError extends Error {
  constructor() {
    super("Embedder not initialized. Call init() first.");
    this.name = "EmbedderNotInitializedError";
  }
}

/** Error thrown when attempting to embed empty or whitespace-only text. */
export class EmptyTextError extends Error {
  constructor() {
    super("Cannot embed empty or whitespace-only text.");
    this.name = "EmptyTextError";
  }
}

/**
 * Encapsulates embedding model initialization and helper utilities for
 * generating embeddings + computing cosine similarity.
 * A single instance can be reused for any number of embed() calls.
 */
export class Embeddings {
  private readonly modelName: string;
  private embedder: FeatureExtractionPipeline | null = null;

  public constructor(modelName?: string) {
    // Resolution precedence: explicit ctor arg > MODEL_NAME env var > default model
    this.modelName = modelName?.trim() || process.env.MODEL_NAME?.trim() || DEFAULT_EMBEDDING_MODEL;
  }

  /** @returns Resolved (possibly defaulted) underlying model identifier. */
  public getModelName(): string {
    return this.modelName;
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
   * @throws {EmbedderNotInitializedError} If {@link init} has not been called.
   * @throws {EmptyTextError} If text is empty or whitespace-only.
   */
  public async embed(text: string): Promise<Float32Array> {
    if (!this.embedder) throw new EmbedderNotInitializedError();
    const trimmed = text.trim();    
    const output = await this.embedder(trimmed, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  }

  /**
   * Compute cosine similarity between two Float32 vectors. Length mismatch is
   * handled by comparing up to the shortest length.
   *
   * @param a First embedding vector
   * @param b Second embedding vector
   * @returns Cosine similarity in range [-1, 1], or 0 if either vector is empty
   */
  public static cosine(a: Float32Array, b: Float32Array): number {
    if (a.length === 0 || b.length === 0) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      // Non-null assertions are safe here because i < n <= min(a.length, b.length)
      const x = a[i]!;
      const y = b[i]!;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + COSINE_EPSILON);
  }
}
