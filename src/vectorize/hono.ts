/**
 * Hono middleware that injects local Vectorize-compatible bindings into
 * `c.env`. Mirrors what Cloudflare's runtime does automatically for Workers.
 *
 * Usage:
 *   import { Hono } from 'hono';
 *   import { createLocalIndex, vectorizeBindings } from '@mieweb/footnote/vectorize/hono';
 *
 *   const MY_INDEX = createLocalIndex({ name: 'demo', dimensions: 768, metric: 'cosine' });
 *   const app = new Hono();
 *   app.use('*', vectorizeBindings({ MY_INDEX }));
 */
import type { MiddlewareHandler } from 'hono';
import type { VectorizeIndex } from './types.js';
export { createLocalIndex, LocalVectorizeIndex } from './local-index.js';
export type { CreateLocalIndexOptions } from './local-index.js';
export * from './types.js';

export type VectorizeBindingsMap = Record<string, VectorizeIndex>;

export function vectorizeBindings(
  bindings: VectorizeBindingsMap
): MiddlewareHandler {
  return async (c, next) => {
    // Merge bindings into c.env without clobbering existing entries.
    const env = (c.env ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(bindings)) {
      if (env[k] === undefined) env[k] = v;
    }
    // hono's c.env is readonly in the type, but mutating the underlying
    // object is fine and matches how other Hono adapters inject bindings.
    (c as unknown as { env: Record<string, unknown> }).env = env;
    await next();
  };
}
