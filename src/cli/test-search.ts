#!/usr/bin/env npx tsx
/**
 * Interactive Search Test CLI
 * 
 * Allows interactive testing of hybrid search against the index.
 * Usage: npx tsx src/cli/test-search.ts [--db <path>]
 */
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import minimist from 'minimist';

import { createEmbedder, Embedder } from '../embedder/embedder.js';
import { SqliteStore } from '../storage/sqlite.js';
import { readManifest } from '../storage/manifest.js';
import { loadProjectConfig, resolveContentRoot } from '../config/index.js';

type SearchMode = 'hybrid' | 'vector' | 'fts' | 'literal' | 'grep';

/**
 * Run a search query and display results
 */
async function runSearch(
  query: string, 
  mode: SearchMode, 
  embedder: Embedder, 
  store: SqliteStore,
  artipodDir: string
): Promise<void> {
  let results: Array<{
    chunk_id: string;
    doc_id: string;
    url: string;
    title: string;
    headings: string[];
    content: string;
    score: number;
    vectorRank?: number;
    ftsRank?: number;
  }>;
  let embedTime = 0;
  let searchTime = 0;

  if (mode === 'grep') {
    // Grep search on raw files
    const contentDir = path.join(artipodDir, 'content');
    if (!fs.existsSync(contentDir)) {
      console.log('\n❌ Content files not found. Rebuild with --copy-content to enable grep search.\n');
      return;
    }

    const startSearch = performance.now();
    try {
      const escapedQuery = query.replace(/['"\\]/g, '\\$&');
      const grepCmd = `grep -rin --include="*.md" "${escapedQuery}" "${contentDir}" | head -100`;
      const output = execSync(grepCmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      searchTime = Math.round(performance.now() - startSearch);

      // Parse and group by file
      const lines = output.trim().split('\n').filter(l => l.length > 0);
      const fileMatches = new Map<string, { line: number; content: string }[]>();
      
      for (const line of lines) {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (match) {
          const [, filePath, lineNum, content] = match;
          const relPath = filePath.replace(contentDir + '/', '');
          if (!fileMatches.has(relPath)) {
            fileMatches.set(relPath, []);
          }
          fileMatches.get(relPath)!.push({ line: parseInt(lineNum), content: content.trim().slice(0, 200) });
        }
      }

      console.log(`\n📊 Grep: ${lines.length} matches in ${fileMatches.size} files (${searchTime}ms)\n`);

      let rank = 0;
      for (const [relPath, matches] of fileMatches.entries()) {
        if (rank >= 10) break;
        rank++;
        const url = '/' + relPath.replace(/\.md$/, '/').replace(/\/_index\//, '/');
        const title = path.basename(relPath, '.md').replace(/-/g, ' ');
        
        console.log(`${rank}. [${matches.length} matches] ${title}`);
        console.log(`   📁 ${url}`);
        for (const m of matches.slice(0, 3)) {
          console.log(`   L${m.line}: ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`);
        }
        console.log('');
      }
      return;
    } catch (error) {
      searchTime = Math.round(performance.now() - startSearch);
      if ((error as any).status === 1) {
        console.log(`\n📊 Grep: 0 matches (${searchTime}ms)\n`);
        console.log('   No results found.\n');
        return;
      }
      throw error;
    }
  } else if (mode === 'literal') {
    // Literal substring search - finds exact characters like ^ | etc.
    const startSearch = Date.now();
    const literalResults = store.literalSearch(query, 10);
    searchTime = Date.now() - startSearch;
    results = literalResults.map((r, i) => ({
      ...r,
      score: r.matchCount,
      ftsRank: i + 1
    }));
  } else if (mode === 'fts') {
    // FTS only - no embedding needed
    const startSearch = Date.now();
    const ftsResults = store.ftsSearch(query, 10);
    searchTime = Date.now() - startSearch;
    results = ftsResults.map((r, i) => ({
      ...r,
      score: -r.bm25Score, // BM25 is negative (lower = better), flip for display
      ftsRank: i + 1
    }));
  } else if (mode === 'vector') {
    // Vector only
    const startEmbed = Date.now();
    const [queryVector] = await embedder.embed([query]);
    embedTime = Date.now() - startEmbed;

    const startSearch = Date.now();
    const vecResults = store.vectorSearch(queryVector, 10);
    searchTime = Date.now() - startSearch;
    results = vecResults.map((r, i) => ({
      ...r,
      score: 1 - r.distance, // Convert distance to similarity
      vectorRank: i + 1
    }));
  } else {
    // Hybrid (default)
    const startEmbed = Date.now();
    const [queryVector] = await embedder.embed([query]);
    embedTime = Date.now() - startEmbed;

    const startSearch = Date.now();
    results = store.hybridSearch(queryVector, query, 10);
    searchTime = Date.now() - startSearch;
  }

  // Display results
  const timing = mode === 'fts' 
    ? `search: ${searchTime}ms`
    : `embed: ${embedTime}ms, search: ${searchTime}ms`;
  console.log(`\n📊 Found ${results.length} results (${timing})\n`);

  if (results.length === 0) {
    console.log('   No results found.\n');
  } else {
    for (const [i, result] of results.entries()) {
      const rank = i + 1;
      const score = result.score.toFixed(4);
      const vRank = result.vectorRank ? `V${result.vectorRank}` : '-';
      const fRank = result.ftsRank ? `F${result.ftsRank}` : '-';
      
      console.log(`${rank}. [${score}] ${result.title}`);
      console.log(`   📁 ${result.url}`);
      
      if (result.headings.length > 0) {
        console.log(`   📑 ${result.headings.join(' > ')}`);
      }
      
      console.log(`   🏷️  Ranks: ${vRank} / ${fRank}`);
      
      // Show snippet with search term highlighted (if found)
      let snippet = result.content
        .replace(/\n+/g, ' ')
        .slice(0, 200)
        .trim();
      
      // Try to find and center the snippet around the query terms
      const queryLower = query.toLowerCase();
      const contentLower = result.content.toLowerCase();
      const matchIdx = contentLower.indexOf(queryLower.replace(/[^a-z0-9]/gi, '').slice(0, 10));
      if (matchIdx > 50) {
        const start = Math.max(0, matchIdx - 50);
        snippet = '...' + result.content.slice(start, start + 200).replace(/\n+/g, ' ').trim();
      }
      
      console.log(`   💬 "${snippet}${result.content.length > 200 ? '...' : ''}"`);
      console.log('');
    }
  }
}

const args = minimist(process.argv.slice(2), {
  string: ['db', 'mode', 'query', 'q'],
  default: {
    db: '',  // Empty = auto-detect
    mode: 'hybrid'  // hybrid, vector, fts, literal, grep
  }
});

// Get query from args (--query or --q or positional)
const cliQuery = args.query || args.q || args._[0] || null;

async function main(): Promise<void> {
  // Auto-detect artipod directory from project config if not specified
  let artipodDir = args.db;
  if (!artipodDir) {
    const { config } = await loadProjectConfig(process.cwd());
    const projectRoot = resolveContentRoot(config, process.cwd());
    artipodDir = path.join(projectRoot, 'artipod');
    
    // Fallback to current directory
    if (!fs.existsSync(artipodDir)) {
      artipodDir = './artipod';
    }
  }
  
  artipodDir = path.resolve(artipodDir);
  const indexPath = path.join(artipodDir, 'index.sqlite');
  const manifestPath = path.join(artipodDir, 'manifest.json');

  // Validate paths
  if (!fs.existsSync(indexPath)) {
    console.error(`❌ Index not found: ${indexPath}`);
    console.error(`   Run 'docidx build' first to create an index.`);
    process.exit(1);
  }

  // Read manifest
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    console.error(`❌ Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  // Determine embedding model
  let embeddingModel = manifest.embedding.model_id;
  if (manifest.embedding.provider === 'mock') {
    embeddingModel = 'mock';
  }
  const embeddingDim = manifest.embedding.dimension;
  const mode = args.mode as SearchMode;

  if (!['hybrid', 'vector', 'fts', 'literal', 'grep'].includes(mode)) {
    console.error(`❌ Invalid mode: ${mode}. Use: hybrid, vector, fts, literal, or grep`);
    process.exit(1);
  }

  // Initialize components
  const embedder = createEmbedder({
    model: embeddingModel,
    dimension: embeddingDim
  });

  const store = new SqliteStore({
    dbPath: indexPath,
    dimension: embeddingDim
  });

  store.init(false);

  // If query provided on command line, run once and exit
  if (cliQuery) {
    console.log(`\n🔍 Search: "${cliQuery}" (mode: ${mode.toUpperCase()})`);
    await runSearch(cliQuery, mode, embedder, store, artipodDir);
    store.close();
    process.exit(0);
  }

  // Interactive mode
  console.log(`\n🔍 Interactive Search Test`);
  console.log(`   Index: ${indexPath}`);
  console.log(`   Mode: ${mode.toUpperCase()}`);
  
  // Check if grep is available
  const contentDir = path.join(artipodDir, 'content');
  if (fs.existsSync(contentDir)) {
    console.log(`   Grep: available (${contentDir})`);
  }
  console.log(`   Embedder: ${embeddingModel} (${embeddingDim} dim)`);
  console.log(`   Docs: ${manifest.doc_count}, Chunks: ${manifest.chunk_count}`);
  console.log(`\n   Type a query and press Enter. Type 'quit' or Ctrl+C to exit.`);
  console.log(`   Tip: For FTS, use "quoted phrases" for exact match.\n`);

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = (): void => {
    rl.question('🔎 Search: ', async (query) => {
      query = query.trim();

      if (query.toLowerCase() === 'quit' || query.toLowerCase() === 'exit') {
        console.log('\nGoodbye! 👋\n');
        store.close();
        rl.close();
        process.exit(0);
      }

      if (!query) {
        prompt();
        return;
      }

      try {
        await runSearch(query, mode, embedder, store, artipodDir);
        console.log('─'.repeat(60) + '\n');
      } catch (error) {
        console.error(`\n❌ Search error: ${error instanceof Error ? error.message : error}\n`);
      }

      prompt();
    });
  };

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    store.close();
    process.exit(0);
  });

  prompt();
}

main().catch(error => {
  console.error(`Fatal error: ${error}`);
  process.exit(1);
});
