/**
 * Unified SQLite Storage Layer
 * 
 * Combines vector search (sqlite-vec), full-text search (FTS5),
 * and file tracking in a single SQLite database.
 * 
 * Schema:
 * - chunks: Main chunk metadata storage
 * - vec_chunks: Virtual table for vector similarity search (sqlite-vec)
 * - chunks_fts: Virtual table for BM25 full-text search (FTS5)
 * - file_tracking: Track processed files for incremental builds
 * - metadata: Key-value store for configuration
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'fs';
import * as path from 'path';

export interface ChunkRecord {
  chunk_id: string;
  doc_id: string;
  path: string;
  url: string;
  title: string;
  section: string;
  tags: string[];
  date: string;
  headings: string[];
  content: string;
  content_hash: string;
  /** Chunk-level clinical assertion status (Phase 2): present|absent|possible|historical|unspecified. */
  assertion: string;
  /** Per-finding assertions (Phase 2, bullet 2) as a JSON string. Optional: only some reads hydrate it. */
  findings?: string;
  updated_at: number;
  vector: number[];
}

export interface FileTrackingInfo {
  path: string;
  contentHash: string;
  mtime: number;
  chunkIds: string[];
}

export interface SqliteStoreConfig {
  dbPath: string;
  dimension: number;
}

export class SqliteStore {
  private db: Database.Database;
  private config: SqliteStoreConfig;
  private insertChunkStmt!: Database.Statement;
  private insertVectorStmt!: Database.Statement;
  private deleteChunkStmt!: Database.Statement;
  private deleteVectorStmt!: Database.Statement;

  constructor(config: SqliteStoreConfig) {
    this.config = config;

    const dir = path.dirname(config.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(config.dbPath);
    
    // Load sqlite-vec extension
    sqliteVec.load(this.db);
  }

  /**
   * Initialize the database schema
   */
  init(clean: boolean = false): void {
    if (clean) {
      this.db.exec(`
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS vec_chunks;
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS file_tracking;
        DROP TABLE IF EXISTS metadata;
      `);
    }

    // Create metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Store dimension in metadata
    this.db.prepare(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('dimension', ?)
    `).run(String(this.config.dimension));

    // Main chunks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        path TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        tags TEXT NOT NULL,
        date TEXT NOT NULL,
        headings TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        assertion TEXT NOT NULL DEFAULT 'unspecified',
        findings TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_assertion ON chunks(assertion);
    `);

    // Forward-migrate an existing index that predates the assertion column (Phase 2).
    // CREATE TABLE IF NOT EXISTS won't add a column to a table that already exists.
    try {
      this.db.exec(`ALTER TABLE chunks ADD COLUMN assertion TEXT NOT NULL DEFAULT 'unspecified'`);
    } catch {
      // Column already exists — nothing to do.
    }
    try {
      this.db.exec(`ALTER TABLE chunks ADD COLUMN findings TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Column already exists — nothing to do.
    }

    // Vector table using sqlite-vec (vec0)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding FLOAT[${this.config.dimension}]
      );
    `);

    // FTS5 table for BM25 search
    // Regular FTS5 table (stores its own copy of the text for indexing)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id,
        title,
        section,
        content,
        tags
      );
    `);

    // File tracking for incremental builds
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_tracking (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        chunk_ids TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_tracking_hash ON file_tracking(content_hash);
    `);

    // Prepare frequently used statements
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.insertChunkStmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
      (chunk_id, doc_id, path, url, title, section, tags, date, headings, content, content_hash, assertion, findings, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertVectorStmt = this.db.prepare(`
      INSERT OR REPLACE INTO vec_chunks (chunk_id, embedding)
      VALUES (?, ?)
    `);

    this.deleteChunkStmt = this.db.prepare(`DELETE FROM chunks WHERE chunk_id = ?`);
    this.deleteVectorStmt = this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
  }

  /**
   * Add or update chunks with their embeddings
   */
  upsertChunks(chunks: ChunkRecord[]): void {
    if (chunks.length === 0) return;

    const upsert = this.db.transaction((items: ChunkRecord[]) => {
      for (const chunk of items) {
        // Delete existing (for clean upsert)
        this.deleteChunkStmt.run(chunk.chunk_id);
        this.deleteVectorStmt.run(chunk.chunk_id);
        this.db.prepare(`DELETE FROM chunks_fts WHERE chunk_id = ?`).run(chunk.chunk_id);

        // Insert into main table
        this.insertChunkStmt.run(
          chunk.chunk_id,
          chunk.doc_id,
          chunk.path,
          chunk.url,
          chunk.title,
          chunk.section,
          JSON.stringify(chunk.tags),
          chunk.date,
          JSON.stringify(chunk.headings),
          chunk.content,
          chunk.content_hash,
          chunk.assertion,
          chunk.findings ?? '[]',
          chunk.updated_at
        );

        // Insert vector
        const vecBuffer = new Float32Array(chunk.vector);
        this.insertVectorStmt.run(chunk.chunk_id, vecBuffer);

        // Insert into FTS
        this.db.prepare(`
          INSERT INTO chunks_fts (chunk_id, title, section, content, tags)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          chunk.chunk_id,
          chunk.title,
          chunk.section,
          chunk.content,
          chunk.tags.join(' ')
        );
      }
    });

    upsert(chunks);
  }

  /**
   * Delete chunks by chunk IDs
   */
  deleteByChunkIds(chunkIds: string[]): void {
    const deleteAll = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.deleteChunkStmt.run(id);
        this.deleteVectorStmt.run(id);
        this.db.prepare(`DELETE FROM chunks_fts WHERE chunk_id = ?`).run(id);
      }
    });

    deleteAll(chunkIds);
  }

  /**
   * Vector similarity search using sqlite-vec
   */
  vectorSearch(queryVector: number[], k: number = 10): Array<ChunkRecord & { distance: number }> {
    const vecBuffer = new Float32Array(queryVector);
    
    // sqlite-vec requires `k = ?` constraint for KNN queries
    const results = this.db.prepare(`
      SELECT 
        v.chunk_id,
        v.distance,
        c.doc_id,
        c.path,
        c.url,
        c.title,
        c.section,
        c.tags,
        c.date,
        c.headings,
        c.content,
        c.content_hash,
        c.assertion,
        c.updated_at
      FROM vec_chunks v
      JOIN chunks c ON v.chunk_id = c.chunk_id
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(vecBuffer, k) as Array<{
      chunk_id: string;
      distance: number;
      doc_id: string;
      path: string;
      url: string;
      title: string;
      section: string;
      tags: string;
      date: string;
      headings: string;
      content: string;
      content_hash: string;
      assertion: string;
      updated_at: number;
    }>;

    return results.map(row => ({
      chunk_id: row.chunk_id,
      doc_id: row.doc_id,
      path: row.path,
      url: row.url,
      title: row.title,
      section: row.section,
      tags: JSON.parse(row.tags),
      date: row.date,
      headings: JSON.parse(row.headings),
      content: row.content,
      content_hash: row.content_hash,
      assertion: row.assertion,
      updated_at: row.updated_at,
      vector: [], // Don't return vectors in search results
      distance: row.distance
    }));
  }

  /**
   * Full-text search using FTS5 with BM25 ranking
   */
  ftsSearch(query: string, k: number = 10): Array<ChunkRecord & { bm25Score: number }> {
    // Escape special FTS5 characters - replace with spaces to keep as separate terms
    // FTS5 operators: " ' * ( ) ^ : - NOT AND OR NEAR
    const escapedQuery = query.replace(/['"*()^:\-]/g, ' ').replace(/\s+/g, ' ').trim();
    
    if (!escapedQuery) {
      return [];
    }

    try {
      const results = this.db.prepare(`
        SELECT 
          f.chunk_id,
          bm25(chunks_fts) as bm25_score,
          c.doc_id,
          c.path,
          c.url,
          c.title,
          c.section,
          c.tags,
          c.date,
          c.headings,
          c.content,
          c.content_hash,
          c.assertion,
          c.updated_at
        FROM chunks_fts f
        JOIN chunks c ON f.chunk_id = c.chunk_id
        WHERE chunks_fts MATCH ?
        ORDER BY bm25_score
        LIMIT ?
      `).all(escapedQuery, k) as Array<{
        chunk_id: string;
        bm25_score: number;
        doc_id: string;
        path: string;
        url: string;
        title: string;
        section: string;
        tags: string;
        date: string;
        headings: string;
        content: string;
        content_hash: string;
        assertion: string;
        updated_at: number;
      }>;

      return results.map(row => ({
        chunk_id: row.chunk_id,
        doc_id: row.doc_id,
        path: row.path,
        url: row.url,
        title: row.title,
        section: row.section,
        tags: JSON.parse(row.tags),
        date: row.date,
        headings: JSON.parse(row.headings),
        content: row.content,
        content_hash: row.content_hash,
        assertion: row.assertion,
        updated_at: row.updated_at,
        vector: [],
        bm25Score: row.bm25_score
      }));
    } catch {
      // Invalid query syntax
      return [];
    }
  }

  /**
   * Literal substring search using SQL LIKE (slower but finds exact characters)
   * Use this when you need to find special characters like ^, |, etc.
   */
  literalSearch(query: string, k: number = 10): Array<ChunkRecord & { matchCount: number }> {
    if (!query.trim()) {
      return [];
    }

    // Escape SQL LIKE wildcards
    const escapedQuery = query.replace(/[%_]/g, '\\$&');

    const results = this.db.prepare(`
      SELECT 
        chunk_id,
        doc_id,
        path,
        url,
        title,
        section,
        tags,
        date,
        headings,
        content,
        content_hash,
        assertion,
        updated_at,
        (LENGTH(content) - LENGTH(REPLACE(LOWER(content), LOWER(?), ''))) / LENGTH(?) as match_count
      FROM chunks
      WHERE content LIKE ? ESCAPE '\\'
      ORDER BY match_count DESC
      LIMIT ?
    `).all(query, query, `%${escapedQuery}%`, k) as Array<{
      chunk_id: string;
      doc_id: string;
      path: string;
      url: string;
      title: string;
      section: string;
      tags: string;
      date: string;
      headings: string;
      content: string;
      content_hash: string;
      assertion: string;
      updated_at: number;
      match_count: number;
    }>;

    return results.map(row => ({
      chunk_id: row.chunk_id,
      doc_id: row.doc_id,
      path: row.path,
      url: row.url,
      title: row.title,
      section: row.section,
      tags: JSON.parse(row.tags),
      date: row.date,
      headings: JSON.parse(row.headings),
      content: row.content,
      content_hash: row.content_hash,
      assertion: row.assertion,
      updated_at: row.updated_at,
      vector: [],
      matchCount: row.match_count
    }));
  }

  /**
   * Hybrid search combining vector and FTS with Reciprocal Rank Fusion (RRF)
   * 
   * Improvements over naive RRF:
   * - Filters out very short chunks from vector results (degenerate embeddings)
   * - Strongly boosts chunks appearing in both result sets
   * - Dynamically adjusts weights based on FTS result quality
   */
  hybridSearch(
    queryVector: number[],
    queryText: string,
    k: number = 10,
    rrfK: number = 60
  ): Array<ChunkRecord & { score: number; vectorRank?: number; ftsRank?: number }> {
    // Get more results for fusion
    const rawVectorResults = this.vectorSearch(queryVector, k * 3);
    const ftsResults = this.ftsSearch(queryText, k * 2);

    // Filter out very short chunks from vector results (< 100 chars have degenerate embeddings)
    const vectorResults = rawVectorResults.filter(r => r.content.length >= 100);

    // Build rank maps
    const vectorRanks = new Map<string, number>();
    vectorResults.forEach((r, i) => vectorRanks.set(r.chunk_id, i + 1));

    const ftsRanks = new Map<string, number>();
    ftsResults.forEach((r, i) => ftsRanks.set(r.chunk_id, i + 1));

    // Collect all unique chunk IDs
    const allChunkIds = new Set([...vectorRanks.keys(), ...ftsRanks.keys()]);

    // Build record map for metadata
    const recordMap = new Map<string, ChunkRecord>();
    for (const r of vectorResults) recordMap.set(r.chunk_id, r);
    for (const r of ftsResults) recordMap.set(r.chunk_id, r);

    // Dynamically adjust vector weight based on FTS result quality
    // If FTS found good matches, weight it higher (keywords are important)
    const hasFtsResults = ftsResults.length > 0;
    const vectorWeight = hasFtsResults ? 0.3 : 0.7;  // Favor FTS when it has results

    // Calculate RRF scores with boost for overlap
    const scores: Array<{
      chunk_id: string;
      score: number;
      vectorRank?: number;
      ftsRank?: number;
    }> = [];

    for (const chunkId of allChunkIds) {
      const vRank = vectorRanks.get(chunkId);
      const fRank = ftsRanks.get(chunkId);

      // RRF formula: 1 / (k + rank) for each ranking, then weighted sum
      const vectorScore = vRank ? vectorWeight / (rrfK + vRank) : 0;
      const ftsScore = fRank ? (1 - vectorWeight) / (rrfK + fRank) : 0;

      let combinedScore = vectorScore + ftsScore;

      // Boost chunks that appear in BOTH result sets (strong relevance signal)
      if (vRank && fRank) {
        combinedScore *= 1.5;
      }

      // Penalize vector-only results when FTS has matches (they may be false positives)
      if (vRank && !fRank && hasFtsResults) {
        combinedScore *= 0.5;
      }

      scores.push({
        chunk_id: chunkId,
        score: combinedScore,
        vectorRank: vRank,
        ftsRank: fRank
      });
    }

    // Sort by combined score
    scores.sort((a, b) => b.score - a.score);

    // Return top k with full records
    return scores.slice(0, k).map(s => ({
      ...recordMap.get(s.chunk_id)!,
      score: s.score,
      vectorRank: s.vectorRank,
      ftsRank: s.ftsRank
    }));
  }

  // ============ File Tracking Methods ============

  /**
   * Get file tracking info
   */
  getFileInfo(filePath: string): FileTrackingInfo | null {
    const row = this.db.prepare(`
      SELECT path, content_hash, mtime, chunk_ids FROM file_tracking WHERE path = ?
    `).get(filePath) as { path: string; content_hash: string; mtime: number; chunk_ids: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      path: row.path,
      contentHash: row.content_hash,
      mtime: row.mtime,
      chunkIds: JSON.parse(row.chunk_ids)
    };
  }

  /**
   * Update file tracking info
   */
  setFileInfo(info: FileTrackingInfo): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO file_tracking (path, content_hash, mtime, chunk_ids)
      VALUES (?, ?, ?, ?)
    `).run(info.path, info.contentHash, info.mtime, JSON.stringify(info.chunkIds));
  }

  /**
   * Get all tracked file paths
   */
  getAllTrackedPaths(): string[] {
    const rows = this.db.prepare(`SELECT path FROM file_tracking`).all() as { path: string }[];
    return rows.map(r => r.path);
  }

  /**
   * Remove multiple file tracking infos
   */
  removeFileInfos(filePaths: string[]): void {
    const stmt = this.db.prepare(`DELETE FROM file_tracking WHERE path = ?`);
    const removeMany = this.db.transaction((paths: string[]) => {
      for (const p of paths) {
        stmt.run(p);
      }
    });
    removeMany(filePaths);
  }

  // ============ Stats Methods ============

  /**
   * Get total chunk count
   */
  getChunkCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM chunks`).get() as { count: number };
    return row.count;
  }

  /**
   * Get unique document count
   */
  getDocCount(): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT doc_id) as count FROM chunks`).get() as { count: number };
    return row.count;
  }

  /**
   * Get all chunks for a document (by doc_id or URL)
   * Returns chunks ordered by their sequence in the document
   */
  getDocumentChunks(docIdOrUrl: string): Array<ChunkRecord> {
    // Normalize: strip .md suffix and leading/trailing slashes
    const normalized = docIdOrUrl.replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '');
    
    const rows = this.db.prepare(`
      SELECT 
        chunk_id, doc_id, path, url, title, section, 
        tags, date, headings, content, content_hash, assertion, findings, updated_at
      FROM chunks
      WHERE doc_id = ? OR url = ? OR url LIKE ? OR url LIKE ?
      ORDER BY chunk_id
    `).all(docIdOrUrl, docIdOrUrl, `%${docIdOrUrl}%`, `%${normalized}%`) as Array<{
      chunk_id: string;
      doc_id: string;
      path: string;
      url: string;
      title: string;
      section: string;
      tags: string;
      date: string;
      headings: string;
      content: string;
      content_hash: string;
      assertion: string;
      findings: string;
      updated_at: number;
    }>;

    return rows.map(row => ({
      chunk_id: row.chunk_id,
      doc_id: row.doc_id,
      path: row.path,
      url: row.url,
      title: row.title,
      section: row.section,
      tags: JSON.parse(row.tags),
      date: row.date,
      headings: JSON.parse(row.headings),
      content: row.content,
      content_hash: row.content_hash,
      assertion: row.assertion,
      findings: row.findings,
      updated_at: row.updated_at,
      vector: []
    }));
  }

  /**
   * List all unique documents with their titles and URLs
   */
  listDocuments(): Array<{ doc_id: string; url: string; title: string; chunk_count: number }> {
    const rows = this.db.prepare(`
      SELECT 
        doc_id, 
        url, 
        title, 
        COUNT(*) as chunk_count
      FROM chunks 
      GROUP BY doc_id
      ORDER BY title
    `).all() as Array<{
      doc_id: string;
      url: string;
      title: string;
      chunk_count: number;
    }>;

    return rows;
  }

  /**
   * Find documents that link to the given document (by path matching in content)
   */
  findRelatedDocuments(docPath: string, limit: number = 5): Array<{ doc_id: string; url: string; title: string }> {
    // Extract filename from path for matching
    const filename = docPath.split('/').pop()?.replace(/\.md$/, '') || docPath;
    
    const rows = this.db.prepare(`
      SELECT DISTINCT 
        doc_id, 
        url, 
        title
      FROM chunks 
      WHERE content LIKE ? OR content LIKE ?
      ORDER BY title
      LIMIT ?
    `).all(`%](${filename}%`, `%](../${filename}%`, limit) as Array<{
      doc_id: string;
      url: string;
      title: string;
    }>;

    return rows;
  }

  /**
   * Get stored dimension from metadata
   */
  getStoredDimension(): number | null {
    const row = this.db.prepare(`SELECT value FROM metadata WHERE key = 'dimension'`).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : null;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
