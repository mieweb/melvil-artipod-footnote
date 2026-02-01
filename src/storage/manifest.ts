/**
 * Manifest Generator
 * 
 * Creates manifest.json with build metadata for the artipod.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { AgentConfig as ConfigAgentConfig } from '../config/schema.js';

export interface AgentConfig {
  system_prompt: string;
  model?: string;
  max_iterations?: number;
}

export interface ManifestData {
  schema_version: string;
  project_name?: string;
  build_time_utc: string;
  source_git_commit: string | null;
  content_root: string;
  chunking: {
    max_tokens: number;
    overlap: number;
    strategy: string;
  };
  embedding: {
    model_id: string;
    dimension: number;
    provider: string;
  };
  fts_fields: string[];
  doc_count: number;
  chunk_count: number;
  filters?: Record<string, string>;  // Active filters (e.g., { brand: 'eh' })
  content_copy?: {
    enabled: boolean;
    path: string;  // Relative path within artipod (e.g., 'content')
  };
  agent?: AgentConfig;
}

/**
 * Get current git commit hash if available
 */
function getGitCommit(repoPath: string): string | null {
  try {
    const result = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Generate manifest data
 */
/**
 * Default system prompt - generic documentation assistant
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful documentation assistant.
Your job is to answer questions by searching the documentation.

{{TOOLS}}

IMPORTANT SEARCH STRATEGY:
- For code, special characters, or exact strings (like "ADT^A04"): Use search_literal
- For short keyword queries (1-4 words): Use search_fts - it's more precise
- For longer "how to" or conceptual questions: Use search_hybrid
- When search returns no results, try a different tool or simpler query

CRITICAL:
- For literal searches, use the EXACT code/string, no extra words
- For short technical queries, prefer search_fts over search_hybrid

After gathering enough information, synthesize a clear answer with citations like [1], [2].`;

export function generateManifest(options: {
  projectName?: string;
  contentRoot: string;
  maxTokens: number;
  overlap: number;
  embeddingModel: string;
  embeddingDim: number;
  docCount: number;
  chunkCount: number;
  filters?: Record<string, string>;
  contentCopy?: boolean;  // Whether content files were copied
  systemPrompt?: string;
  agentModel?: string;
  agentMaxIterations?: number;
}): ManifestData {
  return {
    schema_version: '1.1.0',
    project_name: options.projectName,
    build_time_utc: new Date().toISOString(),
    source_git_commit: getGitCommit(options.contentRoot),
    content_root: options.contentRoot,
    chunking: {
      max_tokens: options.maxTokens,
      overlap: options.overlap,
      strategy: 'heading-aware'
    },
    embedding: {
      model_id: options.embeddingModel,
      dimension: options.embeddingDim,
      provider: options.embeddingModel === 'mock' ? 'mock' : 'openai'
    },
    fts_fields: ['title', 'content'],
    doc_count: options.docCount,
    chunk_count: options.chunkCount,
    filters: options.filters,
    content_copy: options.contentCopy ? {
      enabled: true,
      path: 'content'
    } : undefined,
    agent: {
      system_prompt: options.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      model: options.agentModel,
      max_iterations: options.agentMaxIterations
    }
  };
}

/**
 * Write manifest to file
 */
export function writeManifest(manifestPath: string, data: ManifestData): void {
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2));
}

/**
 * Read manifest from file
 */
export function readManifest(manifestPath: string): ManifestData | null {
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as ManifestData;
  } catch {
    return null;
  }
}
