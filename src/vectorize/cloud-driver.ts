/**
 * `@mieweb/cloud` driver factory — lets footnote be registered as the vector
 * store behind cloud's `CloudVectorIndex` binding ("make FOOTNOTE default").
 *
 * `@mieweb/cloud-local` wires bindings through its driver registry:
 *   registerDriver(name, ({ cfg, resolvePath }) => CloudVectorIndex)
 * where `CloudVectorIndex` is the Cloudflare `VectorizeIndex` interface. footnote's
 * `LocalVectorizeIndex` ALREADY implements that interface, so this is thin
 * config-mapping glue — no method wrapping. (cloud's own sqlite-vec adapter even
 * documents that it "mirrors the FOOTNOTE index pattern" — this just uses the real one.)
 *
 * Wire it up in a cloud consumer (its bootstrap, or `@mieweb/cloud` itself):
 *
 *   import { registerDriver } from '@mieweb/cloud-local';
 *   import { footnoteVectorDriver } from '@mieweb/footnote/vectorize';
 *   registerDriver('footnote', footnoteVectorDriver);
 *
 * then point the binding at it in `mieweb.jsonc`:
 *
 *   "VECTOR": { "driver": "footnote", "path": ".data/local/vec.sqlite", "dim": 768 }
 */
import { createLocalIndex, type LocalVectorizeIndex } from './local-index.js';
import type { VectorizeDistanceMetric } from './types.js';

/** The subset of a cloud vector-binding config this driver reads. */
export interface FootnoteBindingConfig {
  /** sqlite file path for the index (resolved via `resolvePath`). */
  path?: string;
  /** Index name; derives the DB file when `path` is omitted. */
  name?: string;
  /** Embedding dimension. Default 768. */
  dim?: number;
  /** Distance metric. Default 'cosine'. */
  metric?: VectorizeDistanceMetric;
}

/** The factory argument shape `@mieweb/cloud-local` passes to `registerDriver`. */
export interface CloudDriverContext {
  cfg: FootnoteBindingConfig;
  resolvePath: (p: string) => string;
}

/**
 * Driver factory: maps a cloud vector-binding config to a footnote-backed index.
 * Register with `registerDriver('footnote', footnoteVectorDriver)`.
 */
export function footnoteVectorDriver({ cfg, resolvePath }: CloudDriverContext): LocalVectorizeIndex {
  return createLocalIndex({
    name: cfg.name ?? 'index',
    dimensions: cfg.dim ?? 768,
    metric: cfg.metric ?? 'cosine',
    dbPath: cfg.path ? resolvePath(cfg.path) : undefined,
  });
}
