/**
 * LocalVectorizeIndex: implements the Cloudflare `VectorizeIndex` runtime
 * interface backed by a local sqlite-vec file.
 *
 * Drop-in for `env.YOUR_INDEX` in Hono / Workers handlers via the
 * `vectorizeBindings()` middleware.
 */
import * as path from 'path';
import { VectorizeStore } from './store.js';
import { createEmbedder, type Embedder, type EmbedderConfig } from '../embedder/embedder.js';
import type {
  VectorizeAsyncMutation,
  VectorizeDistanceMetric,
  VectorizeIndex,
  VectorizeIndexDetails,
  VectorizeListVectorsOptions,
  VectorizeListVectorsResult,
  VectorizeMatches,
  VectorizeMetadataIndex,
  VectorizeMetadataIndexType,
  VectorizeQueryOptions,
  VectorizeVector,
  VectorizeVectorValues,
} from './types.js';

export interface CreateLocalIndexOptions {
  /** Index name. Used to derive the DB file name when `dbPath` is not set. */
  name: string;
  dimensions: number;
  metric: VectorizeDistanceMetric;
  /** Override the directory for the sqlite file. Default: `./.footnote`. */
  dbDir?: string;
  /** Override the full sqlite path. Takes precedence over `dbDir`+`name`. */
  dbPath?: string;
  /**
   * Optional embedder config. When set, callers may pass `{ text }` on
   * insert/upsert and a string to `query()` instead of raw vectors.
   * Cloudflare Vectorize does NOT support this — it is a FOOTNOTE extension.
   */
  embedder?: EmbedderConfig | Embedder;
}

export class LocalVectorizeIndex implements VectorizeIndex {
  private store: VectorizeStore;
  private embedder?: Embedder;
  readonly name: string;

  constructor(opts: CreateLocalIndexOptions) {
    this.name = opts.name;
    const dbPath =
      opts.dbPath ?? path.join(opts.dbDir ?? './.footnote', `${opts.name}.sqlite`);
    this.store = new VectorizeStore({
      dbPath,
      dimensions: opts.dimensions,
      metric: opts.metric,
    });
    if (opts.embedder) {
      this.embedder = isEmbedder(opts.embedder)
        ? opts.embedder
        : createEmbedder(opts.embedder);
    }
  }

  close(): void {
    this.store.close();
  }

  /** Underlying store — exposed for tests and advanced callers. */
  get _store(): VectorizeStore {
    return this.store;
  }

  async insert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    const filled = await this.fillEmbeddings(vectors);
    const r = this.store.insert(filled);
    return { mutationId: r.mutationId, count: r.count, ids: r.ids };
  }

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    const filled = await this.fillEmbeddings(vectors);
    const r = this.store.upsert(filled);
    return { mutationId: r.mutationId, count: r.count, ids: r.ids };
  }

  async query(
    vector: VectorizeVectorValues | string,
    options: VectorizeQueryOptions = {}
  ): Promise<VectorizeMatches> {
    const vec = await this.resolveQueryVector(vector);
    return this.store.query(vec, options);
  }

  async queryById(
    vectorId: string,
    options: VectorizeQueryOptions = {}
  ): Promise<VectorizeMatches> {
    return this.store.queryById(vectorId, options);
  }

  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    return this.store.getByIds(ids);
  }

  async deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation> {
    const r = this.store.deleteByIds(ids);
    return { mutationId: r.mutationId, count: r.count, ids: r.ids };
  }

  async describe(): Promise<VectorizeIndexDetails> {
    return this.store.describe();
  }

  async listVectors(
    options: VectorizeListVectorsOptions = {}
  ): Promise<VectorizeListVectorsResult> {
    return this.store.listVectors(options);
  }

  async createMetadataIndex(
    options: VectorizeMetadataIndex
  ): Promise<VectorizeAsyncMutation> {
    const r = this.store.createMetadataIndex(
      options.propertyName,
      options.indexType as VectorizeMetadataIndexType
    );
    return { mutationId: r.mutationId };
  }

  async deleteMetadataIndex(options: {
    propertyName: string;
  }): Promise<VectorizeAsyncMutation> {
    const r = this.store.deleteMetadataIndex(options.propertyName);
    return { mutationId: r.mutationId };
  }

  async listMetadataIndexes(): Promise<{
    metadataIndexes: VectorizeMetadataIndex[];
  }> {
    return { metadataIndexes: this.store.listMetadataIndexes() };
  }

  /* ---------- auto-embed extension ---------- */

  private async fillEmbeddings(
    vectors: VectorizeVector[]
  ): Promise<VectorizeVector[]> {
    const needs: number[] = [];
    const texts: string[] = [];
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i];
      if (!v.values && v.text !== undefined) {
        needs.push(i);
        texts.push(v.text);
      }
    }
    if (needs.length === 0) return vectors;

    if (!this.embedder) {
      throw new Error(
        `vector(s) passed { text } but no embedder is configured on this index. ` +
          `Pass { values } or construct the index with { embedder: { model, dimension } }.`
      );
    }
    const embeddings = await this.embedder.embed(texts);
    const out = vectors.slice();
    for (let i = 0; i < needs.length; i++) {
      const idx = needs[i];
      out[idx] = { ...out[idx], values: embeddings[i] };
    }
    return out;
  }

  private async resolveQueryVector(
    vector: VectorizeVectorValues | string
  ): Promise<VectorizeVectorValues> {
    if (typeof vector === 'string') {
      if (!this.embedder) {
        throw new Error(
          `query() was called with a string, but no embedder is configured on this index. ` +
            `Pass a vector or construct the index with { embedder: { model, dimension } }.`
        );
      }
      const [vec] = await this.embedder.embed([vector]);
      return vec;
    }
    return vector;
  }
}

export function createLocalIndex(
  options: CreateLocalIndexOptions
): LocalVectorizeIndex {
  return new LocalVectorizeIndex(options);
}

function isEmbedder(x: EmbedderConfig | Embedder): x is Embedder {
  return typeof (x as Embedder).embed === 'function';
}
