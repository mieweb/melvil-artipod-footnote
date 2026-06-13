# FOOTNOTE Format Specification

A **footnote index** is a portable, self-contained documentation index artifact. It packages a SQLite hybrid search database (sqlite-vec + FTS5) with metadata for server-side or browser-based RAG consumption.

## Directory Structure

```
.footnote/
├── index.sqlite       # SQLite database with vectors + FTS
├── manifest.json      # Build metadata and configuration
└── content/           # (optional) Raw markdown files for grep search
    ├── functions/
    │   ├── scheduling.md
    │   └── ...
    └── ...
```

## manifest.json

The manifest describes the footnote index contents, build configuration, and agent settings.

### Schema

```json
{
  "schema_version": "1.0",
  "project_name": "docs",
  "build_time_utc": "2026-01-31T17:30:43.123Z",
  "source_git_commit": "abc123def456...",
  "chunking": {
    "max_tokens": 500,
    "overlap": 80,
    "strategy": "markdown-aware"
  },
  "embedding": {
    "model_id": "nomic-embed-text:latest",
    "dimension": 768,
    "provider": "ollama"
  },
  "fts_fields": ["title", "content"],
  "doc_count": 997,
  "chunk_count": 9786,
  "filters": {
    "brand": "eh"
  },
  "content_copy": {
    "enabled": true,
    "path": "content"
  },
  "agent": {
    "model": "llama3.2:latest",
    "max_iterations": 5,
    "system_prompt": "You are a documentation assistant..."
  }
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema_version` | string | ✓ | Footnote format schema version (currently `"1.0"`) |
| `project_name` | string | | Human-readable project name |
| `build_time_utc` | string | ✓ | ISO 8601 timestamp of build |
| `source_git_commit` | string | | Git commit hash at build time (null if not in repo) |
| `chunking` | object | ✓ | Chunking configuration |
| `chunking.max_tokens` | number | ✓ | Maximum tokens per chunk |
| `chunking.overlap` | number | ✓ | Token overlap between consecutive chunks |
| `chunking.strategy` | string | ✓ | Chunking strategy (e.g., `"markdown-aware"`) |
| `embedding` | object | ✓ | Embedding model configuration |
| `embedding.model_id` | string | ✓ | Model identifier (e.g., `"nomic-embed-text:latest"`) |
| `embedding.dimension` | number | ✓ | Vector dimension (must match `vec_chunks` table) |
| `embedding.provider` | string | ✓ | Provider name (`"ollama"`, `"openai"`, `"mock"`) |
| `fts_fields` | string[] | ✓ | Fields indexed for full-text search |
| `doc_count` | number | ✓ | Number of documents in index |
| `chunk_count` | number | ✓ | Number of chunks in index |
| `filters` | object | | Content filters applied during build |
| `content_copy` | object | | Content file copy configuration |
| `content_copy.enabled` | boolean | | Whether raw files were copied |
| `content_copy.path` | string | | Relative path within index directory |
| `agent` | object | | Agent configuration |
| `agent.model` | string | | LLM model for agent queries |
| `agent.max_iterations` | number | | Maximum tool call iterations |
| `agent.system_prompt` | string | | Custom system prompt (supports `{{TOOLS}}` placeholder) |

## index.sqlite

SQLite database using [sqlite-vec](https://github.com/asg017/sqlite-vec) for vector search and FTS5 for full-text search.

### Tables

#### `chunks` - Main chunk storage

Primary table storing chunk metadata and content.

```sql
CREATE TABLE chunks (
  chunk_id   TEXT PRIMARY KEY,  -- Unique chunk identifier
  doc_id     TEXT NOT NULL,     -- Document identifier (relative path)
  path       TEXT NOT NULL,     -- File path relative to content root
  url        TEXT NOT NULL,     -- URL path for the document
  title      TEXT,              -- Document title from frontmatter
  section    TEXT,              -- Section within document
  tags       TEXT,              -- JSON array of tags
  headings   TEXT,              -- JSON array of heading hierarchy
  content    TEXT NOT NULL,     -- Chunk text content
  content_hash TEXT NOT NULL    -- SHA256 hash for change detection
);

CREATE INDEX idx_chunks_doc_id ON chunks(doc_id);
CREATE INDEX idx_chunks_path ON chunks(path);
CREATE INDEX idx_chunks_url ON chunks(url);
```

| Column | Type | Description |
|--------|------|-------------|
| `chunk_id` | TEXT | Unique ID: `{doc_id}:{chunk_index}` |
| `doc_id` | TEXT | Document ID (typically relative path without extension) |
| `path` | TEXT | File path relative to content root |
| `url` | TEXT | URL path (e.g., `/functions/scheduling/`) |
| `title` | TEXT | Document title from frontmatter or first heading |
| `section` | TEXT | Section name if chunk is within a specific section |
| `tags` | TEXT | JSON array of document tags |
| `headings` | TEXT | JSON array of heading hierarchy leading to chunk |
| `content` | TEXT | The actual chunk text |
| `content_hash` | TEXT | SHA256 hash of content for incremental updates |

#### `vec_chunks` - Vector embeddings

Virtual table using sqlite-vec for KNN vector search.

```sql
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[768]  -- Dimension matches manifest.embedding.dimension
);
```

| Column | Type | Description |
|--------|------|-------------|
| `chunk_id` | TEXT | Foreign key to `chunks.chunk_id` |
| `embedding` | FLOAT[N] | Vector embedding (N = dimension from manifest) |

**Note:** Vector dimension is determined at index creation and stored in both the manifest and the `metadata` table. All embeddings must match this dimension.

#### `chunks_fts` - Full-text search

FTS5 virtual table for BM25-ranked keyword search.

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id,
  title,
  content,
  content='chunks',
  content_rowid='rowid'
);
```

Supports standard FTS5 query syntax:
- `word1 word2` - Match both words (implicit AND)
- `word1 OR word2` - Match either word
- `"exact phrase"` - Match exact phrase
- `word*` - Prefix match
- `NEAR(word1 word2, 5)` - Words within 5 tokens

#### `file_tracking` - Incremental build support

Tracks file modification times for incremental builds.

```sql
CREATE TABLE file_tracking (
  path       TEXT PRIMARY KEY,  -- File path relative to content root
  mtime_ms   INTEGER NOT NULL,  -- File modification time (milliseconds)
  chunk_ids  TEXT NOT NULL      -- JSON array of chunk IDs from this file
);
```

| Column | Type | Description |
|--------|------|-------------|
| `path` | TEXT | File path relative to content root |
| `mtime_ms` | INTEGER | Last modified time in milliseconds since epoch |
| `chunk_ids` | TEXT | JSON array of chunk IDs generated from this file |

#### `metadata` - Key-value store

General metadata storage.

```sql
CREATE TABLE metadata (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

Current keys:
- `dimension` - Vector dimension (redundant with manifest, for validation)

### Query Examples

#### Hybrid Search (Vector + FTS)

```sql
-- Step 1: Vector search (requires sqlite-vec)
SELECT chunk_id, distance
FROM vec_chunks
WHERE embedding MATCH ?
ORDER BY distance
LIMIT 20;

-- Step 2: FTS search
SELECT chunk_id, bm25(chunks_fts) as score
FROM chunks_fts
WHERE chunks_fts MATCH ?
ORDER BY score
LIMIT 20;

-- Step 3: Combine results in application code using RRF
```

#### Full-Text Search Only

```sql
SELECT c.*, bm25(chunks_fts) as score
FROM chunks_fts f
JOIN chunks c ON c.chunk_id = f.chunk_id
WHERE chunks_fts MATCH 'patient scheduling'
ORDER BY score
LIMIT 10;
```

#### Literal Substring Search

```sql
SELECT *
FROM chunks
WHERE LOWER(content) LIKE LOWER('%ADT^A04%')
LIMIT 10;
```

#### Get All Chunks for a Document

```sql
SELECT *
FROM chunks
WHERE doc_id = 'functions/scheduling'
   OR url LIKE '%/scheduling/%'
ORDER BY chunk_id;
```

## content/ Directory

Optional directory containing raw markdown files, copied from the source content directory during build when `--copy-content` is specified.

### Purpose

- **Grep search**: Enables Unix grep-based search as an alternative to SQLite
- **Source reference**: Provides access to original markdown for debugging
- **Portability**: Makes the footnote index fully self-contained

### Structure

Mirrors the source content directory structure:

```
content/
├── _index.md
├── functions/
│   ├── _index.md
│   ├── scheduling.md
│   ├── patient-registration.md
│   └── ...
├── resources/
│   └── ...
└── ...
```

**Note:** Asset directories (`.assets/`) and hidden files are excluded.

### Size Considerations

| Documents | Approximate Size |
|-----------|------------------|
| 100 | ~300KB |
| 1,000 | ~3MB |
| 10,000 | ~30MB |

Enable only when grep search is needed for comparison or fallback.

## Versioning

### Schema Version History

| Version | Changes |
|---------|---------|
| `1.0` | Initial release: chunks, vec_chunks, chunks_fts, file_tracking, metadata |

### Compatibility

- **Forward compatible**: Newer readers should handle older footnote indexes
- **Backward compatible**: New optional fields don't break older readers
- **Breaking changes**: Increment major version (e.g., `2.0`)

## Usage

### Building a Footnote Index

```bash
# Basic build
./footnote.sh build

# With content copy for grep support
./footnote.sh build --copy-content

# With filters
./footnote.sh build --filter brand=eh
```

### Consuming a Footnote Index

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Load database
const db = new Database('.footnote/index.sqlite');
sqliteVec.load(db);

// Read manifest
const manifest = JSON.parse(fs.readFileSync('.footnote/manifest.json', 'utf-8'));

// Vector search (requires embedding the query first)
const results = db.prepare(`
  SELECT chunk_id, distance
  FROM vec_chunks
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT 10
`).all(queryVector);

// FTS search
const ftsResults = db.prepare(`
  SELECT c.*, bm25(chunks_fts) as score
  FROM chunks_fts f
  JOIN chunks c ON c.chunk_id = f.chunk_id
  WHERE chunks_fts MATCH ?
  ORDER BY score
  LIMIT 10
`).all(query);
```

### Browser Usage

See [sqlite-vec WASM documentation](https://alexgarcia.xyz/sqlite-vec/wasm.html) for loading footnote indexes in the browser.

## Design Principles

1. **Self-contained**: All data needed for search is in the footnote index
2. **Portable**: Standard SQLite format works everywhere
3. **Efficient**: sqlite-vec and FTS5 provide fast hybrid search
4. **Incremental**: File tracking enables fast rebuilds
5. **Configurable**: Manifest stores all build parameters for reproducibility
