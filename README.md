# docidx

Hugo content index compiler that produces portable SQLite hybrid index artifacts (sqlite-vec + FTS5) for server-side RAG consumption.

See https://alexgarcia.xyz/sqlite-vec/wasm.html for in browser example

## Installation

```bash
cd tools/docidx
npm install
```

## Usage

### Build Index

Smart build (auto-detects everything):
```bash
npm run docidx -- build
```

Force clean rebuild:
```bash
npm run docidx -- build --clean
```

Use specific Ollama model:
```bash
npm run docidx -- build --embedding-model ollama:nomic-embed-text
```

Use OpenAI (requires OPENAI_API_KEY):
```bash
npm run docidx -- build --embedding-model text-embedding-3-small
```

### Options

- `--root <path>` - Hugo project root (auto-detected by finding content/ directory)
- `--content <path>` - Content directory relative to root (default: content)
- `--out <path>` - Output artifact directory (default: ./artifact relative to Hugo root)
- `--clean` - Remove existing index and rebuild from scratch
- `--incremental` - Only process changed files
- `--include-drafts` - Include draft documents
- `--brand <eh|wc|both>` - Filter content by brand (default: both)
- `--embedding-model <model>` - Embedding model (auto-detected, see below)
- `--embedding-dim <n>` - Embedding dimensions (auto-detected based on model)
- `--pull` - Automatically pull Ollama model if not installed
- `--max-tokens <n>` - Max tokens per chunk (default: 500)
- `--overlap <n>` - Token overlap between chunks (default: 80)

**Auto-detection behavior:**
- **Hugo root**: Walks up from current directory looking for `content/`
- **Build mode**: Incremental if index exists, clean if not
- **Embedder**: Checks in order:
  1. **Ollama** (if running locally with embedding model like `nomic-embed-text`)
  2. **OpenAI** (if `OPENAI_API_KEY` is set)
  3. Error with helpful instructions

Supported Ollama embedding models:
- `nomic-embed-text` (768 dim) - recommended, fast
- `bge-m3` (1024 dim) - multilingual, high quality
- `mxbai-embed-large` (1024 dim)
- `bge-large` (1024 dim)
- `snowflake-arctic-embed` (1024 dim)
- `all-minilm` (384 dim) - smallest/fastest

**Installing Ollama models:**

Option 1 - Manually pull first:
```bash
ollama pull nomic-embed-text
```

Option 2 - Auto-pull with `--pull` flag:
```bash
./docidx.sh build --embedding-model ollama:bge-m3 --pull
```

### Test Query

```bash
npm run docidx -- query --hybrid "patient registration" --k 5
```

## Environment Variables

- `OPENAI_API_KEY` - Required only if using OpenAI embeddings (not needed for Ollama)
- `LOG_LEVEL` - Logging verbosity (debug, info, warn, error)

## Artifact Structure

```
artifact/
├── index.sqlite       # Unified SQLite database (vectors + FTS)
└── manifest.json      # Build metadata and configuration
```

### index.sqlite Schema

| Table | Purpose |
|-------|---------|
| `chunks` | Main chunk metadata (doc_id, path, url, title, section, tags, headings, content, content_hash) |
| `vec_chunks` | sqlite-vec virtual table for vector KNN search |
| `chunks_fts` | FTS5 virtual table for BM25 full-text search |
| `file_tracking` | Track processed files for incremental builds |
| `metadata` | Key-value store (currently stores `dimension`) |

### manifest.json

Contains:
- `schema_version` - Artifact schema version
- `build_time_utc` - Build timestamp
- `source_git_commit` - Git commit hash (if available)
- `chunking` - Chunking parameters (max_tokens, overlap)
- `embedding` - Embedding model configuration
- `fts_fields` - Fields indexed for full-text search
- `doc_count` - Number of documents indexed
- `chunk_count` - Number of chunks indexed

## Development

```bash
# Run with tsx for development
npm run docidx -- build --root ../.. --content content --out ./artifact --clean --embedding-model mock

# Build TypeScript
npm run build

# Run tests
npm test
```
