/**
 * VectorizeStore: SQLite + sqlite-vec backing store for a single Vectorize
 * index. One sqlite file per index.
 *
 * Schema:
 *   index_meta(key, value)          - dimensions, metric, created_at, last_mutation
 *   vectors(id, namespace, values, metadata, created_at)
 *   vec_index USING vec0(id, embedding FLOAT[dim])
 *   metadata_indexes(property, index_type)
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { compileFilter } from './filter.js';
import {
  DEFAULT_TOP_K,
  METADATA_INDEX_MAX,
  TOP_K_MAX,
  TOP_K_MAX_WITH_VALUES,
  type VectorizeDistanceMetric,
  type VectorizeIndexDetails,
  type VectorizeListVectorsOptions,
  type VectorizeListVectorsResult,
  type VectorizeMatch,
  type VectorizeMatches,
  type VectorizeMetadata,
  type VectorizeMetadataFilter,
  type VectorizeMetadataIndex,
  type VectorizeMetadataIndexType,
  type VectorizeQueryOptions,
  type VectorizeReturnMetadata,
  type VectorizeVector,
  type VectorizeVectorValues,
} from './types.js';

export interface VectorizeStoreOptions {
  dbPath: string;
  dimensions: number;
  metric: VectorizeDistanceMetric;
}

interface StoredVectorRow {
  id: string;
  namespace: string | null;
  vec_values: Buffer;
  metadata: string | null;
}

export class VectorizeStore {
  private db: Database.Database;
  readonly dimensions: number;
  readonly metric: VectorizeDistanceMetric;

  constructor(opts: VectorizeStoreOptions) {
    const dir = path.dirname(opts.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(opts.dbPath);
    sqliteVec.load(this.db);

    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        namespace TEXT,
        vec_values BLOB NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_namespace ON vectors(namespace);
      CREATE TABLE IF NOT EXISTS metadata_indexes (
        property TEXT PRIMARY KEY,
        index_type TEXT NOT NULL CHECK(index_type IN ('string','number','boolean'))
      );
    `);

    // Resolve previously-stored config, or initialize.
    const existingDim = this.metaGet('dimensions');
    const existingMetric = this.metaGet('metric');

    if (existingDim && Number(existingDim) !== opts.dimensions) {
      throw new Error(
        `index at ${opts.dbPath} was created with dimensions=${existingDim}, ` +
          `but caller requested ${opts.dimensions}`
      );
    }
    if (existingMetric && existingMetric !== opts.metric) {
      throw new Error(
        `index at ${opts.dbPath} was created with metric=${existingMetric}, ` +
          `but caller requested ${opts.metric}`
      );
    }

    this.metaSet('dimensions', String(opts.dimensions));
    this.metaSet('metric', opts.metric);
    if (!this.metaGet('created_at')) {
      this.metaSet('created_at', String(Date.now()));
    }

    this.dimensions = opts.dimensions;
    this.metric = opts.metric;

    // vec0 virtual table: must use literal dimensions, so create lazily after
    // we know `dimensions`.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_index USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${this.dimensions}] distance_metric=${vecDistanceMetric(this.metric)}
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private metaGet(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM index_meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  private metaSet(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  describe(): VectorizeIndexDetails {
    const count = (
      this.db.prepare(`SELECT COUNT(*) as c FROM vectors`).get() as { c: number }
    ).c;
    return {
      dimensions: this.dimensions,
      metric: this.metric,
      vectorsCount: count,
      processedUpToMutation: this.metaGet('last_mutation'),
    };
  }

  /**
   * Insert vectors. Throws if any ID already exists (matches Vectorize).
   */
  insert(vectors: VectorizeVector[]): { mutationId: string; count: number; ids: string[] } {
    return this.writeBatch(vectors, false);
  }

  /**
   * Upsert vectors. Existing IDs are replaced in full.
   */
  upsert(vectors: VectorizeVector[]): { mutationId: string; count: number; ids: string[] } {
    return this.writeBatch(vectors, true);
  }

  private writeBatch(
    vectors: VectorizeVector[],
    overwrite: boolean
  ): { mutationId: string; count: number; ids: string[] } {
    if (vectors.length === 0) {
      return { mutationId: this.recordMutation(), count: 0, ids: [] };
    }

    const insertVec = this.db.prepare(
      overwrite
        ? `INSERT OR REPLACE INTO vec_index (id, embedding) VALUES (?, ?)`
        : `INSERT INTO vec_index (id, embedding) VALUES (?, ?)`
    );
    const insertRow = this.db.prepare(
      overwrite
        ? `INSERT OR REPLACE INTO vectors (id, namespace, vec_values, metadata, created_at)
           VALUES (?, ?, ?, ?, ?)`
        : `INSERT INTO vectors (id, namespace, vec_values, metadata, created_at)
           VALUES (?, ?, ?, ?, ?)`
    );
    const deleteVec = this.db.prepare(`DELETE FROM vec_index WHERE id = ?`);
    const existsStmt = this.db.prepare(`SELECT 1 FROM vectors WHERE id = ?`);

    const inserted: string[] = [];
    const tx = this.db.transaction((items: VectorizeVector[]) => {
      const now = Date.now();
      for (const v of items) {
        if (!v.id) throw new Error('vector id is required');
        if (!v.values) {
          throw new Error(
            `vector ${v.id} has no values; pass values or configure an embedder for auto-embed`
          );
        }
        const values = toFloat32(v.values);
        if (values.length !== this.dimensions) {
          throw new Error(
            `vector ${v.id} has ${values.length} dimensions, expected ${this.dimensions}`
          );
        }

        if (!overwrite && existsStmt.get(v.id)) {
          // Vectorize insert skips existing IDs (returns only new IDs).
          continue;
        }

        if (overwrite) {
          // vec0 INSERT OR REPLACE is not always supported cleanly — delete then insert.
          deleteVec.run(v.id);
        }

        const metaJson = v.metadata ? JSON.stringify(v.metadata) : null;
        insertRow.run(
          v.id,
          v.namespace ?? null,
          Buffer.from(values.buffer, values.byteOffset, values.byteLength),
          metaJson,
          now
        );
        insertVec.run(v.id, values);
        inserted.push(v.id);
      }
    });
    tx(vectors);

    return {
      mutationId: this.recordMutation(),
      count: inserted.length,
      ids: inserted,
    };
  }

  getByIds(ids: string[]): VectorizeVector[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, namespace, vec_values, metadata FROM vectors WHERE id IN (${placeholders})`
      )
      .all(...ids) as StoredVectorRow[];
    return rows.map((row) => rowToVector(row, true, 'all'));
  }

  deleteByIds(ids: string[]): { mutationId: string; count: number; ids: string[] } {
    if (ids.length === 0) {
      return { mutationId: this.recordMutation(), count: 0, ids: [] };
    }
    const delRow = this.db.prepare(`DELETE FROM vectors WHERE id = ?`);
    const delVec = this.db.prepare(`DELETE FROM vec_index WHERE id = ?`);
    let count = 0;
    const deletedIds: string[] = [];
    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) {
        const r = delRow.run(id);
        delVec.run(id);
        if (r.changes > 0) {
          count++;
          deletedIds.push(id);
        }
      }
    });
    tx(ids);
    return { mutationId: this.recordMutation(), count, ids: deletedIds };
  }

  query(
    queryVector: VectorizeVectorValues,
    options: VectorizeQueryOptions = {}
  ): VectorizeMatches {
    const topK = clampTopK(options);
    const returnValues = options.returnValues ?? false;
    const returnMetadata: VectorizeReturnMetadata =
      options.returnMetadata ?? 'none';
    const namespace = options.namespace;

    const vec = toFloat32(queryVector);
    if (vec.length !== this.dimensions) {
      throw new Error(
        `query vector has ${vec.length} dimensions, expected ${this.dimensions}`
      );
    }

    const filterSql = compileFilter(options.filter);

    // Over-fetch from vec_index to leave room for namespace + metadata filtering.
    const fetchK = Math.max(topK * 5, 100);

    const knnRows = this.db
      .prepare(
        `SELECT id, distance FROM vec_index
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      )
      .all(vec, fetchK) as Array<{ id: string; distance: number }>;

    if (knnRows.length === 0) {
      return { count: 0, matches: [] };
    }

    // Pull the matching rows from `vectors`, applying namespace + filter in SQL.
    const ids = knnRows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const params: Array<string | number | null> = [...ids];
    let where = `id IN (${placeholders})`;

    if (namespace !== undefined) {
      where += ` AND namespace IS ?`;
      params.push(namespace);
    }
    if (filterSql) {
      where += ` AND (${filterSql.sql})`;
      params.push(...filterSql.params);
    }

    const rows = this.db
      .prepare(
        `SELECT id, namespace, vec_values, metadata FROM vectors WHERE ${where}`
      )
      .all(...params) as StoredVectorRow[];

    const byId = new Map(rows.map((r) => [r.id, r]));
    const matches: VectorizeMatch[] = [];

    for (const k of knnRows) {
      const row = byId.get(k.id);
      if (!row) continue; // filtered out
      const score = distanceToScore(this.metric, k.distance);
      const m: VectorizeMatch = { id: row.id, score };
      if (row.namespace !== null) m.namespace = row.namespace;
      if (returnValues) {
        m.values = Array.from(bufferToFloat32(row.vec_values));
      }
      if (returnMetadata !== 'none' && row.metadata) {
        m.metadata = JSON.parse(row.metadata) as VectorizeMetadata;
      }
      matches.push(m);
      if (matches.length >= topK) break;
    }

    return { count: matches.length, matches };
  }

  queryById(id: string, options: VectorizeQueryOptions = {}): VectorizeMatches {
    const row = this.db
      .prepare(`SELECT vec_values FROM vectors WHERE id = ?`)
      .get(id) as { vec_values: Buffer } | undefined;
    if (!row) {
      return { count: 0, matches: [] };
    }
    return this.query(bufferToFloat32(row.vec_values), options);
  }

  listVectors(options: VectorizeListVectorsOptions = {}): VectorizeListVectorsResult {
    const count = Math.min(Math.max(options.count ?? 100, 1), 1000);
    const cursor = options.cursor ?? '';
    const rows = this.db
      .prepare(
        `SELECT id FROM vectors WHERE id > ? ORDER BY id LIMIT ?`
      )
      .all(cursor, count + 1) as Array<{ id: string }>;

    const isTruncated = rows.length > count;
    const page = rows.slice(0, count);
    return {
      count: page.length,
      vectors: page,
      cursor: isTruncated ? page[page.length - 1].id : undefined,
      isTruncated,
    };
  }

  createMetadataIndex(
    propertyName: string,
    indexType: VectorizeMetadataIndexType
  ): { mutationId: string } {
    const current = (
      this.db.prepare(`SELECT COUNT(*) as c FROM metadata_indexes`).get() as { c: number }
    ).c;
    const exists = this.db
      .prepare(`SELECT 1 FROM metadata_indexes WHERE property = ?`)
      .get(propertyName);
    if (!exists && current >= METADATA_INDEX_MAX) {
      throw new Error(
        `cannot create more than ${METADATA_INDEX_MAX} metadata indexes per index`
      );
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO metadata_indexes (property, index_type) VALUES (?, ?)`
      )
      .run(propertyName, indexType);
    return { mutationId: this.recordMutation() };
  }

  deleteMetadataIndex(propertyName: string): { mutationId: string } {
    this.db
      .prepare(`DELETE FROM metadata_indexes WHERE property = ?`)
      .run(propertyName);
    return { mutationId: this.recordMutation() };
  }

  listMetadataIndexes(): VectorizeMetadataIndex[] {
    const rows = this.db
      .prepare(`SELECT property, index_type FROM metadata_indexes ORDER BY property`)
      .all() as Array<{ property: string; index_type: VectorizeMetadataIndexType }>;
    return rows.map((r) => ({
      propertyName: r.property,
      indexType: r.index_type,
    }));
  }

  private recordMutation(): string {
    const id = randomUUID();
    this.metaSet('last_mutation', id);
    return id;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function vecDistanceMetric(m: VectorizeDistanceMetric): string {
  // sqlite-vec metric names
  switch (m) {
    case 'cosine':
      return 'cosine';
    case 'euclidean':
      return 'L2';
    case 'dot-product':
      return 'cosine'; // fallback; we compute dot-product score from cosine distance
  }
}

/**
 * Convert sqlite-vec distance to Vectorize-style score.
 *  - cosine: score = 1 - distance/2  (sqlite-vec cosine distance is in [0, 2])
 *  - euclidean: score = distance (Cloudflare returns raw L2)
 *  - dot-product: returned as -score (smaller is closer, per Cloudflare docs)
 */
function distanceToScore(
  metric: VectorizeDistanceMetric,
  distance: number
): number {
  switch (metric) {
    case 'cosine':
      // sqlite-vec cosine distance: 0 (identical) to 2 (opposite)
      return 1 - distance / 2;
    case 'euclidean':
      return distance;
    case 'dot-product':
      // We mapped dot-product to cosine in vec0; surface a cosine-based score.
      // Callers using dot-product semantics should pre-normalize vectors.
      return 1 - distance / 2;
  }
}

function clampTopK(opts: VectorizeQueryOptions): number {
  const requested = opts.topK ?? DEFAULT_TOP_K;
  const cap =
    opts.returnValues || opts.returnMetadata === 'all'
      ? TOP_K_MAX_WITH_VALUES
      : TOP_K_MAX;
  if (requested < 1) throw new Error('topK must be >= 1');
  if (requested > cap) {
    throw new Error(
      `topK ${requested} exceeds cap ${cap} (returnValues/returnMetadata=all reduces the cap to ${TOP_K_MAX_WITH_VALUES})`
    );
  }
  return requested;
}

function toFloat32(v: VectorizeVectorValues): Float32Array {
  if (v instanceof Float32Array) return v;
  if (v instanceof Float64Array) return new Float32Array(v);
  return new Float32Array(v);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

function rowToVector(
  row: StoredVectorRow,
  includeValues: boolean,
  returnMetadata: VectorizeReturnMetadata
): VectorizeVector {
  const v: VectorizeVector = { id: row.id };
  if (row.namespace !== null) v.namespace = row.namespace;
  if (includeValues) v.values = Array.from(bufferToFloat32(row.vec_values));
  if (returnMetadata !== 'none' && row.metadata) {
    v.metadata = JSON.parse(row.metadata) as VectorizeMetadata;
  }
  return v;
}
