/**
 * Transformers cache configuration utility.
 *
 * Extracted as a standalone module to avoid circular dependencies and
 * reduce coupling between config and embeddings modules.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@xenova/transformers";

/**
 * Configure the @xenova/transformers cache directory for Node.js execution.
 * Should be invoked early in startup, before any model/pipeline is created.
 *
 * @param cacheDir Optional explicit directory. Falls back to TRANSFORMERS_CACHE,
 *                 then a project-local .cache/transformers folder.
 * @returns Resolved cache directory path actually used.
 */
export async function configureTransformersCache(cacheDir?: string): Promise<string> {
  const dir =
    cacheDir?.trim() ||
    process.env.TRANSFORMERS_CACHE?.trim() ||
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
