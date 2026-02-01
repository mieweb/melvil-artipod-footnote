/**
 * Embedding Cache
 * 
 * Caches embeddings by content hash in a dot folder (.embed-{model}).
 * This avoids re-computing embeddings for unchanged chunks across builds.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface EmbeddingCache {
  get(contentHash: string): number[] | null;
  set(contentHash: string, embedding: number[]): void;
  getMany(contentHashes: string[]): Map<string, number[]>;
  setMany(entries: Map<string, number[]>): void;
}

/**
 * Sanitize model ID for use as folder name
 * e.g., "ollama:nomic-embed-text" -> "nomic-embed-text"
 */
function sanitizeModelName(modelId: string): string {
  // Remove provider prefix
  const name = modelId.replace(/^(ollama|openai):/, '');
  // Replace any remaining unsafe chars
  return name.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * File-based embedding cache
 * Stores embeddings as binary Float32Array files keyed by content hash.
 */
export class FileEmbeddingCache implements EmbeddingCache {
  private cacheDir: string;

  constructor(baseDir: string, modelId: string) {
    const sanitized = sanitizeModelName(modelId);
    this.cacheDir = path.join(baseDir, `.embed-${sanitized}`);
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCachePath(contentHash: string): string {
    // Use first 2 chars as subdirectory to avoid large directory listings
    const subdir = contentHash.slice(0, 2);
    const filename = contentHash.slice(2) + '.bin';
    return path.join(this.cacheDir, subdir, filename);
  }

  get(contentHash: string): number[] | null {
    const cachePath = this.getCachePath(contentHash);
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    try {
      const buffer = fs.readFileSync(cachePath);
      const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
      return Array.from(float32);
    } catch {
      return null;
    }
  }

  set(contentHash: string, embedding: number[]): void {
    const cachePath = this.getCachePath(contentHash);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    fs.writeFileSync(cachePath, buffer);
  }

  getMany(contentHashes: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const hash of contentHashes) {
      const embedding = this.get(hash);
      if (embedding) {
        result.set(hash, embedding);
      }
    }
    return result;
  }

  setMany(entries: Map<string, number[]>): void {
    for (const [hash, embedding] of entries) {
      this.set(hash, embedding);
    }
  }
}

/**
 * No-op cache for when caching is disabled
 */
export class NullEmbeddingCache implements EmbeddingCache {
  get(_contentHash: string): number[] | null {
    return null;
  }
  set(_contentHash: string, _embedding: number[]): void {}
  getMany(_contentHashes: string[]): Map<string, number[]> {
    return new Map();
  }
  setMany(_entries: Map<string, number[]>): void {}
}

/**
 * Create an embedding cache
 */
export function createEmbeddingCache(baseDir: string, modelId: string, enabled: boolean = true): EmbeddingCache {
  if (!enabled) {
    return new NullEmbeddingCache();
  }
  return new FileEmbeddingCache(baseDir, modelId);
}
