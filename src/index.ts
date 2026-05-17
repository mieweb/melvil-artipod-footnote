/**
 * docidx - Markdown Content Index Compiler
 * 
 * Produces portable SQLite hybrid footnote indexes (sqlite-vec + FTS5)
 * from markdown content for server-side RAG consumption.
 */

// Configuration
export * from './config/index.js';

// Storage
export { SqliteStore } from './storage/sqlite.js';
export type { ChunkRecord, FileTrackingInfo, SqliteStoreConfig } from './storage/sqlite.js';
export { readManifest, writeManifest, generateManifest, DEFAULT_SYSTEM_PROMPT } from './storage/manifest.js';
export type { ManifestData, AgentConfig } from './storage/manifest.js';

// Parser
export { parseFrontMatter, parseMarkdown } from './parser/markdown.js';
export type { FrontMatter, ParsedDocument, HeadingInfo, Section } from './parser/markdown.js';
export { processShortcodes, shouldIncludeDocument } from './parser/transform.js';

// Chunker
export { chunkDocument, hashContent } from './chunker/chunker.js';
export type { Chunk, ChunkConfig } from './chunker/chunker.js';

// Embedder
export { createEmbedder, autoDetectEmbedder, isOllamaModelInstalled, pullOllamaModel } from './embedder/embedder.js';
export type { Embedder, EmbedderConfig } from './embedder/embedder.js';

// Build
export { buildIndex } from './indexer/build.js';
export type { BuildOptions, BuildResult } from './indexer/build.js';
