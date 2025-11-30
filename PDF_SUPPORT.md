# PDF Support in mcp-rag-server

## Overview

The MCP RAG server now supports indexing and retrieving text from PDF files alongside regular text files. PDF text extraction is automatic and cached for performance.

## How It Works

### During Indexing

1. When a PDF file is discovered during indexing, the server automatically extracts text using the `pdf-parse` library
2. Extracted text is cached in a unified cache file at the repository root
3. The cache file is stored as JSON with metadata including:
   - Original PDF path
   - File size (for cache invalidation)
   - Extraction timestamp
   - Extracted text content
   - Page count

### During read_file Operations

When `read_file` is called on a PDF file:

1. The server checks if cached text exists and is valid (file size matches)
2. If valid cache exists, text is read directly from the JSON cache (fast)
3. If cache is missing or stale, an error is returned (the file needs to be re-indexed)

## Cache Structure

All PDF text extractions are stored in a single unified cache file located in the same directory as `INDEX_STORE_PATH` (or the repository root if not specified):

```
pdf-text-cache.json
```

Cache file format:

```json
{
  "version": 1,
  "entries": {
    "/absolute/path/to/docs/manual.pdf": {
      "pdfPath": "docs/manual.pdf",
      "pdfSize": 12345,
      "extractedAt": "2024-01-01T00:00:00.000Z",
      "text": "Extracted text content...",
      "pageCount": 10
    },
    "/absolute/path/to/other/guide.pdf": {
      "pdfPath": "other/guide.pdf",
      "pdfSize": 67890,
      "extractedAt": "2024-01-02T00:00:00.000Z",
      "text": "Another PDF's text...",
      "pageCount": 5
    }
  }
}
```

The cache uses absolute paths as keys to ensure uniqueness across the repository.

## Configuration

### Enable PDF Indexing

PDF support is enabled by default. The `pdf` extension is included in the default `ALLOWED_EXT` list.

To explicitly configure:

```bash
# Include PDFs (along with other formats)
export ALLOWED_EXT="ts,js,md,txt,pdf"
```

### Exclude PDFs

To disable PDF indexing, set `ALLOWED_EXT` without including `pdf`:

```bash
export ALLOWED_EXT="ts,js,md,txt"
```

### Cache Location

The unified PDF cache file (`pdf-text-cache.json`) is stored in the same directory as your `INDEX_STORE_PATH` configuration. If `INDEX_STORE_PATH` is not set, it defaults to the repository root.

To ensure Git ignores the cache, add to `.gitignore`:

```
pdf-text-cache.json
```

## Cache Invalidation

The cache is automatically invalidated and regenerated when:

- PDF file size changes
- Cache file doesn't exist
- Cache file is corrupted or unparseable

**Note:** Currently, cache invalidation uses file size as a heuristic. If a PDF is modified but maintains the same size, you may need to manually delete the cache to force re-extraction.

## Performance

- **First indexing**: PDF text extraction adds overhead (depends on PDF size/complexity)
- **Subsequent indexing**: Cache hits are fast (JSON read only)
- **read_file operations**: Near-instant for cached PDFs (no PDF parsing)

## Limitations

1. **Cache invalidation**: Uses file size heuristic (content changes with same size won't auto-refresh)
2. **Sequential extraction**: PDFs are processed one at a time during indexing
3. **Text-only**: Images, tables, and complex formatting are not preserved (plain text extraction only)
4. **Memory**: Large PDFs with extensive text may consume significant memory during extraction

## Troubleshooting

### "PDF text not available" error

This occurs when calling `read_file` on a PDF that hasn't been indexed:

- **Solution**: Run a full index rebuild or ensure the PDF is included in `ALLOWED_EXT`

### Empty or garbled text

Some PDFs (scanned documents, image-based) may not contain extractable text:

- **Solution**: Use OCR preprocessing or exclude these PDFs from indexing

### Slow indexing with many PDFs

PDF text extraction is CPU-intensive:

- **Solution**:
  - Use `INDEX_STORE_PATH` for incremental updates
  - Consider excluding large/unnecessary PDFs via `EXCLUDED_FOLDERS`
  - Set `VERBOSE=1` to monitor progress

## Implementation Details

### New Files

- `src/pdf-extractor.ts`: Core PDF extraction and caching logic

### Modified Files

- `src/index.ts`: Updated `read_file` handler to check for PDFs and read from cache
- `src/indexer.ts`: Updated file processing to detect and extract text from PDFs
- `src/config.ts`: Added `pdf` to default `ALLOWED_EXT`

### Dependencies

- `pdf-parse` (v2.4.5): PDF text extraction library
- `@types/pdf-parse`: TypeScript type definitions
