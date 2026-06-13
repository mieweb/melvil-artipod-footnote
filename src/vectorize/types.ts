/**
 * Cloudflare Vectorize-compatible type surface.
 *
 * These types mirror the runtime types exposed by Cloudflare Workers for the
 * Vectorize binding. `LocalVectorizeIndex` implements `VectorizeIndex` so the
 * same handler code runs against either backend.
 *
 * Reference: https://developers.cloudflare.com/vectorize/reference/client-api/
 */

export type VectorizeDistanceMetric = 'cosine' | 'euclidean' | 'dot-product';

export type VectorizeVectorValues = number[] | Float32Array | Float64Array;

export type VectorizeMetadataValue = string | number | boolean | null;

export type VectorizeMetadata = Record<
  string,
  VectorizeMetadataValue | VectorizeMetadataValue[] | Record<string, unknown>
>;

/**
 * Vector record. `values` is required for strict Vectorize parity; `text` is
 * a FOOTNOTE-only extension that triggers auto-embedding when the index has
 * an embedder configured.
 */
export interface VectorizeVector {
  id: string;
  values?: VectorizeVectorValues;
  namespace?: string;
  metadata?: VectorizeMetadata;
  /** FOOTNOTE extension: auto-embed this text via the index's embedder. */
  text?: string;
}

export type VectorizeReturnMetadata = 'none' | 'indexed' | 'all';

/** Comparison operators supported in metadata filters. */
export interface VectorizeFilterOperators {
  $eq?: VectorizeMetadataValue;
  $ne?: VectorizeMetadataValue;
  $in?: VectorizeMetadataValue[];
  $nin?: VectorizeMetadataValue[];
  $lt?: string | number;
  $lte?: string | number;
  $gt?: string | number;
  $gte?: string | number;
}

/**
 * Metadata filter. Keys are property names (dotted paths describe nesting).
 * Values are either a raw value (implicit `$eq`) or an operator object.
 * Multiple keys are combined with logical AND. The JSON representation must
 * be <= 2048 bytes.
 */
export type VectorizeMetadataFilter = Record<
  string,
  VectorizeMetadataValue | VectorizeFilterOperators
>;

export interface VectorizeQueryOptions {
  topK?: number;
  namespace?: string;
  returnValues?: boolean;
  returnMetadata?: VectorizeReturnMetadata;
  filter?: VectorizeMetadataFilter;
}

export interface VectorizeMatch {
  id: string;
  score: number;
  values?: number[];
  namespace?: string;
  metadata?: VectorizeMetadata;
}

export interface VectorizeMatches {
  count: number;
  matches: VectorizeMatch[];
}

export interface VectorizeAsyncMutation {
  mutationId: string;
  count?: number;
  ids?: string[];
}

export interface VectorizeIndexDetails {
  dimensions: number;
  metric: VectorizeDistanceMetric;
  vectorsCount: number;
  processedUpToMutation?: string;
  processedUpToDatetime?: string;
}

export type VectorizeMetadataIndexType = 'string' | 'number' | 'boolean';

export interface VectorizeMetadataIndex {
  propertyName: string;
  indexType: VectorizeMetadataIndexType;
}

export interface VectorizeListVectorsOptions {
  count?: number;
  cursor?: string;
}

export interface VectorizeListVectorsResult {
  count: number;
  vectors: Array<{ id: string }>;
  cursor?: string;
  isTruncated: boolean;
}

/** The runtime shape of `env.YOUR_INDEX` in a Worker. */
export interface VectorizeIndex {
  insert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation>;
  upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation>;
  query(
    vector: VectorizeVectorValues | string,
    options?: VectorizeQueryOptions
  ): Promise<VectorizeMatches>;
  queryById(
    vectorId: string,
    options?: VectorizeQueryOptions
  ): Promise<VectorizeMatches>;
  getByIds(ids: string[]): Promise<VectorizeVector[]>;
  deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation>;
  describe(): Promise<VectorizeIndexDetails>;
  listVectors(
    options?: VectorizeListVectorsOptions
  ): Promise<VectorizeListVectorsResult>;
  createMetadataIndex(
    options: VectorizeMetadataIndex
  ): Promise<VectorizeAsyncMutation>;
  deleteMetadataIndex(options: {
    propertyName: string;
  }): Promise<VectorizeAsyncMutation>;
  listMetadataIndexes(): Promise<{ metadataIndexes: VectorizeMetadataIndex[] }>;
}

/** Cap on the JSON length of a filter object (bytes). */
export const FILTER_MAX_BYTES = 2048;
/** Max metadata indexes per index. */
export const METADATA_INDEX_MAX = 10;
/** Default topK when not specified. */
export const DEFAULT_TOP_K = 5;
/** Hard cap on topK. */
export const TOP_K_MAX = 100;
/** Cap on topK when returning values or all metadata. */
export const TOP_K_MAX_WITH_VALUES = 50;
