/**
 * docidx - Markdown Content Index Compiler
 * 
 * Produces portable SQLite hybrid footnote indexes (sqlite-vec + FTS5)
 * from markdown content for server-side RAG consumption.
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
 * Check if a footnote index directory has a complete index (with manifest)
 */
function indexComplete(footnoteDir: string): boolean {
  const manifestPath = path.join(footnoteDir, 'manifest.json');
  const indexPath = path.join(footnoteDir, 'index.sqlite');
  
  return fs.existsSync(manifestPath) && fs.existsSync(indexPath);
}

/**
 * Check if a footnote index directory has a partial index (resumable)
 */
function indexResumable(footnoteDir: string): boolean {
  const indexPath = path.join(footnoteDir, 'index.sqlite');
  return fs.existsSync(indexPath);
}

function printUsage(): void {
  console.log(`
docidx - Markdown Content Index Compiler

USAGE:
  docidx <command> [options]

COMMANDS:
  build     Build or update the SQLite hybrid index from markdown content
  ask       Ask Melvil a question (agentic RAG assistant with citations)
  query     Run a test query against an existing index
  mcp       Start an MCP (Model Context Protocol) server for AI assistants

CONFIGURATION:
  docidx looks for a configuration file (docidx.config.js) in the project root.
  This file defines shortcodes, filters, agent prompts, and other settings.

BUILD OPTIONS:
  --root <path>         Project root (default: current directory)
  --content <path>      Content directory relative to root (default: . i.e. root itself)
  --out <path>          Output directory (default: ./.footnote)
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
  --compress            Generate .footnote.tar.zst after build
  --copy-content        Copy markdown files to footnote index for grep-based search

QUERY OPTIONS:
  --db <path>           Path to index directory (default: ./.footnote)
  --hybrid <query>      Query string for hybrid search
  --k <n>               Number of results to return (default: 10)

ASK OPTIONS:
  --db <path>           Path to index directory (default: ./.footnote)
  --serve               Start HTTP web UI instead of single-question mode
  --port <n>            Port for web server (default: 3000)
  -v, --verbose         Show tool calls and reasoning steps
  -c, --content         Show full chunk content in answers

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

  # Start MCP server for AI assistants
  docidx mcp --db ./.footnote

  # Ask Melvil a question (CLI)
  docidx ask "How do I schedule an appointment?"

  # Start Melvil web UI
  docidx ask --serve --port 3000
`);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const cliProvidedContent = rawArgv.includes('--content') || rawArgv.includes('-c');

  const args = minimist(rawArgv, {
    string: ['root', 'content', 'out', 'filter', 'embedding-model', 'db', 'hybrid'],
    boolean: ['clean', 'incremental', 'include-drafts', 'compress', 'help', 'version', 'pull', 'copy-content'],
    default: {
      content: '.',
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

        // Resolve content directory with explicit CLI flags taking precedence.
        const contentDir = cliProvidedContent
          ? args.content
          : (config.content?.dir || DEFAULT_CONFIG.content?.dir || args.content);

        // Use configured root, or default to CWD.
        let root = args.root || resolveContentRoot(config, process.cwd());

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
        const out = args.out || path.join(root, '.footnote');

        // Auto-detect clean vs incremental based on index existence
        let clean = args.clean;
        const hasCompleteIndex = indexComplete(out);
        const hasResumableIndex = indexResumable(out);
        
        if (!args.clean && !args.incremental) {
          // Neither explicitly set - auto-detect
          if (hasCompleteIndex) {
            clean = false;
            logger.info(`Existing index found, using incremental mode`);
          } else if (hasResumableIndex) {
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
        
        if (!clean && hasCompleteIndex) {
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
        logger.info(`  Content: ${contentDir}`);
        logger.info(`  Output: ${out}`);
        logger.info(`  Mode: ${clean ? 'clean' : 'incremental'}`);
        if (Object.keys(filters).length > 0) {
          logger.info(`  Filters: ${JSON.stringify(filters)}`);
        }
        logger.info(`  Embedder: ${embeddingModel} (${embeddingDim} dim)`);
        if (args['copy-content']) {
          logger.info(`  Copy content: enabled (for grep search)`);
        }

        const result = await buildIndex({
          root,
          content: contentDir,
          out,
          clean,
          includeDrafts: args['include-drafts'],
          filters,
          embeddingModel,
          embeddingDim,
          maxTokens: config.chunking?.maxTokens || args['max-tokens'],
          overlap: config.chunking?.overlap || args.overlap,
          compress: args.compress,
          copyContent: args['copy-content'],
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
        const dbPath = args.db || './.footnote';
        if (!indexComplete(dbPath)) {
          logger.error(`No complete index found at ${dbPath}. Run 'docidx build' first.`);
          process.exit(1);
        }
        if (!args.hybrid) {
          logger.error('--hybrid <query> is required for query command');
          process.exit(1);
        }

        logger.info(`Querying index at ${dbPath}...`);
        // --exclude-denied drops results a note explicitly denies (assertion=absent).
        const excludeAssertions = args['exclude-denied'] ? ['absent'] : undefined;
        const results = await queryIndex({
          dbPath,
          query: args.hybrid,
          k: args.k,
          embeddingModel: args['embedding-model'],
          excludeAssertions
        });

        console.log('\n--- Results ---\n');
        if (excludeAssertions) {
          console.log('(filtering out findings the note denies: assertion=absent)\n');
        }
        for (const [i, result] of results.entries()) {
          const a = (result.assertion || 'unspecified').toLowerCase();
          const tag = a !== 'unspecified' ? `  [assertion: ${a.toUpperCase()}]` : '';
          console.log(`${i + 1}. [${result.score.toFixed(4)}] ${result.title}${tag}`);
          console.log(`   URL: ${result.url}`);
          console.log(`   Headings: ${result.headings.join(' > ')}`);
          // Per-finding assertions (Phase 2): each clinical finding tagged from the prose.
          const findings = JSON.parse(result.findings || '[]') as Array<{ finding: string; assertion: string; temporality?: string; evidence: string }>;
          if (findings.length > 0) {
            console.log(`   Per-finding:`);
            for (const f of findings) {
              const ev = f.evidence === 'stated' ? 'no negation cue → present'
                : f.evidence === 'heading' ? 'from the section heading'
                : `cue: "${f.evidence}"`;
              // Temporality is a separate axis; only surface it when it's not the default 'recent'.
              const when = f.temporality && f.temporality !== 'recent' ? ` [${f.temporality}]` : '';
              console.log(`     • ${f.finding} → ${f.assertion.toUpperCase()}${when}  (${ev})`);
            }
          }
          console.log('');
        }
        break;
      }

      case 'ask': {
        // ask.ts parses process.argv directly — remove the 'ask' subcommand token
        // so it sees the same argv as if invoked standalone.
        const askIdx = process.argv.indexOf('ask');
        if (askIdx !== -1) process.argv.splice(askIdx, 1);
        await import('./ask.js');
        break;
      }

      case 'mcp': {
        // MCP server is a separate entry point — import and run it
        const { startMcpServer } = await import('./mcp.js');
        await startMcpServer(args.db || './.footnote');
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
