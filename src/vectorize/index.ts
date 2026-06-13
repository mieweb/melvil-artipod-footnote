/**
 * Public entry point for `@mieweb/footnote/vectorize`.
 */
export * from './types.js';
export { createLocalIndex, LocalVectorizeIndex } from './local-index.js';
export type { CreateLocalIndexOptions } from './local-index.js';
export { VectorizeStore } from './store.js';
export type { VectorizeStoreOptions } from './store.js';
export { compileFilter } from './filter.js';
