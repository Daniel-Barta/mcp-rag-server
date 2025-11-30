/**
 * PDF text extraction and caching module.
 *
 * This module provides functionality to extract text from PDF files and store
 * the extracted text in a unified JSON cache file for fast retrieval. Once extracted,
 * text is read from the cache rather than re-parsing the PDF.
 *
 * Cache structure:
 *   All PDF extractions are stored in a single pdf-text-cache.json file located
 *   in the same directory as INDEX_STORE_PATH (or repository root if not specified).
 *   The cache file structure is:
 *   {
 *     "version": 1,
 *     "entries": {
 *       "/absolute/path/to/file.pdf": {
 *         "pdfPath": "relative/path/to/file.pdf",
 *         "pdfSize": 12345,                    // file size in bytes
 *         "extractedAt": "2024-01-01T00:00:00Z",
 *         "text": "extracted text content...",
 *         "pageCount": 10
 *       }
 *     }
 *   }
 *
 * Cache invalidation:
 *   Cache is considered stale if:
 *     - Cache file doesn't exist
 *     - PDF file size has changed (simple heuristic)
 *     - Cache file is corrupt / unparseable
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";

/**
 * Metadata stored in the JSON cache alongside extracted text.
 */
export interface PdfCacheEntry {
  pdfPath: string;
  pdfSize: number;
  extractedAt: string;
  text: string;
  pageCount: number;
}

/**
 * Structure of the unified PDF cache file.
 */
interface PdfCacheStore {
  version: number;
  entries: Record<string, PdfCacheEntry>;
}

/**
 * PDF text extraction utility with automatic caching.
 */
export class PdfExtractor {
  private readonly cacheFilePath: string;
  private readonly verbose: boolean;
  private cacheStore: PdfCacheStore | null = null;

  /**
   * @param indexStorePath Optional path to index store (determines cache file location)
   * @param root Absolute path to repository root (fallback if indexStorePath not provided)
   * @param verbose Enable additional logging
   */
  constructor(indexStorePath: string | undefined, root: string, verbose = false) {
    // Place cache file in same directory as index store, or root if not specified
    const cacheDir = indexStorePath ? path.dirname(indexStorePath) : root;
    this.cacheFilePath = path.join(cacheDir, "pdf-text-cache.json");
    this.verbose = verbose;
  }

  /**
   * Load the unified cache store from disk.
   */
  private async loadCacheStore(): Promise<void> {
    if (this.cacheStore !== null) return; // Already loaded

    try {
      const cacheJson = await fs.readFile(this.cacheFilePath, "utf8");
      this.cacheStore = JSON.parse(cacheJson);
      if (!this.cacheStore || typeof this.cacheStore.entries !== "object") {
        this.cacheStore = { version: 1, entries: {} };
      }
    } catch {
      // Cache file doesn't exist or is corrupt, start fresh
      this.cacheStore = { version: 1, entries: {} };
    }
  }

  /**
   * Save the unified cache store to disk.
   */
  private async saveCacheStore(): Promise<void> {
    if (!this.cacheStore) return;

    try {
      const cacheDir = path.dirname(this.cacheFilePath);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(this.cacheFilePath, JSON.stringify(this.cacheStore, null, 2), "utf8");
    } catch (e) {
      console.error(`[PDF] Failed to save cache store:`, e);
    }
  }

  /**
   * Check if cached text exists and is valid for the given PDF.
   * @param pdfAbsPath Absolute path to the PDF file
   * @param pdfSize Current size of the PDF file (for invalidation check)
   * @returns Cached entry if valid, null otherwise
   */
  private async getCachedText(pdfAbsPath: string, pdfSize: number): Promise<PdfCacheEntry | null> {
    await this.loadCacheStore();

    const entry = this.cacheStore!.entries[pdfAbsPath];
    if (!entry) {
      if (this.verbose) {
        console.error(`[PDF] Cache miss for ${path.basename(pdfAbsPath)}`);
      }
      return null;
    }

    // Validate cache: size must match (simple change detection heuristic)
    if (entry.pdfSize === pdfSize && entry.text) {
      if (this.verbose) {
        console.error(`[PDF] Cache hit for ${path.basename(pdfAbsPath)}`);
      }
      return entry;
    } else {
      if (this.verbose) {
        console.error(`[PDF] Cache stale for ${path.basename(pdfAbsPath)} (size mismatch)`);
      }
      return null;
    }
  }

  /**
   * Save extracted text to cache.
   * @param pdfAbsPath Absolute path to the PDF file
   * @param entry Cache entry to save
   */
  private async saveCachedText(pdfAbsPath: string, entry: PdfCacheEntry): Promise<void> {
    await this.loadCacheStore();

    this.cacheStore!.entries[pdfAbsPath] = entry;
    await this.saveCacheStore();

    if (this.verbose) {
      console.error(`[PDF] Cached text for ${path.basename(pdfAbsPath)}`);
    }
  }

  /**
   * Extract text from a PDF file, using cache if available.
   * @param pdfAbsPath Absolute path to the PDF file
   * @param pdfRelPath Relative path (for cache metadata)
   * @param pdfSize File size in bytes
   * @returns Extracted text content
   */
  public async extractText(
    pdfAbsPath: string,
    pdfRelPath: string,
    pdfSize: number,
  ): Promise<string> {
    // Check cache first
    const cached = await this.getCachedText(pdfAbsPath, pdfSize);
    if (cached) {
      return cached.text;
    }

    // Extract text from PDF
    if (this.verbose) {
      console.error(`[PDF] Extracting text from ${path.basename(pdfAbsPath)}...`);
    }
    try {
      const dataBuffer = await fs.readFile(pdfAbsPath);
      const parser = new PDFParse({ data: dataBuffer });
      const textResult = await parser.getText();
      await parser.destroy();

      const extractedText = textResult.text || "";
      const pageCount = textResult.pages.length;

      // Save to cache
      const entry: PdfCacheEntry = {
        pdfPath: pdfRelPath,
        pdfSize,
        extractedAt: new Date().toISOString(),
        text: extractedText,
        pageCount,
      };
      await this.saveCachedText(pdfAbsPath, entry);

      return extractedText;
    } catch (e) {
      console.error(`[PDF] Failed to extract text from ${path.basename(pdfAbsPath)}:`, e);
      // Return empty string on failure to allow indexing to continue
      return "";
    }
  }

  /**
   * Get cached text for a PDF if available, without extraction.
   * Used by read_file to retrieve text from cache.
   * @param pdfAbsPath Absolute path to the PDF file
   * @param pdfSize Current file size (for validation)
   * @returns Cached text if valid, null otherwise
   */
  public async getFromCache(pdfAbsPath: string, pdfSize: number): Promise<string | null> {
    const cached = await this.getCachedText(pdfAbsPath, pdfSize);
    return cached ? cached.text : null;
  }

  /**
   * Check if a file is a PDF based on its extension.
   * @param filePath File path to check
   * @returns True if file has .pdf extension (case-insensitive)
   */
  public static isPdf(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".pdf";
  }
}
