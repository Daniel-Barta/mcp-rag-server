import { APP_VERSION } from "./config";

/**
 * Aggregated counters for indexing / embedding pipeline progress.
 * All values are monotonic, non‑negative integers updated in-place.
 */
export interface IndexingStatus {
  /** Total number of source files discovered that matched the allow-list. */
  filesDiscovered: number;
  /** Total number of text chunks produced after splitting all discovered files. */
  chunksTotal: number;
  /** Number of chunks that have successfully had embeddings generated so far. */
  chunksEmbedded: number;
}

/**
 * Mutable in-memory snapshot of server lifecycle + indexing progress.
 * Exposed read-only to external callers via `statusManager.getStatus()`.
 *
 * ready = true ONLY after every discovered chunk has an embedding (i.e. initial
 * indexing + embedding build completed). During incremental progress, counts
 * are updated but `ready` remains false.
 */
export interface ServerStatus {
  /** Package / server version (kept in sync with package.json). */
  version: string;
  /** Repository root path being indexed. */
  repoRoot: string;
  /** Name / identifier of the loaded embedding model (may be empty pre-init). */
  modelName: string;
  /** Active transport in use: 'stdio' | 'http' | 'unknown'. */
  transport: string;
  /** True once all embeddings are generated for initial index build. */
  ready: boolean;
  /** ISO timestamp when the process (or StatusManager) started. */
  startedAt: string;
  /** Nested indexing progress counters. */
  indexing: IndexingStatus;
}

/**
 * Class wrapper around mutable server status state. Avoids ad-hoc mutation and
 * centralizes any future validation or side-effects.
 */
export class StatusManager {
  /** Internal mutable status object. */
  private readonly data: ServerStatus;

  public constructor(initial?: Partial<ServerStatus>) {
    this.data = {
      version: initial?.version ?? APP_VERSION,
      repoRoot: initial?.repoRoot ?? "",
      modelName: initial?.modelName ?? "",
      transport: initial?.transport ?? "unknown",
      ready: initial?.ready ?? false,
      startedAt: initial?.startedAt ?? new Date().toISOString(),
      indexing: initial?.indexing ?? {
        filesDiscovered: 0,
        chunksTotal: 0,
        chunksEmbedded: 0,
      },
    };
  }

  /** Record the concrete transport selected at runtime. */
  public markTransport(t: string) {
    this.data.transport = t;
  }

  /** Set repository root being indexed (usually once, early in startup). */
  public setRepoRoot(root: string) {
    this.data.repoRoot = root;
  }

  /** Store the resolved model identifier/name after embedding init. */
  public setModelName(name: string) {
    this.data.modelName = name;
  }

  /** Initialize / update total file + chunk counts discovered during build(). */
  public setIndexTotals(files: number, chunks: number) {
    this.data.indexing.filesDiscovered = files;
    this.data.indexing.chunksTotal = chunks;
  }

  /** Increment the number of chunks that have embeddings generated. */
  public incEmbedded(count = 1) {
    this.data.indexing.chunksEmbedded += count;
  }

  /** Mark embeddings pipeline as fully complete (transition ready=false -> true). */
  public markReady() {
    this.data.ready = true;
  }

  /** Access a live reference to current status (treat as read-only). */
  public getStatus(): ServerStatus {
    return this.data;
  }

  /** JSON serialization helper (returns underlying object). */
  public toJSON() {
    return this.data;
  }
}

// Singleton instance used across modules (indexer, transports, health checks).
export const statusManager = new StatusManager();
