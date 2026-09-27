use anyhow::Result;
use rusqlite::{ffi::sqlite3_auto_extension, params, Connection};
use tracing::info;

/// A search result from the index
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub chunk_id: String,
    pub doc_id: String,
    pub url: String,
    pub title: String,
    pub content: String,
    pub score: f64,
}

/// SQLite storage layer with FTS5 and sqlite-vec ANN search
pub struct SqliteStore {
    conn: Connection,
    dimension: usize,
}

impl SqliteStore {
    /// Create a new SqliteStore
    pub fn new(db_path: &str, dimension: usize) -> Result<Self> {
        // Register sqlite-vec as auto-extension before opening
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }

        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

        Ok(Self { conn, dimension })
    }

    /// Initialize database schema
    pub fn init(&mut self, clean: bool) -> Result<()> {
        if clean {
            self.conn.execute_batch(
                "DROP TABLE IF EXISTS chunks;
                 DROP TABLE IF EXISTS chunks_fts;
                 DROP TABLE IF EXISTS chunks_vec;
                 DROP TABLE IF EXISTS file_tracking;
                 DROP TABLE IF EXISTS metadata;",
            )?;
        }

        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                path TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                section TEXT,
                content TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS chunks_fts (
                chunk_id TEXT,
                title TEXT,
                content TEXT
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_idx USING fts5(
                title, content, content='chunks_fts', content_rowid='rowid'
            );

            CREATE TABLE IF NOT EXISTS file_tracking (
                path TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                mtime INTEGER NOT NULL,
                chunk_ids TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;

        // sqlite-vec virtual table for ANN search
        let vec_sql = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                chunk_id TEXT PRIMARY KEY,
                embedding float[{}]
            )",
            self.dimension
        );
        self.conn.execute_batch(&vec_sql)?;

        info!("Database schema initialized (dim: {}, sqlite-vec ANN)", self.dimension);
        Ok(())
    }

    /// Insert a chunk with its embedding vector
    pub fn insert_chunk(
        &mut self,
        chunk_id: &str,
        doc_id: &str,
        path: &str,
        url: &str,
        title: &str,
        section: &str,
        content: &str,
        content_hash: &str,
        embedding: &[f32],
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO chunks (chunk_id, doc_id, path, url, title, section, content, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![chunk_id, doc_id, path, url, title, section, content, content_hash],
        )?;

        // vec0 doesn't support OR REPLACE, so delete first if exists
        let _ = self.conn.execute("DELETE FROM chunks_vec WHERE chunk_id = ?1", params![chunk_id]);
        let embedding_blob: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        self.conn.execute(
            "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?1, ?2)",
            params![chunk_id, embedding_blob],
        )?;

        self.conn.execute(
            "INSERT INTO chunks_fts (chunk_id, title, content) VALUES (?1, ?2, ?3)",
            params![chunk_id, title, content],
        )?;

        Ok(())
    }

    /// Track a file for incremental builds
    pub fn track_file(&self, path: &str, content_hash: &str, mtime: i64, chunk_ids: &[String]) -> Result<()> {
        let ids_json = serde_json::to_string(chunk_ids)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO file_tracking (path, content_hash, mtime, chunk_ids) VALUES (?1, ?2, ?3, ?4)",
            params![path, content_hash, mtime, ids_json],
        )?;
        Ok(())
    }

    /// Get tracked file info for incremental builds
    pub fn get_tracked_file(&self, path: &str) -> Result<Option<(String, i64, Vec<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT content_hash, mtime, chunk_ids FROM file_tracking WHERE path = ?1",
        )?;
        let result = stmt.query_row(params![path], |row| {
            let hash: String = row.get(0)?;
            let mtime: i64 = row.get(1)?;
            let ids_json: String = row.get(2)?;
            Ok((hash, mtime, ids_json))
        });

        match result {
            Ok((hash, mtime, ids_json)) => {
                let ids: Vec<String> = serde_json::from_str(&ids_json).unwrap_or_default();
                Ok(Some((hash, mtime, ids)))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Remove chunks by IDs (for incremental rebuild)
    pub fn remove_chunks(&mut self, chunk_ids: &[String]) -> Result<()> {
        for id in chunk_ids {
            self.conn.execute("DELETE FROM chunks WHERE chunk_id = ?1", params![id])?;
            self.conn.execute("DELETE FROM chunks_vec WHERE chunk_id = ?1", params![id])?;
            self.conn.execute("DELETE FROM chunks_fts WHERE chunk_id = ?1", params![id])?;
        }
        Ok(())
    }

    /// Remove file tracking entry
    pub fn remove_tracked_file(&self, path: &str) -> Result<()> {
        self.conn.execute("DELETE FROM file_tracking WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Hybrid search: sqlite-vec ANN + FTS5 BM25 with RRF
    pub fn hybrid_search(&self, query: &str, query_embedding: &[f32], k: usize) -> Result<Vec<SearchResult>> {
        // FTS5 BM25
        let mut fts_stmt = self.conn.prepare(
            "SELECT cf.chunk_id, fi.rank
             FROM chunks_fts_idx fi
             JOIN chunks_fts cf ON cf.rowid = fi.rowid
             WHERE chunks_fts_idx MATCH ?1
             ORDER BY fi.rank LIMIT ?2",
        )?;
        let fts_results: Vec<(String, f64)> = fts_stmt
            .query_map(params![query, k * 2], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // sqlite-vec ANN
        let query_blob: Vec<u8> = query_embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        let mut vec_stmt = self.conn.prepare(
            "SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2",
        )?;
        let vec_results: Vec<(String, f64)> = vec_stmt
            .query_map(params![query_blob, k * 2], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        // RRF fusion
        let mut scores: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
        let rrf_k = 60.0;

        for (rank, (chunk_id, _)) in vec_results.iter().enumerate() {
            *scores.entry(chunk_id.clone()).or_default() += 1.0 / (rrf_k + rank as f64 + 1.0);
        }
        for (rank, (chunk_id, _)) in fts_results.iter().enumerate() {
            *scores.entry(chunk_id.clone()).or_default() += 1.0 / (rrf_k + rank as f64 + 1.0);
        }

        let mut ranked: Vec<_> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        ranked.truncate(k);

        let mut results = Vec::new();
        for (chunk_id, score) in ranked {
            if let Ok(r) = self.get_chunk(&chunk_id, score) {
                results.push(r);
            }
        }
        Ok(results)
    }

    /// Vector-only search
    pub fn vector_search(&self, query_embedding: &[f32], k: usize) -> Result<Vec<SearchResult>> {
        let query_blob: Vec<u8> = query_embedding.iter().flat_map(|f| f.to_le_bytes()).collect();
        let mut stmt = self.conn.prepare(
            "SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2",
        )?;
        let rows: Vec<(String, f64)> = stmt
            .query_map(params![query_blob, k], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut results = Vec::new();
        for (chunk_id, dist) in rows {
            if let Ok(r) = self.get_chunk(&chunk_id, 1.0 / (1.0 + dist)) {
                results.push(r);
            }
        }
        Ok(results)
    }

    /// FTS-only search
    pub fn fts_search(&self, query: &str, k: usize) -> Result<Vec<SearchResult>> {
        let mut stmt = self.conn.prepare(
            "SELECT cf.chunk_id, fi.rank
             FROM chunks_fts_idx fi
             JOIN chunks_fts cf ON cf.rowid = fi.rowid
             WHERE chunks_fts_idx MATCH ?1
             ORDER BY fi.rank LIMIT ?2",
        )?;
        let rows: Vec<(String, f64)> = stmt
            .query_map(params![query, k], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut results = Vec::new();
        for (chunk_id, rank) in rows {
            if let Ok(r) = self.get_chunk(&chunk_id, -rank) {
                results.push(r);
            }
        }
        Ok(results)
    }

    /// Get total chunk count
    pub fn chunk_count(&self) -> Result<usize> {
        let c: i64 = self.conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))?;
        Ok(c as usize)
    }

    fn get_chunk(&self, chunk_id: &str, score: f64) -> Result<SearchResult> {
        let mut stmt = self.conn.prepare(
            "SELECT chunk_id, doc_id, url, title, content FROM chunks WHERE chunk_id = ?1",
        )?;
        let result = stmt.query_row(params![chunk_id], |row| {
            Ok(SearchResult {
                chunk_id: row.get(0)?,
                doc_id: row.get(1)?,
                url: row.get(2)?,
                title: row.get(3)?,
                content: row.get(4)?,
                score,
            })
        })?;
        Ok(result)
    }
}
