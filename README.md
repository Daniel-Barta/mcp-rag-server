# mcp-kotlin-rag (Node.js, local RAG for a Kotlin repo)

A local MCP server for GitHub Copilot Agent mode in Visual Studio 2022. It performs semantic search over a Kotlin repository (local embeddings via `@xenova/transformers`) and returns relevant snippets as context (RAG).

## Requirements
- Node.js 18+
- Visual Studio 2022 17.14+ with GitHub Copilot (Agent mode enabled)
- Path to your Kotlin repository (`KOTLIN_ROOT`)

## Install
npm install
npm run build

## Run (local test)
# Windows PowerShell
$env:KOTLIN_ROOT="C:\path\to\kotlin-repo"; node build/index.js

# macOS/Linux (bash/zsh)
export KOTLIN_ROOT="/path/to/kotlin-repo"; node build/index.js

Optionally set a model cache to speed up subsequent runs:
export TRANSFORMERS_CACHE="/path/to/cache"

## Test with MCP Inspector (without VS)
Use the MCP Inspector to exercise the server locally and try the tools without Visual Studio.

Windows PowerShell:

```
npm run build
$env:KOTLIN_ROOT="C:\path\to\kotlin-repo"; npx @modelcontextprotocol/inspector node .\build\index.js
```

macOS/Linux (bash/zsh):

```
export KOTLIN_ROOT="/path/to/kotlin-repo"
npx @modelcontextprotocol/inspector node build/index.js
```

Notes:
- First run downloads the embedding model and builds embeddings; the Inspector will connect only after startup completes. Watch the terminal for progress logs printed to stderr.
- You can also put settings in a `.env` file at the project root (e.g., `KOTLIN_ROOT`, `TRANSFORMERS_CACHE`).

In the Inspector UI:
- Click "List tools" to verify these tools are available: `rag_query_kotlin`, `read_file`.
- Select a tool and click "Call tool". Provide JSON input as shown below.

Examples

1) Semantic search over the repo

```
Tool: rag_query_kotlin
Input JSON:
{
	"query": "protobuf message X schema",
	"top_k": 5
}
```

The response includes an array of matches with `path`, `score`, and `snippet`.

2) Read a file (optionally with a line range)

```
Tool: read_file
Input JSON:
{
	"path": "app/src/main/java/com/acme/feature/Foo.kt",  // relative to KOTLIN_ROOT
	"startLine": 1,
	"endLine": 120
}
```

Troubleshooting
- Slow startup: set `TRANSFORMERS_CACHE` to a fast local folder and (optionally) limit `ALLOWED_EXT` to just `kt,kts` to index Kotlin files only.
- Path errors: `path` must be relative to `KOTLIN_ROOT`. Absolute paths are rejected for safety.
- Nothing appears in Inspector for minutes: the server is still initializing (model download + embedding). This is expected on first run.

## Environment configuration (.env)
You can configure environment variables via a local `.env` file.

Steps:
- Copy `.env.example` to `.env`.
- Edit values as needed.

Supported variables:
- `KOTLIN_ROOT` (required): path to the Kotlin repository to index.
- `TRANSFORMERS_CACHE` (optional): cache folder for model files.
- `ALLOWED_EXT` (optional): comma-separated list of file extensions to index.

## Visual Studio integration (MCP)
Copy `example.mcp.json` to:
- %USERPROFILE%\.mcp.json (Windows), or
- your solution root as `.mcp.json` (recommended for teams)

Adjust the paths in "command"/"args" and the `KOTLIN_ROOT` env.

Open VS -> Copilot Chat -> switch to Agent mode -> enable the "kotlin-rag" server and its tools (you will be asked to grant permission on first use).

## Usage in Agent mode
Sample prompt:
"Modify the C# handler for message X. Before you start, use the tool `rag_query_kotlin` with the query 'message X schema' and take the found contracts into account. If you get file paths back, read them via `read_file`."

## Notes
- First run will download and cache the model (tens to ~100 MB) and build embeddings — this may take minutes depending on repo size.
- Logs are written to stderr (console.error) to keep MCP stdout clean.
- For very large repos, consider adding an ANN index (`hnswlib-node`) or a hybrid BM25+embeddings setup.
