# mcp-rag-server (Node.js, local RAG for any repo)

A local MCP server for GitHub Copilot Agent mode in Visual Studio 2022. It performs semantic search over a repository (local embeddings via `@xenova/transformers`) and returns relevant snippets as context (RAG). Works for many languages or plain text files.

## Requirements

- Node.js 18+
- Visual Studio 2022 17.14+ with GitHub Copilot (Agent mode enabled)
- Path to your repository (`REPO_ROOT`)

## Install

npm install
npm run build

## Run (local test)

# Windows PowerShell

$env:REPO_ROOT="C:\path\to\your-repo"; node build/index.js

# macOS/Linux (bash/zsh)

export REPO_ROOT="/path/to/your-repo"; node build/index.js

Optionally set a model cache to speed up subsequent runs:
export TRANSFORMERS_CACHE="/path/to/cache"

### Streamable HTTP mode

Run the MCP server as an HTTP endpoint (Streamable HTTP transport):

```
npm run build
$env:REPO_ROOT="C:\path\to\your-repo"; $env:ENABLE_HTTP_MCP_TRANSPORT="true"; npm run start
```

```
export REPO_ROOT="/path/to/your-repo"; ENABLE_HTTP_MCP_TRANSPORT=true npm run start
```

Default HTTP bind: http://127.0.0.1:3000/mcp. Override with `HOST` and `MCP_PORT` envs.

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
$env:REPO_ROOT="C:\path\to\your-repo"; npx @modelcontextprotocol/inspector node .\\build\\index.js
```

Streamable HTTP via Inspector (Windows):

```
npm run build
$env:REPO_ROOT="C:\path\to\your-repo"; $env:ENABLE_HTTP_MCP_TRANSPORT="true"; npx @modelcontextprotocol/inspector http://localhost:3000/mcp --transport http
```

macOS/Linux (bash/zsh):

```
export REPO_ROOT="/path/to/your-repo"
npx @modelcontextprotocol/inspector node build/index.js
```

Streamable HTTP (macOS/Linux):

```
export REPO_ROOT="/path/to/your-repo"; ENABLE_HTTP_MCP_TRANSPORT=true npx @modelcontextprotocol/inspector http://localhost:3000/mcp --transport http
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

## Environment configuration (.env)

You can configure environment variables via a local `.env` file.

Steps:

- Copy `.env.example` to `.env`.
- Edit values as needed.

Supported variables:

- `REPO_ROOT` (required): path to the repository to index.
- `TRANSFORMERS_CACHE` (optional): cache folder for model files.
- `ALLOWED_EXT` (optional): comma-separated list of file extensions to index.
- `ENABLE_HTTP_MCP_TRANSPORT` (optional): set to true/1/yes/on to run via Streamable HTTP.
- `MODEL_NAME` (optional): override the default embedding model (`jinaai/jina-embeddings-v2-base-code`). Examples:
  - `MODEL_NAME=jinaai/jina-embeddings-v2-base-code` (default) — Balanced multilingual/code embedding model; strong for mixed natural language + source code semantic search.
  - `MODEL_NAME=Xenova/bge-base-en-v1.5` — High-quality English general-purpose text embeddings (good for documentation/wiki style corpora).
  - `MODEL_NAME=Xenova/bge-small-en-v1.5` — Faster/lighter English model when latency or memory matters more than a few points of recall.
    Any compatible sentence / feature-extraction model supported by `@xenova/transformers` should work.
- `HOST` (optional, HTTP mode): bind host (default `127.0.0.1`).
- `MCP_PORT` (optional, HTTP mode): TCP port (default `3000`).
- `ENABLE_DNS_REBINDING_PROTECTION` (optional, HTTP mode): defaults to `true`; set to `false` to disable host allow‑list checks.
- `ALLOWED_HOSTS` (optional, HTTP mode): comma-separated list of hosts allowed when DNS rebinding protection is enabled. Defaults include localhost and 127.0.0.1 with/without port.

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

Open VS -> Copilot Chat -> switch to Agent mode -> enable the "mcp-rag-server" and its tools (you will be asked to grant permission on first use).

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
