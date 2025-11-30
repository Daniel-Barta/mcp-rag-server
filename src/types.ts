/**
 * Shared document/chunk type used throughout the indexing + persistence layers.
 * Represents a single chunk of source content with an optional embedding.
 */
export interface Doc {
  /** Monotonically increasing string id (session-local). */
  readonly id: string;
  /** File path relative to repo root. */
  readonly path: string;
  /** Chunk index within the file (0-based). */
  readonly chunk: number;
  /** Chunk text content. */
  readonly text: string;
  /** Original full file size in bytes (duplicated per chunk for convenience). */
  readonly fileSize: number;
  /** Total number of lines in the full original file (duplicated per chunk). */
  readonly lineCount: number;
  /** Embedding vector (populated after generation / load). */
  emb?: Float32Array;
}

/** Read-only view of a Doc for external consumers. */
export type ReadonlyDoc = Readonly<Doc>;
