# mcp-rag-server (local RAG MCP server for any repository)

`mcp-rag-server` is a lightweight, zero‑network (after model download) Retrieval‑Augmented Generation helper you can plug into **any client that speaks the [Model Context Protocol (MCP)]**. GitHub Copilot Agent mode in Visual Studio / VS Code is just one option – you can also use the official MCP Inspector, future MCP‑aware IDEs, or custom tooling.

It indexes a target repository directory, chunks the content (default chunk size **800** chars with **120** char overlap – both configurable via `CHUNK_SIZE` / `CHUNK_OVERLAP`), builds **local embeddings** using `@xenova/transformers`, and exposes two MCP tools:

- `rag_query` – semantic search returning scored snippets (path, score, snippet)
- `read_file` – secure file read (optional line range) constrained to `REPO_ROOT`

Two transports are supported (select with `MCP_TRANSPORT=stdio|http`):

- `stdio` – simplest integration for IDEs that spawn a process (backward compatible default)
- `http` (Streamable HTTP) – recommended for large repos / first run so you can watch logs & poll readiness before attaching a client. Enable via `MCP_TRANSPORT=http`. Includes DNS rebinding protection by default.

## Features

- Pure local embedding inference (no external API calls) via `@xenova/transformers`
- Multi‑language source + docs support (configurable via `ALLOWED_EXT`)
- Fast glob file discovery and overlapping chunking for better recall
- Simple cosine similarity ranking (optionally swap to ANN later)
- Pluggable model selection via `MODEL_NAME` (see guidance below)
- Optional persistent JSON index + warm start & incremental reindexing via `INDEX_STORE_PATH`
- Incremental change detection (additions / deletions / file size changes) to avoid full rebuilds
- Stdio or Streamable HTTP transport (with optional host allow‑list / DNS rebinding protection)
- Safe path handling (rejects attempts to escape `REPO_ROOT`)
- Minimal dependencies; quick startup after first model load
- Ready for extension: add new MCP tools or ANN / hybrid retrieval backends

Planned / Nice‑to‑have: hybrid BM25 + embedding search, ANN acceleration (HNSW / IVF), per‑language tokenizer heuristics, batched / parallel embedding, semantic boundary aware chunking.

## Requirements

- Node.js 18+
- Visual Studio 2022 17.14+ with GitHub Copilot (Agent mode enabled)
- Path to your repository (`REPO_ROOT`)

## Install

npm install
npm run build

## Run (local test)

Build then start (stdio transport by default). Use either `npm start` or invoke the built file directly.

### Windows PowerShell

```
npm run build
$env:REPO_ROOT="C:\path\to\your-repo"; node dist/index.js
```

Or:

```
$env:REPO_ROOT="C:\path\to\your-repo"; npm start
```

### macOS / Linux (bash/zsh)

```
npm run build
export REPO_ROOT="/path/to/your-repo"; node dist/index.js
```

Or:

```
export REPO_ROOT="/path/to/your-repo"; npm start
```

Optionally set a model cache to speed up subsequent runs (first start downloads the model once):

```
export TRANSFORMERS_CACHE="/path/to/cache"   # macOS/Linux
$env:TRANSFORMERS_CACHE="C:\path\to\cache" # Windows PowerShell
```

### Streamable HTTP mode (recommended for large initial indexes)

Run the MCP server as an HTTP endpoint and only open your IDE after `Embeddings ready.` shows (avoids client timeouts on cold start):

```
npm run build
$env:REPO_ROOT="C:\path\to\your-repo"; $env:MCP_TRANSPORT="http"; npm start
```

```
export REPO_ROOT="/path/to/your-repo"; MCP_TRANSPORT=http npm start
```

Default HTTP bind: http://127.0.0.1:3000/mcp. Override with `HOST` and `MCP_PORT` envs. A readiness endpoint is available at `http://127.0.0.1:3000/health` returning JSON like:

```
{
	"version": "0.x.y",
	"repoRoot": "C:/abs/path",
	"modelName": "<embedding model>",
	"transport": "stdio" | "http",
	"ready": true | false,
	"startedAt": "2025-01-01T00:00:00.000Z",
	"indexing": {
		"filesDiscovered": 123,
		"chunksTotal": 456,
		"chunksEmbedded": 456
	}
}
```

`ready` flips to true only once all discovered chunks have embeddings (post cold build or incremental update completion).

### Linting & Formatting

- Run ESLint (check): `npm run lint`
- Auto-fix ESLint issues: `npm run lint:fix`
- Format with Prettier: `npm run format`
- Check formatting: `npm run format:check`

## Test with MCP Inspector (without VS)

Use the MCP Inspector to exercise the server locally and try the tools without Visual Studio.

Windows PowerShell:

```
npm run build
$env:REPO_ROOT="C:\path\to\your-repo"; npx @modelcontextprotocol/inspector node .\\dist\\index.js
```

Streamable HTTP via Inspector (Windows):

```
npm run build
$env:REPO_ROOT="C:\path\to\your-repo"; $env:MCP_TRANSPORT="http"; npx @modelcontextprotocol/inspector http://localhost:3000/mcp --transport http
```

macOS/Linux (bash/zsh):

```
export REPO_ROOT="/path/to/your-repo"
npx @modelcontextprotocol/inspector node dist/index.js
```

Streamable HTTP (macOS/Linux):

```
export REPO_ROOT="/path/to/your-repo"; MCP_TRANSPORT=http npx @modelcontextprotocol/inspector http://localhost:3000/mcp --transport http
```

Notes:

- First run downloads the embedding model and builds embeddings; the Inspector will connect only after startup completes. Watch the terminal for progress logs printed to stderr.
- You can also put settings in a `.env` file at the project root (e.g., `REPO_ROOT`, `TRANSFORMERS_CACHE`).

In the Inspector UI:

- Click "List tools" to verify these tools are available: `rag_query`, `read_file`.
- Select a tool and click "Call tool". Provide JSON input as shown below.

Examples

1. Semantic search over the repo

```
Tool: rag_query
Input JSON:
{
	"query": "protobuf message X schema",
	"top_k": 5
}
```

The response includes an array of matches with `path`, `score`, and `snippet`.

2. Read a file (optionally with a line range)

```
Tool: read_file
Input JSON:
{
	"path": "src/path/to/file.txt",  // relative to REPO_ROOT
	"startLine": 1,
	"endLine": 120
}
```

Troubleshooting

- Slow startup: set `TRANSFORMERS_CACHE` to a fast local folder and (optionally) set `ALLOWED_EXT` (e.g., `ts,tsx,js` for TypeScript/JS only, or any list you need).
- Path errors: `path` must be relative to `REPO_ROOT`. Absolute paths are rejected for safety.
- Nothing appears in Inspector for minutes: the server is still initializing (model download + embedding). This is expected on first run.
  .- Slow warm restarts: provide `INDEX_STORE_PATH` so embeddings persist and only changed files re‑embed.

## Environment configuration (.env)

You can configure environment variables via a local `.env` file.

Steps:

- Copy `.env.example` to `.env`.
- Edit values as needed.

Supported variables:

- `REPO_ROOT` (required): path to the repository to index.
- `TRANSFORMERS_CACHE` (optional): cache folder for model files.
- `ALLOWED_EXT` (optional): comma-separated list of file extensions to index.
- `MCP_TRANSPORT` (optional): `http` or `stdio`.
- `VERBOSE` (optional): true/1/yes/on for more granular progress logs during indexing & embedding.
- `INDEX_STORE_PATH` (optional): path to a persisted JSON embedding index (e.g., `C:\repo\.mcp-index.json` or `/repo/.mcp-index.json`). Enables fast warm starts + incremental reindex (new / deleted / size‑changed files only).
- `MODEL_NAME` (optional): override the default embedding model (`jinaai/jina-embeddings-v2-base-code`). Examples:
  - `MODEL_NAME=jinaai/jina-embeddings-v2-base-code` (default) — Balanced multilingual/code embedding model; strong for mixed natural language + source code semantic search.
  - `MODEL_NAME=Xenova/bge-base-en-v1.5` — High-quality English general-purpose text embeddings (good for documentation/wiki style corpora).
  - `MODEL_NAME=Xenova/bge-small-en-v1.5` — Faster/lighter English model when latency or memory matters more than a few points of recall.
    Any compatible sentence / feature-extraction model supported by `@xenova/transformers` should work.
- `HOST` (optional, HTTP mode): bind host (default `127.0.0.1`).
- `MCP_PORT` (optional, HTTP mode): TCP port (default `3000`).
- `ENABLE_DNS_REBINDING_PROTECTION` (optional, HTTP mode): defaults to `true`; set to `false` to disable host allow‑list checks.
- `ALLOWED_HOSTS` (optional, HTTP mode): comma-separated list of hosts allowed when DNS rebinding protection is enabled. Defaults include localhost and 127.0.0.1 with/without port.
- `CHUNK_SIZE` (optional): maximum characters per chunk before embedding (default 800). Larger values reduce total embeddings (faster build, less memory) but can blur fine-grained matches. Typical ranges:
  - 700‑900 (balanced default)
  - 1000‑1400 (large prose / long functions; fewer vectors)
  - 400‑600 (fine‑grained code navigation; more vectors / memory)
- `CHUNK_OVERLAP` (optional): trailing characters carried into the next chunk (default 120 ≈ 15%). Recommended 10‑20% of `CHUNK_SIZE` (e.g., 80‑160 for an 800 size). Increase slightly (up to ~20‑25%) if you observe answers missing cross‑boundary context; decrease to speed up builds.

Safety caps: `CHUNK_SIZE` is clamped to 8000 and `CHUNK_OVERLAP` to 4000; if overlap >= size it's automatically reduced (logged) to preserve forward progress.

## Persistence & Incremental Reindexing

Set `INDEX_STORE_PATH` to enable a persisted JSON index storing chunks + embeddings. On startup:

1. If the file exists and its metadata (model name, chunk size, overlap) matches, it is loaded into memory.
2. The repository is rescanned; removed files' chunks are discarded, and new or size‑changed files are re‑chunked & re‑embedded.
3. The merged index is saved back (cold build path also persists when configured).

Benefits:

- Dramatically faster warm starts for large repositories.
- Avoids re‑embedding unchanged content.

Current limitations:

- Change detection uses file size only (content edits keeping identical size won't re‑embed yet).
- Embedding generation is sequential (no parallel batching yet).
- Store schema is minimal (version 1); future versions may add hashing or mtime heuristics.

Force a full rebuild by deleting the store file or changing chunk/model parameters.

## Visual Studio integration (MCP)

Copy `example.mcp.json` to:

- %USERPROFILE%\.mcp.json (Windows), or
- your solution root as `.mcp.json` (recommended for teams)

Adjust the paths in "command"/"args" and the `REPO_ROOT` env.

For Streamable HTTP, use a config entry like:

```
{
	"servers": {
		"mcp-rag-server": {
			"type": "streamable-http",
			"url": "http://127.0.0.1:3000/mcp"
		}
	}
}
```

Open VS -> Copilot Chat -> switch to Agent mode -> enable the "mcp-rag-server" and its tools (you will be asked to grant permission on first use). If using HTTP transport, ensure the config entry uses `"type": "streamable-http"` and the server has finished indexing (check `/health`).

## Usage in Agent mode

Sample prompt:
"Modify the C# handler for message X. Before you start, use the tool `rag_query` with the query 'message X schema' and take the found contracts into account. If you get file paths back, read them via `read_file`."

## Notes

- First run will download and cache the model (tens to ~100 MB) and build embeddings — this may take minutes depending on repo size.
- Logs are written to stderr (console.error) to keep MCP stdout clean.
- For very large repos, consider adding an ANN index (`hnswlib-node`) or a hybrid BM25+embeddings setup.

### Model selection guidance

Choose an embedding model based on your repository characteristics:

- `jinaai/jina-embeddings-v2-base-code` (default): Use when your corpus contains a meaningful amount of source code (multi-language) mixed with README / design docs. Provides strong cross-domain alignment for code-symbol + natural language queries.
- `Xenova/bge-base-en-v1.5`: Use when the content is predominantly English natural language (docs, knowledge base) and you want slightly stronger pure text semantic quality.
- `Xenova/bge-small-en-v1.5`: Use for faster startup / lower memory on constrained machines or when indexing very large repos where throughput matters.

Feel free to experiment—swap via `MODEL_NAME` and rebuild the embedding cache (delete any existing cached vectors if you persist them externally).

### Chunk sizing guidance

Why 800 / 120? Empirically this keeps most self‑contained code constructs (functions/classes) and short doc sections in a single chunk while providing enough continuity for cross‑block semantic matches. Adjust based on corpus:

- Mostly short functions or config files: smaller chunks (500‑700) aid pinpoint retrieval.
- Large narrative docs / design specs: larger chunks (1000‑1400) reduce vector count without much recall loss.
- Heavily interdependent code where context spans multiple files: keep default or modestly raise overlap (to ~160) rather than shrinking size.

Rule of thumb: Overlap ≈ 15% of size. Avoid overlap >= size (auto‑corrected) and avoid extremely small sizes (<300) unless you have a downstream re‑ranking stage.
