// Shared runtime status exported for health checks and debugging.
export interface IndexingStatus {
  filesDiscovered: number;
  chunksTotal: number;
  chunksEmbedded: number;
}

export interface ServerStatus {
  version: string;
  repoRoot: string;
  modelName: string;
  transport: string; // 'stdio' | 'http' | 'unknown'
  ready: boolean; // embeddings fully built
  startedAt: string;
  indexing: IndexingStatus;
}

/**
 * Class wrapper around mutable server status state.
 * Provides methods instead of ad-hoc mutation while preserving previous function API.
 */
export class StatusManager {
  /** Internal mutable status object (exposed read-only via exported alias). */
  readonly data: ServerStatus;

  constructor(initial?: Partial<ServerStatus>) {
    this.data = {
      version: initial?.version ?? "0.3.0",
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

  markTransport(t: string) {
    this.data.transport = t;
  }
  setRepoRoot(root: string) {
    this.data.repoRoot = root;
  }
  setModelName(name: string) {
    this.data.modelName = name;
  }
  setIndexTotals(files: number, chunks: number) {
    this.data.indexing.filesDiscovered = files;
    this.data.indexing.chunksTotal = chunks;
  }
  incEmbedded(count = 1) {
    this.data.indexing.chunksEmbedded += count;
  }
  markReady() {
    this.data.ready = true;
  }
  /** Access current status snapshot (same object). */
  getStatus(): ServerStatus {
    return this.data;
  }
  toJSON() {
    return this.data;
  }
}

// Singleton instance (mirrors previous module-level mutable object)
export const statusManager = new StatusManager();
// Export direct mutable status object if external read access is still desired.
//export const status: ServerStatus = statusManager.data; // optional; can remove later if unused
