#!/usr/bin/env npx tsx
/**
 * MCP Server for Artipod Documentation Search
 *
 * Exposes artipod search capabilities as MCP tools so AI assistants
 * (VS Code Copilot, Claude Desktop, etc.) can query documentation indexes.
 *
 * Usage:
 *   npx tsx src/cli/mcp.ts --db ./artipod
 *   docidx mcp --db ./artipod
 */
import * as path from 'path';
import * as fs from 'fs';
import { execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import minimist from 'minimist';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createEmbedder, type Embedder } from '../embedder/embedder.js';
import { SqliteStore } from '../storage/sqlite.js';
import { readManifest, type ManifestData } from '../storage/manifest.js';

const args = minimist(process.argv.slice(2), {
  string: ['db'],
  default: {
    db: './artipod'
  }
});

interface ChunkResult {
  title?: string;
  url?: string;
  doc_id?: string;
  headings?: string[];
  content?: string;
  score?: number;
}

/**
 * Resolve how to invoke the docidx CLI as a subprocess, without relying on
 * a shell, npx, or PATH.  Works whether we're running from source (tsx) or
 * from a compiled npm install (dist/).
 *
 * Returns [executable, ...prefixArgs] suitable for execFileSync().
 */
function resolveDocidxCommand(): string[] {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  // 1. Compiled dist — bin/docidx.js (plain Node, no tsx needed)
  const binScript = path.resolve(thisDir, '../../bin/docidx.js');
  if (fs.existsSync(binScript)) {
    return [process.execPath, binScript];
  }

  // 2. Source — run main.ts via the current Node binary + tsx loader
  const srcScript = path.resolve(thisDir, 'main.ts');
  if (fs.existsSync(srcScript)) {
    return [process.execPath, '--import', 'tsx', srcScript];
  }

  // 3. Fallback — hope 'docidx' is on PATH (installed globally)
  return [process.execPath, '-e', `require('child_process').execFileSync('docidx',process.argv.slice(1),{stdio:'inherit'})`];
}

/**
 * Format chunk results for MCP tool responses
 */
function formatChunkResults(results: ChunkResult[], baseUrl?: string): string {
  if (results.length === 0) return 'No results found.';

  return results.map((r, i) => {
    const url = baseUrl && r.url ? `${baseUrl}${String(r.url).replace(/^\//, '')}` : r.url;
    const headings = Array.isArray(r.headings) ? r.headings.join(' > ') : '';
    const score = typeof r.score === 'number' ? ` (score: ${r.score.toFixed(4)})` : '';
    const content = typeof r.content === 'string' ? r.content : '';

    return [
      `--- Result ${i + 1}${score} ---`,
      `Title: ${r.title || 'Untitled'}`,
      headings ? `Section: ${headings}` : null,
      `URL: ${url}`,
      `Doc ID: ${r.doc_id}`,
      ``,
      content
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

async function main(): Promise<void> {
  const artipodDir = path.resolve(args.db);
  await startMcpServer(artipodDir);
}

/**
 * Start the MCP server for the given artipod directory.
 * Can be called from main.ts or run standalone.
 */
export async function startMcpServer(dbPath: string): Promise<void> {
  const server = await createMcpServer(dbPath);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Create and configure the MCP server (without connecting transport).
 * Exported for testing with InMemoryTransport.
 */
export async function createMcpServer(dbPath: string): Promise<McpServer> {
  const artipodDir = path.resolve(dbPath);
  const indexPath = path.join(artipodDir, 'index.sqlite');
  const manifestPath = path.join(artipodDir, 'manifest.json');

  // Validate artipod exists
  if (!fs.existsSync(indexPath)) {
    process.stderr.write(`Error: Index not found at ${indexPath}\n`);
    process.stderr.write(`Run 'docidx build' first to create an artipod.\n`);
    process.exit(1);
  }

  // Read manifest
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    process.stderr.write(`Error: Manifest not found at ${manifestPath}\n`);
    process.exit(1);
  }

  // Initialize embedder for vector search
  let embedder: Embedder | null = null;
  try {
    const embeddingModel = manifest.embedding.provider === 'mock'
      ? 'mock'
      : manifest.embedding.model_id;

    embedder = createEmbedder({
      model: embeddingModel,
      dimension: manifest.embedding.dimension
    });
  } catch (err) {
    process.stderr.write(`Warning: Could not initialize embedder (${err}). Hybrid/vector search will be unavailable.\n`);
  }

  // Initialize store
  const store = new SqliteStore({
    dbPath: indexPath,
    dimension: manifest.embedding.dimension
  });
  store.init(false);

  const baseUrl = manifest.base_url;
  const projectName = manifest.project_name || 'Documentation';

  // Check if content copy exists for grep
  const contentCopyDir = manifest.content_copy?.enabled
    ? path.join(artipodDir, manifest.content_copy.path)
    : null;
  const hasGrepSupport = contentCopyDir && fs.existsSync(contentCopyDir);

  // Create MCP server
  const server = new McpServer({
    name: `docidx-${projectName.toLowerCase().replace(/\s+/g, '-')}`,
    version: '2.0.0'
  });

  // === Resources ===

  server.resource(
    'manifest',
    'artipod://manifest',
    { description: `Build manifest for the ${projectName} artipod` },
    async () => ({
      contents: [{
        uri: 'artipod://manifest',
        mimeType: 'application/json',
        text: JSON.stringify(manifest, null, 2)
      }]
    })
  );

  // === Tools ===

  // 1. search_hybrid — combined vector + FTS search
  if (embedder) {
    const capturedEmbedder = embedder;
    server.tool(
      'search_hybrid',
      'Search documentation using combined semantic vector search and BM25 full-text search with Reciprocal Rank Fusion. Best for general questions and longer queries.',
      {
        query: z.string().describe('The search query'),
        k: z.number().int().min(1).max(50).default(10).describe('Number of results to return')
      },
      async ({ query, k }) => {
        try {
          const [queryVector] = await capturedEmbedder.embed([query]);
          const results = store.hybridSearch(queryVector, query, k);
          return {
            content: [{
              type: 'text' as const,
              text: formatChunkResults(results, baseUrl)
            }]
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Hybrid search failed: ${err}` }],
            isError: true
          };
        }
      }
    );
  }

  // 2. search_fts — BM25 full-text search
  server.tool(
    'search_fts',
    'Search documentation using BM25 full-text keyword search. Best for short keyword queries (1-4 words) and specific terms.',
    {
      query: z.string().describe('The search query (keywords)'),
      k: z.number().int().min(1).max(50).default(10).describe('Number of results to return')
    },
    async ({ query, k }) => {
      const results = store.ftsSearch(query, k);
      return {
        content: [{
          type: 'text' as const,
          text: formatChunkResults(results, baseUrl)
        }]
      };
    }
  );

  // 3. search_literal — exact substring match
  server.tool(
    'search_literal',
    'Search documentation for exact substring matches. Best for code snippets, special characters (like "ADT^A04"), and exact strings.',
    {
      query: z.string().describe('The exact string to search for'),
      k: z.number().int().min(1).max(50).default(10).describe('Number of results to return')
    },
    async ({ query, k }) => {
      const results = store.literalSearch(query, k);
      return {
        content: [{
          type: 'text' as const,
          text: formatChunkResults(results, baseUrl)
        }]
      };
    }
  );

  // 4. read_document — get all chunks for a document
  server.tool(
    'read_document',
    'Read the full content of a specific document by its doc_id or URL. Returns all chunks in order.',
    {
      doc_id: z.string().describe('Document ID or URL to read')
    },
    async ({ doc_id }) => {
      const chunks = store.getDocumentChunks(doc_id);
      if (chunks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No document found matching: ${doc_id}` }],
          isError: true
        };
      }

      const url = baseUrl && chunks[0].url ? `${baseUrl}${chunks[0].url.replace(/^\//, '')}` : chunks[0].url;
      const header = `# ${chunks[0].title}\nURL: ${url}\nChunks: ${chunks.length}\n\n`;
      const body = chunks.map(c => c.content).join('\n\n---\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: header + body
        }]
      };
    }
  );

  // 5. find_related — find documents that link to a given document
  server.tool(
    'find_related',
    'Find documents that reference or link to a given document path. Useful for discovering related content.',
    {
      path: z.string().describe('Document path to find references to'),
      limit: z.number().int().min(1).max(20).default(5).describe('Maximum number of related documents')
    },
    async ({ path: docPath, limit }) => {
      const related = store.findRelatedDocuments(docPath, limit);
      if (related.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No documents found linking to: ${docPath}` }]
        };
      }

      const text = related.map((r, i) => {
        const url = baseUrl && r.url ? `${baseUrl}${r.url.replace(/^\//, '')}` : r.url;
        return `${i + 1}. ${r.title}\n   URL: ${url}\n   Doc ID: ${r.doc_id}`;
      }).join('\n');

      return {
        content: [{ type: 'text' as const, text: text }]
      };
    }
  );

  // 6. list_documents — list all indexed documents
  server.tool(
    'list_documents',
    `List all indexed documents in the ${projectName} documentation set. Returns title, URL, and chunk count for each document.`,
    {},
    async () => {
      const docs = store.listDocuments();
      const text = docs.map(d => {
        const url = baseUrl && d.url ? `${baseUrl}${d.url.replace(/^\//, '')}` : d.url;
        return `${d.title} (${d.chunk_count} chunks)\n  URL: ${url}`;
      }).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: `${docs.length} documents indexed:\n\n${text}`
        }]
      };
    }
  );

  // 7. search_grep — grep content files (only if content copy exists)
  if (hasGrepSupport && contentCopyDir) {
    const grepDir = contentCopyDir;
    server.tool(
      'search_grep',
      'Search documentation content files using grep. Supports regex patterns. Only available when content files are copied to the artipod.',
      {
        pattern: z.string().describe('Grep pattern (supports basic regex)'),
        max_results: z.number().int().min(1).max(50).default(20).describe('Maximum number of matching lines')
      },
      async ({ pattern, max_results }) => {
        try {
          const result = execSync(
            `grep -rn --include='*.md' -m ${max_results} ${JSON.stringify(pattern)} ${JSON.stringify(grepDir)}`,
            { encoding: 'utf-8', timeout: 10000 }
          ).trim();

          if (!result) {
            return {
              content: [{ type: 'text' as const, text: 'No grep matches found.' }]
            };
          }

          // Strip the artipod content prefix from paths for readability
          const cleaned = result.replace(new RegExp(grepDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'g'), '');

          return {
            content: [{ type: 'text' as const, text: cleaned }]
          };
        } catch (err: unknown) {
          // grep returns exit code 1 when no matches found
          if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
            return {
              content: [{ type: 'text' as const, text: 'No grep matches found.' }]
            };
          }
          return {
            content: [{ type: 'text' as const, text: `Grep failed: ${err}` }],
            isError: true
          };
        }
      }
    );
  }

  // 8. build_index — incremental build (update changed files)
  const docidxCmd = resolveDocidxCommand();

  server.tool(
    'build_index',
    'Incrementally update the documentation index. Only processes files that changed since the last build. Safe to run frequently.',
    {
      root: z.string().optional().describe('Project root directory (auto-detected if not specified)'),
      copy_content: z.boolean().default(false).describe('Copy markdown files to artipod for grep search')
    },
    async ({ root, copy_content }) => {
      try {
        const buildArgs = ['build', '--out', artipodDir];
        if (root) buildArgs.push('--root', root);
        if (copy_content) buildArgs.push('--copy-content');

        const result = execFileSync(docidxCmd[0], [...docidxCmd.slice(1), ...buildArgs], {
          encoding: 'utf-8',
          timeout: 300000,
          cwd: root || process.cwd()
        });

        return {
          content: [{ type: 'text' as const, text: result.trim() || 'Build completed successfully.' }]
        };
      } catch (err: unknown) {
        const msg = err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr: string }).stderr)
          : String(err);
        return {
          content: [{ type: 'text' as const, text: `Build failed:\n${msg}` }],
          isError: true
        };
      }
    }
  );

  // 9. rebuild_index — clean rebuild from scratch
  server.tool(
    'rebuild_index',
    'Completely rebuild the documentation index from scratch. Use when the index is corrupted or the embedding model changed. This is slower than build_index.',
    {
      root: z.string().optional().describe('Project root directory (auto-detected if not specified)'),
      copy_content: z.boolean().default(false).describe('Copy markdown files to artipod for grep search')
    },
    async ({ root, copy_content }) => {
      try {
        const buildArgs = ['build', '--clean', '--out', artipodDir];
        if (root) buildArgs.push('--root', root);
        if (copy_content) buildArgs.push('--copy-content');

        const result = execFileSync(docidxCmd[0], [...docidxCmd.slice(1), ...buildArgs], {
          encoding: 'utf-8',
          timeout: 600000,
          cwd: root || process.cwd()
        });

        return {
          content: [{ type: 'text' as const, text: result.trim() || 'Rebuild completed successfully.' }]
        };
      } catch (err: unknown) {
        const msg = err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr: string }).stderr)
          : String(err);
        return {
          content: [{ type: 'text' as const, text: `Rebuild failed:\n${msg}` }],
          isError: true
        };
      }
    }
  );

  process.stderr.write(`MCP server configured for ${projectName} (${manifest.doc_count} docs, ${manifest.chunk_count} chunks)\n`);
  if (!embedder) {
    process.stderr.write(`Warning: Embedder unavailable — search_hybrid tool is disabled\n`);
  }
  if (hasGrepSupport) {
    process.stderr.write(`Grep search enabled (content copy found)\n`);
  }

  return server;
}

// Only run main() when executed directly (not when imported)
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\.(ts|js)$/, '') ===
  path.resolve(fileURLToPath(import.meta.url)).replace(/\.(ts|js)$/, '');

if (isDirectRun) {
  main().catch(err => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
