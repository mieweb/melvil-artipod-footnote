/**
 * docidx - Markdown Content Index Compiler
 * 
 * Produces portable SQLite hybrid index artipods (sqlite-vec + FTS5)
 * from Hugo/markdown content for server-side RAG consumption.
 */
import minimist from 'minimist';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger, format, transports } from 'winston';
import { buildIndex } from '../indexer/build.js';
import { queryIndex } from '../indexer/query.js';
import { 
  autoDetectEmbedder, 
  isOllamaModelInstalled,
  pullOllamaModel,
  OllamaModelNotFoundError,
  getOllamaModelDimension
} from '../embedder/embedder.js';
import { readManifest } from '../storage/manifest.js';
import { loadProjectConfig, resolveContentRoot, DEFAULT_CONFIG } from '../config/index.js';
import type { DocidxConfig } from '../config/schema.js';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.colorize(),
    format.printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [new transports.Console()]
});

/**
 * Auto-detect Hugo project root by looking for content/ directory
 */
function findHugoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  
  // Walk up looking for a directory with content/
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'content'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  
  return null;
}

/**
 * Check if an artipod directory has a complete index (with manifest)
 */
function artipodComplete(artipodDir: string): boolean {
  const manifestPath = path.join(artipodDir, 'manifest.json');
  const indexPath = path.join(artipodDir, 'index.sqlite');
  
  return fs.existsSync(manifestPath) && fs.existsSync(indexPath);
}

/**
 * Check if an artipod directory has a partial index (resumable)
 */
function artipodResumable(artipodDir: string): boolean {
  const indexPath = path.join(artipodDir, 'index.sqlite');
  return fs.existsSync(indexPath);
}

function printUsage(): void {
  console.log(`
docidx - Markdown Content Index Compiler

USAGE:
  docidx <command> [options]

COMMANDS:
  build     Build or update the SQLite hybrid index from markdown content
  query     Run a test query against an existing index

CONFIGURATION:
  docidx looks for a configuration file (docidx.config.js) in the project root.
  This file defines shortcodes, filters, agent prompts, and other settings.

BUILD OPTIONS:
  --root <path>         Project root (auto-detected if not specified)
  --content <path>      Content directory relative to root (default: content)
  --out <path>          Output artipod directory (default: ./artipod)
  --clean               Remove existing index and rebuild from scratch
  --incremental         Only process changed files (auto: incremental if exists, clean if not)
  --include-drafts      Include draft documents (draft: true in front matter)
  --filter <name=value> Content filter (can be specified multiple times)
                        Example: --filter brand=eh
  --embedding-model <model>  Embedding model (auto-detected: Ollama if running, else OpenAI)
                             Use 'ollama:<model>' for specific Ollama model
                             Use 'mock' for testing without embeddings
  --embedding-dim <n>   Embedding dimensions (auto-detected based on model)
  --pull                Automatically pull Ollama model if not installed
  --max-tokens <n>      Max tokens per chunk (default: 500)
  --overlap <n>         Token overlap between chunks (default: 80)
  --compress            Generate artipod.tar.zst after build

QUERY OPTIONS:
  --db <path>           Path to artipod directory (default: ./artipod)
  --hybrid <query>      Query string for hybrid search
  --k <n>               Number of results to return (default: 10)

ENVIRONMENT:
  OPENAI_API_KEY        Required if using OpenAI embeddings (not needed for Ollama)
  LOG_LEVEL             Logging verbosity (debug, info, warn, error)

EXAMPLES:
  # Smart build (auto-detects embedder, root, and mode)
  docidx build

  # Build with content filter
  docidx build --filter brand=eh

  # Use specific Ollama model
  docidx build --embedding-model ollama:nomic-embed-text

  # Full rebuild with OpenAI
  docidx build --clean --embedding-model text-embedding-3-small

  # Test query
  docidx query --hybrid "patient registration" --k 5
`);
}

async function main(): Promise<void> {
  const args = minimist(process.argv.slice(2), {
    string: ['root', 'content', 'out', 'filter', 'embedding-model', 'db', 'hybrid'],
    boolean: ['clean', 'incremental', 'include-drafts', 'compress', 'help', 'version', 'pull'],
    default: {
      content: 'content',
      // embedding-model and embedding-dim intentionally omitted for auto-detection
      'max-tokens': 500,
      overlap: 80,
      k: 10
    },
    alias: {
      h: 'help',
      v: 'version',
      o: 'out',
      r: 'root',
      c: 'content',
      q: 'hybrid',
      f: 'filter'
    }
  });

  if (args.help || args._.length === 0) {
    printUsage();
    process.exit(0);
  }

  if (args.version) {
    console.log('docidx v2.0.0');
    process.exit(0);
  }

  const command = args._[0];

  try {
    switch (command) {
      case 'build': {
        // Load project configuration
        const { config, configPath } = await loadProjectConfig(process.cwd());
        if (configPath) {
          logger.info(`Loaded config from: ${configPath}`);
        }

        // Auto-detect project root if not specified
        let root = args.root;
        if (!root) {
          root = resolveContentRoot(config, process.cwd());
          if (root !== process.cwd()) {
            logger.info(`Auto-detected project root: ${root}`);
          }
        }

        // Parse filters from CLI (--filter brand=eh --filter foo=bar)
        const filters: Record<string, string> = {};
        const filterArgs = args.filter;
        if (filterArgs) {
          const filterList = Array.isArray(filterArgs) ? filterArgs : [filterArgs];
          for (const f of filterList) {
            const [key, value] = f.split('=');
            if (key && value) {
              filters[key] = value;
            }
          }
        }

        // Default output directory
        const out = args.out || path.join(root, 'artipod');

        // Auto-detect clean vs incremental based on artipod existence
        let clean = args.clean;
        const hasCompleteArtipod = artipodComplete(out);
        const hasResumableArtipod = artipodResumable(out);
        
        if (!args.clean && !args.incremental) {
          // Neither explicitly set - auto-detect
          if (hasCompleteArtipod) {
            clean = false;
            logger.info(`Existing index found, using incremental mode`);
          } else if (hasResumableArtipod) {
            clean = false;
            logger.info(`Partial index found, resuming build`);
          } else {
            clean = true;
            logger.info(`No existing index found, building from scratch`);
          }
        }

        // For incremental builds, load settings from existing manifest first
        let embeddingModel = args['embedding-model'];
        let embeddingDim = args['embedding-dim'];
        let existingManifest: ReturnType<typeof readManifest> = null;
        
        if (!clean && hasCompleteArtipod) {
          const manifestPath = path.join(out, 'manifest.json');
          existingManifest = readManifest(manifestPath);
          
          if (existingManifest && !embeddingModel) {
            // Use existing manifest settings
            embeddingModel = existingManifest.embedding.model_id;
            embeddingDim = existingManifest.embedding.dimension;
            logger.info(`Resuming with existing embedder: ${embeddingModel} (${embeddingDim} dim)`);
          }
        }
        
        // Auto-detect embedding model if not specified and no existing manifest
        if (!embeddingModel) {
          const detected = await autoDetectEmbedder(embeddingDim);
          if (detected) {
            embeddingModel = detected.model;
            embeddingDim = detected.dimension;
            if (embeddingModel.startsWith('ollama:')) {
              logger.info(`Auto-detected Ollama: ${embeddingModel} (dim: ${embeddingDim})`);
            } else {
              logger.info(`Using OpenAI: ${embeddingModel} (dim: ${embeddingDim})`);
            }
          } else {
            logger.error('No embedding provider available. Either:');
            logger.error('  - Start Ollama with an embedding model (e.g., ollama pull nomic-embed-text)');
            logger.error('  - Set OPENAI_API_KEY environment variable');
            logger.error('  - Use --embedding-model mock for testing');
            process.exit(1);
          }
        } else if (!embeddingDim) {
          // Model explicitly specified - infer dimension if not provided
          if (embeddingModel === 'mock') {
            embeddingDim = 1536;
          } else if (embeddingModel.startsWith('ollama:')) {
            const modelName = embeddingModel.replace('ollama:', '');
            embeddingDim = getOllamaModelDimension(modelName);
          } else {
            embeddingDim = 1536; // OpenAI default
          }
        }

        // Check for model/dimension mismatch if user explicitly specified a different model
        if (!clean && existingManifest && args['embedding-model']) {
          const existingModel = existingManifest.embedding.model_id;
          const existingDim = existingManifest.embedding.dimension;
          
          if (existingDim !== embeddingDim) {
            logger.error(`Embedding dimension mismatch!`);
            logger.error(`  Existing index: ${existingModel} (${existingDim} dim)`);
            logger.error(`  Requested: ${embeddingModel} (${embeddingDim} dim)`);
            logger.error(`Use --clean to rebuild with the new embedding model.`);
            process.exit(1);
          }
          
          if (existingModel !== embeddingModel) {
            logger.warn(`Embedding model changed: ${existingModel} → ${embeddingModel}`);
            logger.warn(`Dimensions match (${embeddingDim}), but results may be inconsistent.`);
            logger.warn(`Consider using --clean for a full rebuild.`);
          }
        }

        // For Ollama models, check if the model is installed
        if (embeddingModel.startsWith('ollama:')) {
          const modelName = embeddingModel.replace('ollama:', '');
          const isInstalled = await isOllamaModelInstalled(modelName);
          
          if (!isInstalled) {
            if (args.pull) {
              logger.info(`Model '${modelName}' not found. Pulling...`);
              const success = await pullOllamaModel(modelName);
              if (!success) {
                logger.error(`Failed to pull model '${modelName}'`);
                process.exit(1);
              }
            } else {
              logger.error(`Ollama model '${modelName}' is not installed.`);
              logger.error(``);
              logger.error(`To install it, run:`);
              logger.error(`  ollama pull ${modelName}`);
              logger.error(``);
              logger.error(`Or use --pull to download automatically:`);
              logger.error(`  docidx build --embedding-model ${embeddingModel} --pull`);
              process.exit(1);
            }
          }
        }

        logger.info(`Starting index build...`);
        logger.info(`  Root: ${root}`);
        logger.info(`  Content: ${config.content?.dir || args.content}`);
        logger.info(`  Output: ${out}`);
        logger.info(`  Mode: ${clean ? 'clean' : 'incremental'}`);
        if (Object.keys(filters).length > 0) {
          logger.info(`  Filters: ${JSON.stringify(filters)}`);
        }
        logger.info(`  Embedder: ${embeddingModel} (${embeddingDim} dim)`);

        const result = await buildIndex({
          root,
          content: config.content?.dir || args.content,
          out,
          clean,
          includeDrafts: args['include-drafts'],
          filters,
          embeddingModel,
          embeddingDim,
          maxTokens: config.chunking?.maxTokens || args['max-tokens'],
          overlap: config.chunking?.overlap || args.overlap,
          compress: args.compress,
          config
        });

        logger.info(`Build complete!`);
        logger.info(`  Documents: ${result.docCount}`);
        logger.info(`  Chunks: ${result.chunkCount}`);
        logger.info(`  Embeddings: ${result.embeddingsGenerated}`);
        break;
      }

      case 'query': {
        // Default db path
        const dbPath = args.db || './artipod';
        if (!artipodComplete(dbPath)) {
          logger.error(`No complete index found at ${dbPath}. Run 'docidx build' first.`);
          process.exit(1);
        }
        if (!args.hybrid) {
          logger.error('--hybrid <query> is required for query command');
          process.exit(1);
        }

        logger.info(`Querying index at ${dbPath}...`);
        const results = await queryIndex({
          dbPath,
          query: args.hybrid,
          k: args.k,
          embeddingModel: args['embedding-model']
        });

        console.log('\n--- Results ---\n');
        for (const [i, result] of results.entries()) {
          console.log(`${i + 1}. [${result.score.toFixed(4)}] ${result.title}`);
          console.log(`   URL: ${result.url}`);
          console.log(`   Headings: ${result.headings.join(' > ')}`);
          console.log(`   Chunk: ${result.chunk_id}`);
          console.log('');
        }
        break;
      }

      default:
        logger.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    // Handle missing Ollama model with helpful instructions
    if (error instanceof OllamaModelNotFoundError) {
      logger.error(error.message);
      process.exit(1);
    }
    
    logger.error(`Fatal error: ${error instanceof Error ? error.message : error}`);
    if (process.env.LOG_LEVEL === 'debug' && error instanceof Error) {
      logger.error(error.stack || '');
    }
    process.exit(1);
  }
}

main();
