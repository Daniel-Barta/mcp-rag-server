import { pipeline, FeatureExtractionPipeline } from "@huggingface/transformers";

/** Small epsilon value to prevent division by zero in cosine similarity. */
const COSINE_EPSILON = 1e-10;

/** Default embedding model used when none is specified. */
export const DEFAULT_EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-code";

/** Supported embedding backends. */
export type EmbeddingProvider = "local" | "openai";

const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProvider = "local";

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

function resolveEmbeddingProvider(rawProvider: string | undefined): EmbeddingProvider {
  const provider = rawProvider?.trim().toLowerCase();
  if (!provider) return DEFAULT_EMBEDDING_PROVIDER;
  if (provider === "local" || provider === "openai") return provider;
  throw new EmbeddingConfigError(
    `Unsupported EMBEDDING_PROVIDER '${rawProvider}'. Expected 'local' or 'openai'.`,
  );
}

function ensureUrlHasTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

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
 * Encapsulates embedding model initialization and helper utilities for
 * generating embeddings + computing cosine similarity.
 * A single instance can be reused for any number of embed() calls.
 */
export class Embeddings {
  private readonly modelName: string;
  private readonly provider: EmbeddingProvider;
  private readonly apiBaseUrl: string | null;
  private readonly apiKey: string | null;
  private embedder: FeatureExtractionPipeline | null = null;
  private initialized = false;

  public constructor(modelName?: string) {
    this.provider = resolveEmbeddingProvider(process.env.EMBEDDING_PROVIDER);
    // Resolution precedence: explicit ctor arg > MODEL_NAME env var > default model
    this.modelName = modelName?.trim() || process.env.MODEL_NAME?.trim() || DEFAULT_EMBEDDING_MODEL;
    this.apiBaseUrl = process.env.EMBEDDING_API_BASE_URL?.trim() || null;
    this.apiKey = process.env.EMBEDDING_API_KEY?.trim() || null;
  }

  /** @returns Resolved (possibly defaulted) underlying model identifier. */
  public getModelName(): string {
    return this.modelName;
  }

  /** @returns Stable provider/model identity for persistence compatibility checks. */
  public getModelIdentity(): string {
    return `${this.provider}:${this.modelName}`;
  }

  private getApiEmbeddingsEndpoint(): URL {
    if (!this.apiBaseUrl) {
      throw new EmbeddingConfigError(
        "EMBEDDING_API_BASE_URL is required when EMBEDDING_PROVIDER=openai.",
      );
    }

    try {
      return new URL("embeddings", ensureUrlHasTrailingSlash(this.apiBaseUrl));
    } catch {
      throw new EmbeddingConfigError(
        `EMBEDDING_API_BASE_URL must be a valid URL. Received '${this.apiBaseUrl}'.`,
      );
    }
  }

  private validateApiConfiguration(): void {
    this.getApiEmbeddingsEndpoint();
    if (!this.apiKey) {
      throw new EmbeddingConfigError(
        "EMBEDDING_API_KEY is required when EMBEDDING_PROVIDER=openai.",
      );
    }
  }

  /** Lazily initialize the underlying embedding pipeline (idempotent). */
  public async init(): Promise<void> {
    if (this.initialized) return;

    if (this.provider === "openai") {
      this.validateApiConfiguration();
      console.error(`[MCP] Using embeddings API: ${this.getApiEmbeddingsEndpoint().toString()}`);
      console.error(`[MCP] Remote embedding model configured: ${this.modelName}`);
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

  private async embedViaApi(text: string): Promise<Float32Array> {
    const response = await fetch(this.getApiEmbeddingsEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelName,
        input: text,
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
      }>;
    };
    return toEmbeddingVector(payload.data?.[0]?.embedding);
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
      return await this.embedViaApi(trimmed);
    }

    if (!this.embedder) throw new EmbedderNotInitializedError();
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
