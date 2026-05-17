/**
 * Query Handler
 * 
 * Runs hybrid queries against the index for testing/validation.
 * Uses sqlite-vec for vector search and FTS5 for BM25 search.
 */
import * as path from 'path';
import * as fs from 'fs';
import { createLogger, format, transports } from 'winston';

import { createEmbedder } from '../embedder/embedder.js';
import { SqliteStore, type ChunkRecord } from '../storage/sqlite.js';
import { readManifest } from '../storage/manifest.js';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [new transports.Console()]
});

export interface QueryOptions {
  dbPath: string;
  query: string;
  k: number;
  embeddingModel?: string;
}

export interface QueryResult {
  chunk_id: string;
  doc_id: string;
  url: string;
  title: string;
  headings: string[];
  content: string;
  score: number;
  vectorRank?: number;
  ftsRank?: number;
}

/**
 * Run a hybrid query against the index
 */
export async function queryIndex(options: QueryOptions): Promise<QueryResult[]> {
  const footnoteDir = path.resolve(options.dbPath);
  const indexPath = path.join(footnoteDir, 'index.sqlite');
  const manifestPath = path.join(footnoteDir, 'manifest.json');

  // Validate paths
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Index not found: ${indexPath}`);
  }

  // Read manifest for configuration
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  // Use provided model, or fall back to manifest, or mock if provider is mock
  let embeddingModel = options.embeddingModel || manifest.embedding.model_id;
  if (manifest.embedding.provider === 'mock') {
    embeddingModel = 'mock';
  }
  const embeddingDim = manifest.embedding.dimension;

  logger.debug(`Using embedding model: ${embeddingModel} (dim: ${embeddingDim})`);

  // Initialize components
  const embedder = createEmbedder({
    model: embeddingModel,
    dimension: embeddingDim
  });

  const store = new SqliteStore({
    dbPath: indexPath,
    dimension: embeddingDim
  });

  try {
    store.init(false);

    // Embed the query
    logger.debug(`Embedding query: "${options.query}"`);
    const [queryVector] = await embedder.embed([options.query]);

    // Run hybrid search with RRF
    logger.debug(`Running hybrid search (k=${options.k})`);
    const results = store.hybridSearch(queryVector, options.query, options.k);

    // Format results
    return results.map(r => ({
      chunk_id: r.chunk_id,
      doc_id: r.doc_id,
      url: r.url,
      title: r.title,
      headings: Array.isArray(r.headings) ? r.headings : (r.headings ? [String(r.headings)] : []),
      content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      score: r.score,
      vectorRank: r.vectorRank,
      ftsRank: r.ftsRank
    }));

  } finally {
    store.close();
  }
}
