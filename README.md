# docidx

Hugo content index compiler that produces portable SQLite hybrid index artipods (sqlite-vec + FTS5) for server-side RAG consumption.

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
- `--out <path>` - Output artipod directory (default: ./artipod relative to Hugo root)
- `--clean` - Remove existing index and rebuild from scratch
- `--incremental` - Only process changed files
- `--include-drafts` - Include draft documents
- `--filter <name=value>` - Content filter (e.g., `--filter brand=eh`)
- `--embedding-model <model>` - Embedding model (auto-detected, see below)
- `--embedding-dim <n>` - Embedding dimensions (auto-detected based on model)
- `--pull` - Automatically pull Ollama model if not installed
- `--max-tokens <n>` - Max tokens per chunk (default: 500)
- `--overlap <n>` - Token overlap between chunks (default: 80)
- `--copy-content` - Copy markdown files to artipod for grep-based search

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

### Interactive Search Testing

Test different search modes interactively:

```bash
./docidx.sh test --mode fts "FHIR API"
./docidx.sh test --mode hybrid "how do I schedule"
./docidx.sh test --mode literal "ADT^A04"
./docidx.sh test --mode grep "copyright"   # requires --copy-content
```

### AI Agent Search

Ask questions with an agentic RAG assistant:

```bash
./docidx.sh ask "How do I schedule an appointment?"
./docidx.sh ask -v "What is FHIR?"          # verbose: show tool calls
./docidx.sh ask -c "terms of use"           # show full chunk content
```

The agent has access to these tools:
- `search_hybrid` - Vector + keyword search (best for natural language)
- `search_fts` - Full-text BM25 search (best for technical terms)
- `search_literal` - Exact substring match (finds special chars like `^`, `|`)
- `search_grep` - Unix grep on raw files (if `--copy-content` enabled)
- `read_document` - Read full document content
- `find_related` - Find documents that link to a given document

## Search Performance Comparison

Benchmarked on ~1000 markdown documents (~10K chunks) on macOS:

| Search Mode | Time | Description |
|-------------|------|-------------|
| **FTS** | ~6ms | SQLite FTS5 with BM25 ranking |
| **Hybrid** | ~50ms | Vector + FTS combined (includes embedding) |
| **Literal** | ~120ms | Exact substring match via SQL LIKE |
| **Grep** | ~220ms | Unix grep on raw files |

### Example: Search for "copyright"

**FTS (SQLite) - 6ms:**
```
1. [7.71] Terms of Use > General Prohibitions
   /resources/.../terms-of-use/
   "...infringe any copyright, trademark rights..."

2. [6.86] Terms of API Use > User Content
   /resources/.../terms-of-api-use/
   "...may constitute copyright or HIPAA infringement..."
```

**Grep - 219ms:**
```
1. [5 matches] terms-of-api-use
   L43: Remember, it's not your content...
   L145: ...infringe any copyright, trademark...
   
2. [5 matches] terms-of-use
   L43: Remember, it's not your content...
```

### Key Differences

| Feature | SQLite FTS/Hybrid | Grep |
|---------|-------------------|------|
| Speed | ~36x faster | Slower (reads all files) |
| Ranking | BM25 relevance scores | Match count only |
| Results | Chunk-level with context | Line-level |
| Special chars | Tokenized (use `literal` mode) | Native support |
| Setup | Requires index build | No setup needed |

### Enabling Grep Search

To enable grep-based search (for comparison or fallback):

```bash
./docidx.sh build --copy-content
```

This copies markdown files to `artipod/content/` (~3MB for 1000 docs).

## Environment Variables

- `OPENAI_API_KEY` - Required only if using OpenAI embeddings (not needed for Ollama)
- `LOG_LEVEL` - Logging verbosity (debug, info, warn, error)

## Artipod Structure

```
artipod/
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
- `schema_version` - Artipod schema version
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
npm run docidx -- build --root ../.. --content content --out ./artipod --clean --embedding-model mock

# Build TypeScript
npm run build

# Run tests
npm test
```
