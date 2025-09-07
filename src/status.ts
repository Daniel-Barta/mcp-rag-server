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

export const status: ServerStatus = {
  version: "0.3.0",
  repoRoot: "",
  modelName: "",
  transport: "unknown",
  ready: false,
  startedAt: new Date().toISOString(),
  indexing: { filesDiscovered: 0, chunksTotal: 0, chunksEmbedded: 0 },
};

export function markTransport(t: string) {
  status.transport = t;
}

export function setRepoRoot(root: string) {
  status.repoRoot = root;
}

export function setModelName(name: string) {
  status.modelName = name;
}

export function setIndexTotals(files: number, chunks: number) {
  status.indexing.filesDiscovered = files;
  status.indexing.chunksTotal = chunks;
}

export function incEmbedded(count = 1) {
  status.indexing.chunksEmbedded += count;
}

export function markReady() {
  status.ready = true;
}
