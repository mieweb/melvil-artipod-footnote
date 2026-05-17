/**
 * Configuration Schema
 * 
 * Defines the structure for docidx.config.js files that customize
 * the indexer for specific documentation projects.
 */

/**
 * Shortcode transform rule
 */
export interface ShortcodeRule {
  /** Extract inner content from block shortcodes */
  extractContent?: boolean;
  /** Replace with static text */
  replacement?: string;
  /** Skip entirely (don't include in output) */
  skip?: boolean;
  /** Custom handler function (for complex logic) */
  handler?: (content: string, args: string, context: TransformContext) => string;
}

/**
 * Context passed to transform handlers
 */
export interface TransformContext {
  /** Front matter from the document */
  frontMatter: Record<string, unknown>;
  /** File path relative to content root */
  filePath: string;
  /** Active filter values (e.g., { brand: 'eh' }) */
  filters: Record<string, string>;
}

/**
 * Content filter configuration
 */
export interface FilterConfig {
  /** Front matter field to filter on */
  field: string;
  /** Values to include (if specified, others are excluded) */
  include?: string[];
  /** Values to exclude */
  exclude?: string[];
  /** Default value if field is missing */
  default?: string;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** System prompt template (use {{TOOLS}} placeholder for tool definitions) */
  systemPrompt?: string;
  /** Default LLM model */
  model?: string;
  /** Max agent iterations */
  maxIterations?: number;
}

/**
 * Full project configuration
 */
export interface DocidxConfig {
  /** Project name (used in manifest) */
  name?: string;
  
  /** Base URL for document links (e.g., 'https://docs.enterprisehealth.com/') */
  baseUrl?: string;
  
  /** Content source configuration */
  content?: {
    /** Root directory (default: auto-detect) */
    root?: string;
    /** Content subdirectory (default: '.' i.e. the root itself) */
    dir?: string;
    /** File patterns to include */
    include?: string[];
    /** File patterns to exclude */
    exclude?: string[];
  };

  /** Shortcode transform rules */
  shortcodes?: Record<string, ShortcodeRule>;

  /** Text substitutions (simple find/replace) */
  substitutions?: Record<string, string>;

  /** Content filters */
  filters?: FilterConfig[];

  /** Embedding configuration */
  embedding?: {
    /** Model to use (e.g., 'ollama:nomic-embed-text') */
    model?: string;
    /** Embedding dimensions (auto-detected if not specified) */
    dimension?: number;
  };

  /** Chunking configuration */
  chunking?: {
    /** Max tokens per chunk */
    maxTokens?: number;
    /** Token overlap between chunks */
    overlap?: number;
  };

  /** Agent configuration */
  agent?: AgentConfig;
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: DocidxConfig = {
  content: {
    dir: '.',
    include: ['**/*.md'],
    exclude: ['**/node_modules/**']
  },
  shortcodes: {
    // Common shortcodes
    'info': { extractContent: true },
    'note': { extractContent: true },
    'tip': { extractContent: true },
    'warning': { extractContent: true },
    'panel': { extractContent: true },
    'section': { extractContent: true },
    'column': { extractContent: true },
    'columns': { extractContent: true },
    'pre': { extractContent: true },
    'glow': { extractContent: true },
    
    // Navigation shortcodes - skip
    'children': { skip: true },
    'toc': { skip: true },
    'anchor': { skip: true },
    
    // Media shortcodes - skip
    'youtube': { skip: true },
    'vimeo': { skip: true },
    'drawio': { skip: true }
  },
  chunking: {
    maxTokens: 500,
    overlap: 80
  },
  agent: {
    model: 'llama3.2',
    maxIterations: 5
  }
};

/**
 * Merge user config with defaults
 */
export function mergeConfig(userConfig: Partial<DocidxConfig>): DocidxConfig {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    content: {
      ...DEFAULT_CONFIG.content,
      ...userConfig.content
    },
    shortcodes: {
      ...DEFAULT_CONFIG.shortcodes,
      ...userConfig.shortcodes
    },
    chunking: {
      ...DEFAULT_CONFIG.chunking,
      ...userConfig.chunking
    },
    agent: {
      ...DEFAULT_CONFIG.agent,
      ...userConfig.agent
    }
  };
}
