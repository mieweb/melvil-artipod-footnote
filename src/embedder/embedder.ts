/**
 * Embedder Interface and Implementations
 * 
 * Pluggable embedding generation with caching support.
 * Supports OpenAI, Ollama (local), and mock embedders.
 */
import OpenAI from 'openai';

export interface Embedder {
  embed(texts: string[], onProgress?: ProgressCallback): Promise<number[][]>;
  readonly dimension: number;
  readonly modelId: string;
}

export type ProgressCallback = (completed: number, total: number) => void;

export interface EmbedderConfig {
  model: string;
  dimension: number;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
}

/**
 * Error thrown when an Ollama model is not found/installed
 */
export class OllamaModelNotFoundError extends Error {
  public readonly model: string;
  
  constructor(model: string) {
    super(`Ollama model '${model}' is not installed.\n\nTo install it, run:\n  ollama pull ${model}\n\nOr use --pull to download automatically.`);
    this.name = 'OllamaModelNotFoundError';
    this.model = model;
  }
}

/**
 * Check if Ollama is running locally
 */
export async function isOllamaAvailable(baseUrl: string = 'http://localhost:11434'): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get all installed Ollama models
 */
export async function getOllamaModels(baseUrl: string = 'http://localhost:11434'): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];
    
    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = data.models || [];
    return models.map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Get available Ollama embedding models
 */
export async function getOllamaEmbeddingModels(baseUrl: string = 'http://localhost:11434'): Promise<string[]> {
  const models = await getOllamaModels(baseUrl);
  
  // Filter for known embedding models
  const embeddingModelPatterns = ['nomic-embed', 'mxbai-embed', 'all-minilm', 'bge-', 'snowflake-arctic-embed'];
  return models.filter(name => embeddingModelPatterns.some(p => name.toLowerCase().includes(p)));
}

/**
 * Check if a specific Ollama model is installed
 */
export async function isOllamaModelInstalled(model: string, baseUrl: string = 'http://localhost:11434'): Promise<boolean> {
  const models = await getOllamaModels(baseUrl);
  const baseName = model.split(':')[0].toLowerCase();
  return models.some(m => m.toLowerCase().startsWith(baseName));
}

/**
 * Pull an Ollama model (streams progress to console)
 */
export async function pullOllamaModel(model: string, baseUrl: string = 'http://localhost:11434'): Promise<boolean> {
  try {
    console.log(`\nPulling Ollama model: ${model}...`);
    console.log('This may take a few minutes depending on model size.\n');
    
    const response = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model })
    });

    if (!response.ok) {
      console.error(`Failed to pull model: ${response.statusText}`);
      return false;
    }

    // Stream the response to show progress
    const reader = response.body?.getReader();
    if (!reader) return false;

    const decoder = new TextDecoder();
    let lastStatus = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      const lines = text.split('\n').filter(l => l.trim());
      
      for (const line of lines) {
        try {
          const json = JSON.parse(line) as { status?: string; completed?: number; total?: number };
          if (json.status && json.status !== lastStatus) {
            if (json.total && json.completed) {
              const pct = Math.round((json.completed / json.total) * 100);
              process.stdout.write(`\r${json.status}: ${pct}%   `);
            } else {
              console.log(json.status);
            }
            lastStatus = json.status;
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    }
    
    console.log('\nModel pulled successfully!');
    return true;
  } catch (error) {
    console.error(`Error pulling model: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/**
 * Ollama embedder for local embedding generation
 */
export class OllamaEmbedder implements Embedder {
  private baseUrl: string;
  private model: string;
  public readonly dimension: number;
  private batchSize: number;
  private maxChars: number;

  constructor(config: EmbedderConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model;
    this.dimension = config.dimension;
    this.batchSize = config.batchSize || 10; // Ollama is slower, smaller batches
    
    // Get model-specific context limit, default to conservative 512 tokens
    const modelInfo = OLLAMA_EMBEDDING_MODELS[this.model.split(':')[0]];
    const maxTokens = modelInfo?.maxTokens || 512;
    // Estimate ~4 chars per token, with 20% safety margin
    this.maxChars = Math.floor(maxTokens * 4 * 0.8);
  }

  get modelId(): string {
    return `ollama:${this.model}`;
  }

  /**
   * Truncate text to fit within specified character limit
   */
  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
      return text;
    }
    // Truncate at word boundary
    const truncated = text.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated;
  }

  /**
   * Embed a single text with automatic retry on context length errors
   */
  private async embedSingle(text: string, retryCount: number = 0): Promise<number[]> {
    // Progressive truncation: reduce by 50% on each retry
    const effectiveMaxChars = Math.floor(this.maxChars / Math.pow(2, retryCount));
    const truncatedText = this.truncate(text, effectiveMaxChars);
    
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: truncatedText
      })
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new OllamaModelNotFoundError(this.model);
      }
      
      // Try to get error details from response body
      let errorDetail = '';
      try {
        const errorBody = await response.json() as { error?: string };
        errorDetail = errorBody.error || '';
      } catch {
        try {
          errorDetail = await response.text();
        } catch {
          // Ignore read errors
        }
      }
      
      // Check for context length error and retry with smaller text
      const isContextError = errorDetail.toLowerCase().includes('context length') ||
                            errorDetail.toLowerCase().includes('input length') ||
                            errorDetail.toLowerCase().includes('too long');
      
      if (isContextError && retryCount < 4) {
        // Retry with more aggressive truncation
        return this.embedSingle(text, retryCount + 1);
      }
      
      const errorMsg = errorDetail 
        ? `Ollama embedding failed (${response.status}): ${errorDetail}`
        : `Ollama embedding failed: ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  async embed(texts: string[], onProgress?: ProgressCallback): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const allEmbeddings: number[][] = [];
    let completed = 0;

    // Process in batches
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      // Process batch with automatic retry on context errors
      const batchPromises = batch.map(text => this.embedSingle(text));
      const batchEmbeddings = await Promise.all(batchPromises);
      allEmbeddings.push(...batchEmbeddings);
      
      completed += batch.length;
      if (onProgress) {
        onProgress(completed, texts.length);
      }
    }

    return allEmbeddings;
  }
}

/**
 * OpenAI-compatible embedder
 */
export class OpenAIEmbedder implements Embedder {
  private client: OpenAI;
  private model: string;
  public readonly dimension: number;
  private batchSize: number;

  constructor(config: EmbedderConfig) {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl
    });
    this.model = config.model;
    this.dimension = config.dimension;
    this.batchSize = config.batchSize || 100;
  }

  get modelId(): string {
    return this.model;
  }

  async embed(texts: string[], onProgress?: ProgressCallback): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const allEmbeddings: number[][] = [];
    let completed = 0;

    // Process in batches
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimension
      });

      // Sort by index to ensure order matches input
      const sorted = response.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map(d => d.embedding));
      
      completed += batch.length;
      if (onProgress) {
        onProgress(completed, texts.length);
      }
    }

    return allEmbeddings;
  }
}

/**
 * Mock embedder for testing (generates deterministic random vectors)
 */
export class MockEmbedder implements Embedder {
  public readonly dimension: number;
  public readonly modelId: string = 'mock-embedder';
  private batchSize: number;

  constructor(dimension: number = 1536) {
    this.dimension = dimension;
    this.batchSize = 100; // Process in batches for realistic progress reporting
  }

  async embed(texts: string[], onProgress?: ProgressCallback): Promise<number[][]> {
    const results: number[][] = [];
    
    // Process in batches for progress reporting
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      for (const text of batch) {
        // Generate deterministic embedding based on text hash
        const hash = this.simpleHash(text);
        const embedding: number[] = [];
        
        for (let j = 0; j < this.dimension; j++) {
          // Use hash + index to generate pseudo-random value
          const value = Math.sin(hash + j) * 0.5 + 0.5;
          embedding.push(value);
        }
        
        // Normalize
        const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
        results.push(embedding.map(v => v / norm));
      }
      
      // Small delay to simulate real embedding time (makes progress visible)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      if (onProgress) {
        onProgress(Math.min(i + this.batchSize, texts.length), texts.length);
      }
    }
    
    return results;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }
}

// Default Ollama embedding models with their dimensions and context limits
export const OLLAMA_EMBEDDING_MODELS: Record<string, { dimension: number; maxTokens: number }> = {
  'nomic-embed-text': { dimension: 768, maxTokens: 8192 },
  'mxbai-embed-large': { dimension: 1024, maxTokens: 512 },
  'all-minilm': { dimension: 384, maxTokens: 512 },
  'snowflake-arctic-embed': { dimension: 1024, maxTokens: 512 },
  'bge-m3': { dimension: 1024, maxTokens: 8192 },
  'bge-large': { dimension: 1024, maxTokens: 512 },
};

/**
 * Get the embedding dimension for an Ollama model
 */
export function getOllamaModelDimension(modelName: string): number {
  const baseName = modelName.split(':')[0];
  return OLLAMA_EMBEDDING_MODELS[baseName]?.dimension || 768;
}

/**
 * Create embedder based on configuration
 */
export function createEmbedder(config: EmbedderConfig): Embedder {
  if (config.model === 'mock') {
    return new MockEmbedder(config.dimension);
  }
  
  // Check if it's an Ollama model (prefixed with ollama: or in known models)
  if (config.model.startsWith('ollama:')) {
    const ollamaModel = config.model.replace('ollama:', '');
    return new OllamaEmbedder({
      ...config,
      model: ollamaModel,
      dimension: config.dimension || getOllamaModelDimension(ollamaModel)
    });
  }
  
  // Check if model name matches known Ollama embedding models
  const ollamaModelMatch = Object.keys(OLLAMA_EMBEDDING_MODELS).find(m => 
    config.model.toLowerCase().includes(m.toLowerCase())
  );
  if (ollamaModelMatch) {
    return new OllamaEmbedder({
      ...config,
      dimension: config.dimension || getOllamaModelDimension(ollamaModelMatch)
    });
  }
  
  return new OpenAIEmbedder(config);
}

/**
 * Auto-detect best available embedder
 * Priority: Ollama (if available) > OpenAI (if key set) > error
 */
export async function autoDetectEmbedder(preferredDimension?: number): Promise<EmbedderConfig | null> {
  // Check Ollama first
  if (await isOllamaAvailable()) {
    const models = await getOllamaEmbeddingModels();
    if (models.length > 0) {
      // Prefer nomic-embed-text if available, otherwise first model
      const model = models.find(m => m.includes('nomic-embed')) || models[0];
      const dimension = getOllamaModelDimension(model);
      return {
        model: `ollama:${model}`,
        dimension: preferredDimension || dimension
      };
    }
  }
  
  // Check OpenAI
  if (process.env.OPENAI_API_KEY) {
    return {
      model: 'text-embedding-3-small',
      dimension: preferredDimension || 1536
    };
  }
  
  return null;
}
