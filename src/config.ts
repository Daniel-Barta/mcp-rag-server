import { configureTransformersCache } from "./cache";
import dotenv from "dotenv";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Import version directly from package.json (requires tsconfig "resolveJsonModule": true)
import pkg from "../package.json" with { type: "json" };

// Centralized single dotenv.config() call.
// If executing compiled code inside build/, resolve ../.env (project root). Otherwise use default.
// Keeping this logic isolated avoids multiple dotenv loads & accidental override order issues.
(() => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const rootEnv = path.resolve(__dirname, "../.env");
    if (fsSync.existsSync(rootEnv)) {
      dotenv.config({ path: rootEnv });
      return;
    }
  } catch {
    /* ignore and fall back */
  }
  dotenv.config();
})();

/** Application version sourced from package.json. */
export const APP_VERSION: string = pkg.version;

/** Parse a boolean from environment variable (supports 1/true/yes/on). */
function parseEnvBool(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Parse a number from environment variable with default and optional min/max clamping. */
function parseEnvNumber(
  value: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number,
): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  let result = Math.floor(n);
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

export interface Config {
  ROOT: string;
  ALLOWED_EXT: string[];
  EXCLUDED_FOLDERS: string[];
  VERBOSE: boolean;
  CHUNK_SIZE: number;
  CHUNK_OVERLAP: number;
  FOLDER_INFO_NAME: string;
  INDEX_STORE_PATH: string | undefined;
  MCP_TRANSPORT: string;
  DOCS_PER_FILE: number;
}

export async function getConfig(): Promise<Config> {
  // Configure transformers cache directory ASAP, before any model/pipeline is created.
  // Doing this early ensures downstream libraries (e.g. HuggingFace) honor the path.
  await configureTransformersCache().catch((e) =>
    console.error("[MCP] Failed to set TRANSFORMERS cache directory:", e),
  );

  // Canonical repository root. If unset we keep a conspicuous placeholder to nudge configuration.
  const ROOT = process.env.REPO_ROOT?.trim() || "C:/path/to/your/repository";

  // Normalize ALLOWED_EXT once; downstream components assume a clean string[].
  const ALLOWED_EXT = process.env.ALLOWED_EXT?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [
    // Common code/text extensions (customize via ALLOWED_EXT)
    "ts",
    "tsx",
    "js",
    "jsx",
    "py",
    "cs",
    "java",
    "kt",
    "kts",
    "go",
    "rs",
    "cpp",
    "c",
    "h",
    "hpp",
    "rb",
    "php",
    "swift",
    "scala",
    "md",
    "txt",
    "gradle",
    "groovy",
    "json",
    "yaml",
    "yml",
    "xml",
    "proto",
    "properties",
    "pdf",
  ];

  // Folder names (not globs) pruned early during directory traversal.
  const EXCLUDED_FOLDERS = process.env.EXCLUDED_FOLDERS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [
    // Common folders to exclude (customize via EXCLUDED_FOLDERS)
    "node_modules",
    "dist",
    "build",
    ".git",
    "target",
    "bin",
    "obj",
    ".cache",
    "coverage",
    ".nyc_output",
  ];

  // Verbosity toggle
  const VERBOSE = parseEnvBool(process.env.VERBOSE);

  // Chunk sizing (optional env overrides; defaults 800 / 120)
  // Chunk size impacts recall (too large) vs. precision (too small). Trade‑off is tunable.
  const CHUNK_SIZE = parseEnvNumber(process.env.CHUNK_SIZE, 800, 1, 8000);

  // Overlap helps preserve context continuity across semantic chunks.
  const CHUNK_OVERLAP = parseEnvNumber(process.env.CHUNK_OVERLAP, 120, 0, 4000);

  // Human‑friendly label used purely in tool descriptions; does not affect disk paths.
  const FOLDER_INFO_NAME = process.env.FOLDER_INFO_NAME?.trim() || "REPO_ROOT";

  // Optional path to persist / reload serialized index artifacts.
  const INDEX_STORE_PATH = process.env.INDEX_STORE_PATH?.trim() || undefined;

  // Transport mode: 'stdio' (default) or 'http'.
  const MCP_TRANSPORT = (process.env.MCP_TRANSPORT ?? "").trim().toLowerCase();

  // Maximum documents per JSON file for persistence (default 10000).
  const DOCS_PER_FILE = parseEnvNumber(process.env.DOCS_PER_FILE, 10000, 100);

  return {
    ROOT,
    ALLOWED_EXT,
    EXCLUDED_FOLDERS,
    VERBOSE,
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    FOLDER_INFO_NAME,
    INDEX_STORE_PATH,
    MCP_TRANSPORT,
    DOCS_PER_FILE,
  };
}
