import { pipeline, FeatureExtractionPipeline } from "@huggingface/transformers";

/** Small epsilon value to prevent division by zero in cosine similarity. */
const COSINE_EPSILON = 1e-10;

/** Default number of inputs to send in one OpenAI-compatible embeddings request. */
const DEFAULT_OPENAI_EMBEDDING_BATCH_SIZE = 200;

/** Default embedding model used when none is specified. */
export const DEFAULT_EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-code";

/** Supported embedding backends. */
export type EmbeddingProvider = "local" | "openai";

/** Error thrown when attempting to embed before initialization. */
export class EmbedderNotInitializedError extends Error {
  constructor() {
    super("Embedder not initialized. Call init() first.");
    this.name = "EmbedderNotInitializedError";
  }
}

/** Error thrown when embedding provider configuration is invalid. */
export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

/** Converts a raw API embedding array to a typed Float32Array, validating numeric values. */
function toEmbeddingVector(values: unknown): Float32Array {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("[MCP] Invalid embeddings API response: missing embedding vector.");
  }

  const normalized = values.map((value) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      throw new Error(
        "[MCP] Invalid embeddings API response: embedding contains non-numeric values.",
      );
    }
    return numericValue;
  });

  return new Float32Array(normalized);
}

/**
 * Converts the `data` array from an OpenAI-compatible embeddings response into ordered
 * Float32Array vectors, sorting by the `index` field to handle out-of-order responses.
 */
function toEmbeddingVectors(
  data: Array<{
    embedding?: unknown;
    index?: unknown;
  }>,
  expectedCount: number,
): Float32Array[] {
  if (data.length !== expectedCount) {
    throw new Error(
      `[MCP] Invalid embeddings API response: expected ${expectedCount} embeddings, received ${data.length}.`,
    );
  }

  return [...data]
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((item) => toEmbeddingVector(item.embedding));
}

/**
 * Encapsulates embedding model initialization and helper utilities for
 * generating embeddings + computing cosine similarity.
 * A single instance can be reused for any number of embed() calls.
 */
export class Embeddings {
  private readonly modelName: string;
  private readonly provider: EmbeddingProvider;
  private readonly apiBaseUrl: string | null;
  private readonly apiKey: string | null;
  private readonly apiBatchSize: number;
  private embedder: FeatureExtractionPipeline | null = null;
  private initialized = false;

  public constructor(modelName?: string) {
    const rawProvider = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
    if (!rawProvider) {
      this.provider = "local";
    } else if (rawProvider === "local" || rawProvider === "openai") {
      this.provider = rawProvider;
    } else {
      throw new EmbeddingConfigError(
        `Unsupported EMBEDDING_PROVIDER '${process.env.EMBEDDING_PROVIDER}'. Expected 'local' or 'openai'.`,
      );
    }

    // Resolution precedence: explicit ctor arg > MODEL_NAME env var > default model
    this.modelName = modelName?.trim() || process.env.MODEL_NAME?.trim() || DEFAULT_EMBEDDING_MODEL;
    this.apiBaseUrl = process.env.EMBEDDING_API_BASE_URL?.trim() || null;
    this.apiKey = process.env.EMBEDDING_API_KEY?.trim() || null;

    const rawBatchSize = process.env.EMBEDDING_API_BATCH_SIZE;
    if (!rawBatchSize?.trim()) {
      this.apiBatchSize = DEFAULT_OPENAI_EMBEDDING_BATCH_SIZE;
    } else {
      const parsed = Number.parseInt(rawBatchSize, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new EmbeddingConfigError(
          `EMBEDDING_API_BATCH_SIZE must be a positive integer. Received '${rawBatchSize}'.`,
        );
      }
      this.apiBatchSize = parsed;
    }
  }

  /** @returns Resolved (possibly defaulted) underlying model identifier. */
  public getModelName(): string {
    return this.modelName;
  }

  /** @returns Stable provider/model identity for persistence compatibility checks. */
  public getModelIdentity(): string {
    return `${this.provider}:${this.modelName}`;
  }

  /** @returns Recommended request batch size for indexing operations. */
  public getBatchSize(): number {
    return this.provider === "openai" ? this.apiBatchSize : 1;
  }

  /** Builds and returns the resolved embeddings endpoint URL. Throws if the base URL is missing or invalid. */
  private getApiEmbeddingsEndpoint(): URL {
    if (!this.apiBaseUrl) {
      throw new EmbeddingConfigError(
        "EMBEDDING_API_BASE_URL is required when EMBEDDING_PROVIDER=openai.",
      );
    }

    try {
      const base = this.apiBaseUrl.endsWith("/") ? this.apiBaseUrl : `${this.apiBaseUrl}/`;
      return new URL("embeddings", base);
    } catch {
      throw new EmbeddingConfigError(
        `EMBEDDING_API_BASE_URL must be a valid URL. Received '${this.apiBaseUrl}'.`,
      );
    }
  }

  /** Lazily initialize the underlying embedding pipeline (idempotent). */
  public async init(): Promise<void> {
    if (this.initialized) return;

    if (this.provider === "openai") {
      // Validate API configuration; getApiEmbeddingsEndpoint throws if base URL is missing/invalid.
      this.getApiEmbeddingsEndpoint();
      if (!this.apiKey) {
        throw new EmbeddingConfigError(
          "EMBEDDING_API_KEY is required when EMBEDDING_PROVIDER=openai.",
        );
      }
      console.error(`[MCP] Using embeddings API: ${this.getApiEmbeddingsEndpoint().toString()}`);
      console.error(`[MCP] Remote embedding model configured: ${this.modelName}`);
      console.error(`[MCP] Remote embedding batch size: ${this.apiBatchSize}`);
      this.initialized = true;
      return;
    }

    console.error(`[MCP] Loading embedding model: ${this.modelName}`);
    this.embedder = (await (pipeline as any)("feature-extraction", this.modelName, {
      dtype: "q8", // Use quantized model for smaller download size
    })) as FeatureExtractionPipeline;
    console.error(`[MCP] Model ready: ${this.modelName}`);
    this.initialized = true;
  }

  /** Sends a single HTTP request to the embeddings API and returns the resulting vectors. */
  private async embedViaApiBatch(texts: string[]): Promise<Float32Array[]> {
    // Some remote APIs reject empty strings; substitute a single space.
    const normalizedTexts = texts.map((text) => (text.length > 0 ? text : " "));
    const response = await fetch(this.getApiEmbeddingsEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelName,
        input: normalizedTexts,
        encoding_format: "float",
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(
        `[MCP] Embeddings API request failed (${response.status} ${response.statusText}): ${detail.slice(0, 400)}`,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{
        embedding?: unknown;
        index?: unknown;
      }>;
    };
    return toEmbeddingVectors(payload.data ?? [], normalizedTexts.length);
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
    if (!this.initialized) throw new EmbedderNotInitializedError();
    const trimmed = text.trim();

    if (this.provider === "openai") {
      const [embedding] = await this.embedViaApiBatch([trimmed]);
      return embedding!;
    }

    const output = await this.embedder!(trimmed, { pooling: "mean", normalize: true });
    return output.data as Float32Array;
  }

  /**
   * Compute embeddings for multiple text strings. OpenAI-compatible providers are
   * called in request batches; local inference falls back to the existing
   * single-item path to preserve current behavior.
   */
  public async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (!this.initialized) throw new EmbedderNotInitializedError();
    if (texts.length === 0) return [];

    const trimmedTexts = texts.map((text) => text.trim());

    if (this.provider === "openai") {
      const embeddings: Float32Array[] = [];
      for (let i = 0; i < trimmedTexts.length; i += this.apiBatchSize) {
        embeddings.push(
          ...(await this.embedViaApiBatch(trimmedTexts.slice(i, i + this.apiBatchSize))),
        );
      }
      return embeddings;
    }

    const embeddings: Float32Array[] = [];
    for (const text of trimmedTexts) {
      embeddings.push(await this.embed(text));
    }
    return embeddings;
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
