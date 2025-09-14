/**
 * Shared document/chunk type used throughout the indexing + persistence layers.
 * Represents a single chunk of source content with an optional embedding.
 */
export type Doc = {
  id: string; // monotonically increasing string id (session-local)
  path: string; // file path relative to repo root
  chunk: number; // chunk index within the file
  text: string; // chunk text content
  fileSize: number; // original full file size in bytes (duplicated per chunk)
  lineCount: number; // total number of lines in the full original file (duplicated per chunk)
  emb?: Float32Array; // embedding vector (once generated / loaded)
};
