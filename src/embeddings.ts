import fs from "node:fs/promises";
import path from "node:path";
import { env, pipeline } from "@xenova/transformers";

let embedder: any | null = null;

/**
 * Configure @xenova/transformers cache directory for Node.js.
 * Returns the cache directory being used.
 */
export async function configureTransformersCache(cacheDir?: string): Promise<string> {
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
 * Initialize the sentence embedding pipeline.
 * Default model is Xenova/bge-base-en-v1.5. You can override via parameter or MODEL_NAME env.
 */
export async function initEmbedder(modelName?: string) {
  const model = modelName?.trim() || process.env.MODEL_NAME?.trim() || "Xenova/bge-base-en-v1.5";
  embedder = await pipeline("feature-extraction", model);
}

/**
 * Compute an embedding for the given text (mean pooling + normalization).
 * Call initEmbedder() once before using this function.
 */
export async function embedText(text: string): Promise<Float32Array> {
  if (!embedder) throw new Error("Embedder not initialized. Call initEmbedder() first.");
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return output.data as Float32Array;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
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
