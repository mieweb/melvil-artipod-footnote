#!/usr/bin/env npx tsx
/**
 * Ask Agent CLI & Server
 * 
 * An agentic RAG assistant that can use tools to search documentation.
 * The LLM decides which search strategies to use based on the question.
 * 
 * Usage: 
 *   npx tsx src/cli/ask.ts "your question here"
 *   npx tsx src/cli/ask.ts --serve --port 3000
 */
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import * as http from 'http';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import minimist from 'minimist';
import { marked } from 'marked';
import yaml from 'js-yaml';
import OpenAI from 'openai';

import { createEmbedder, Embedder } from '../embedder/embedder.js';
import { SqliteStore } from '../storage/sqlite.js';
import { readManifest, DEFAULT_SYSTEM_PROMPT, ManifestData } from '../storage/manifest.js';
import { loadProjectConfig, resolveContentRoot } from '../config/index.js';

const args = minimist(process.argv.slice(2), {
  string: ['db', 'model', 'port', 'examples', 'host'],
  boolean: ['verbose', 'interactive', 'chunks', 'serve'],
  alias: { v: 'verbose', i: 'interactive', c: 'chunks', s: 'serve', p: 'port' },
  default: {
    db: '',  // Empty = auto-detect from project root
    model: '',  // Empty = use manifest default or fallback
    examples: '',  // Optional HTML file served at /example (suggested questions)
    verbose: false,
    interactive: false,
    chunks: false,  // Show full chunk content
    serve: false,
    port: '3000',
    host: '127.0.0.1'  // Bind to localhost by default; override with --host 0.0.0.0
  }
});

const cliQuery = args._[0] || null;

// Debug file cleanup configuration
const DEBUG_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEBUG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

/**
 * Clean up old debug files to prevent unbounded growth.
 * Deletes files older than DEBUG_MAX_AGE_MS (1 week).
 */
function cleanupDebugFiles(debugDir: string, verbose: boolean = false): void {
  if (!fs.existsSync(debugDir)) return;
  
  const now = Date.now();
  let deletedCount = 0;
  
  try {
    const files = fs.readdirSync(debugDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      // Skip reported files - they are preserved indefinitely
      if (file.startsWith('reported-')) continue;
      
      const filepath = path.join(debugDir, file);
      const stat = fs.statSync(filepath);
      const age = now - stat.mtimeMs;
      
      if (age > DEBUG_MAX_AGE_MS) {
        fs.unlinkSync(filepath);
        deletedCount++;
      }
    }
    
    if (verbose && deletedCount > 0) {
      console.log(`[${new Date().toISOString()}] 🧹 Cleaned up ${deletedCount} debug file(s) older than 1 week`);
    }
  } catch (err) {
    // Ignore cleanup errors - non-critical
    if (verbose) {
      console.error(`[${new Date().toISOString()}] ⚠️ Debug cleanup error:`, err);
    }
  }
}

/**
 * Start periodic debug file cleanup timer
 */
function startDebugCleanupTimer(debugDir: string, verbose: boolean = false): NodeJS.Timeout {
  // Run cleanup immediately on startup
  cleanupDebugFiles(debugDir, verbose);
  
  // Then run every DEBUG_CLEANUP_INTERVAL_MS (10 minutes)
  return setInterval(() => cleanupDebugFiles(debugDir, verbose), DEBUG_CLEANUP_INTERVAL_MS);
}


/**
 * Tool definitions for the LLM - generic, not application-specific
 * These describe the search capabilities available in any docidx index.
 * 
 * The grep tool is conditionally included based on whether content
 * was copied during build (indicated by manifest.content_copy.enabled).
 */
function buildToolsDefinition(manifest: ManifestData): string {
  const grepEnabled = manifest.content_copy?.enabled === true;
  
  const grepTool = grepEnabled ? `
4. search_grep(query: string, limit?: number)
   - Unix grep search on raw markdown files
   - Useful for pattern matching or comparing performance with SQLite search
   - Returns file paths and matching lines
` : '';

  const toolCount = grepEnabled ? '6' : '5';
  const toolNumbers = grepEnabled ? {
    readDoc: '5',
    findRelated: '6'
  } : {
    readDoc: '4',
    findRelated: '5'
  };

  return `
You have access to the following tools to search and read documentation:

## Search Tools (return chunks/snippets)

1. search_hybrid(query: string, limit?: number)
   - Best for natural language questions
   - Combines semantic similarity with keyword matching
   - Use for: "How do I...", "What is...", conceptual questions

2. search_fts(query: string, limit?: number)
   - Full-text keyword search using BM25 ranking
   - Fast and good for specific terms
   - Use for: technical terms, feature names, exact phrases
   - Note: Special characters like ^ are treated as word separators

3. search_literal(query: string, limit?: number)  
   - Exact substring match (case-insensitive)
   - Finds special characters like ^, |, %, etc.
   - Use for: code snippets, exact identifiers, URLs, regex patterns
${grepTool}
## Document Tools (read full documents)

${toolNumbers.readDoc}. read_document(doc_id: string)
   - Read the FULL content of a document (all chunks combined)
   - Use when a search result snippet seems relevant but you need more context
   - Pass the doc_id or URL from a search result

${toolNumbers.findRelated}. find_related(doc_id: string, limit?: number)
   - Find documents that reference or link to the given document
   - Useful to discover related topics or see how a feature connects to others

To use a tool, respond with a JSON block:
\`\`\`tool
{"tool": "search_fts", "query": "some search term", "limit": 5}
\`\`\`

Or for reading a full document:
\`\`\`tool
{"tool": "read_document", "doc_id": "functions/scheduling.md"}
\`\`\`

You can call multiple tools in sequence. After gathering enough information, provide your final answer.
When answering, cite sources using [1], [2], etc. matching the document numbers in the search results.
`;
}

/**
 * Final answer directive - appended to ALL system prompts to ensure reliable answer detection.
 * This convention is more robust than XML tags or heuristic detection across LLM providers.
 */
const FINAL_ANSWER_DIRECTIVE = `

## RESPONSE FORMAT (CRITICAL)

You MUST respond with EXACTLY ONE of these two formats:

1. **Tool call**: Output ONLY valid JSON in a tool block, nothing else:
   \`\`\`tool
   {"tool": "search_fts", "query": "example"}
   \`\`\`

2. **Final answer**: When you have enough information FROM SEARCH RESULTS, prefix your answer with "FINAL:" on its own line:
   FINAL:
   Your complete answer here with [1] citations.

IMPORTANT RULES:
- You MUST search the documentation before answering. NEVER answer without searching first.
- NEVER mix tool calls with answer text in the same response.
- NEVER omit the FINAL: prefix on your completed answer.
- If you need to search, output ONLY the tool call. If you're ready to answer, start with FINAL:

## CITATION RULES (CRITICAL)

When citing sources in your answer:
- Use ONLY the exact [N] numbers shown in search results (e.g., [1], [2], [3])
- Do NOT invent document titles - reference by number only
- Do NOT include any bibliography or reference list at the end - the system generates this automatically
- Inline citations should look like: "Encounters can be created from the visit queue [1] or from the patient chart [3]."
- WRONG: "[1] WebChart User Guide Chapter 3" - never include titles with citations
- RIGHT: "According to the documentation [1], encounters track patient visits."
- If search results show [1], [2], [5] - use those exact numbers, not [1], [2], [3]`;

/**
 * Assertion-awareness directive — appended to every system prompt so answers respect
 * the clinical assertion tags surfaced in search results (issue #15, Phase 2).
 */
const ASSERTION_DIRECTIVE = `

## CLINICAL ASSERTIONS (CRITICAL)

Some search results are tagged with a clinical assertion status, e.g. "(assertion: ABSENT)":
- ABSENT — the source explicitly DENIES or rules out that finding. NEVER report it as present; state that it was denied/absent, and you may still cite it.
- POSSIBLE — uncertain / part of a differential. Report as possible, not confirmed.
- HISTORICAL — a past condition, not necessarily current.
- Results with no tag (or PRESENT) are asserted normally.
Honor these tags: a finding listed under a "Negative for" section is NOT present.

A result may also list a "Per-finding:" line (e.g. "chest pain = ABSENT; leg weakness = PRESENT").
This is MORE specific than the passage-level tag — a single sentence can deny one finding while
reporting another. When it's present, answer about each finding using ITS OWN status, not the
passage-level one.`;

/**
 * Build the system prompt by interpolating {{TOOLS}} placeholder with actual tools definition
 * and appending the FINAL: directive for reliable answer detection.
 */
function buildSystemPrompt(manifest: ManifestData): string {
  const template = manifest.agent?.system_prompt || DEFAULT_SYSTEM_PROMPT;
  const toolsDefinition = buildToolsDefinition(manifest);
  const basePrompt = template.replace('{{TOOLS}}', toolsDefinition.trim());
  // Always append the final answer + assertion directives
  return basePrompt + FINAL_ANSWER_DIRECTIVE + ASSERTION_DIRECTIVE;
}

/**
 * Perform a pre-search to provide immediate context about relevant documents.
 * This grounds the LLM before it starts reasoning and reduces hallucination.
 * Returns a context string to append to the user's question.
 */
async function buildPreSearchContext(
  question: string,
  ctx: AgentContext,
  limit: number = 5
): Promise<{ context: string; results: SearchResult[]; searchQuery: string }> {
  const ts = () => new Date().toISOString();
  
  // Extract key terms from question for search
  // Remove common question words/phrases and get substantive terms
  const searchQuery = question
    .replace(/^(what\s+is|what\s+are|how\s+do|how\s+to|how\s+can|tell\s+me\s+about|explain|describe|what|how|why|when|where|who|is|are|do|does|can|could|would|should)\s+(an?\s+)?/gi, '')
    .replace(/[?!.,;:'"]/g, '')
    .trim()
    .slice(0, 100);  // Limit length

  if (!searchQuery || searchQuery.length < 2) {
    if (ctx.verbose) {
      console.log(`[${ts()}]    ⚠️ Pre-search skipped: query too short ("${searchQuery}")`);
    }
    return { context: '', results: [], searchQuery };
  }

  if (ctx.verbose) {
    console.log(`[${ts()}]    🔍 Pre-search query: "${searchQuery}"`);
  }

  try {
    // Use hybrid search for best results
    const [queryVector] = await ctx.embedder.embed([searchQuery]);
    const hybridResults = ctx.store.hybridSearch(queryVector, searchQuery, limit);
    
    if (hybridResults.length === 0) {
      if (ctx.verbose) {
        console.log(`[${ts()}]    ⚠️ Pre-search: no results found`);
      }
      return { context: '', results: [], searchQuery };
    }

    // Convert to SearchResult format and add to context
    const results: SearchResult[] = hybridResults.map(r => ({
      chunk_id: r.chunk_id,
      doc_id: r.doc_id,
      url: r.url,
      title: r.title,
      headings: r.headings,
      content: r.content,
      score: r.score,
      method: 'hybrid' as const,
      vectorRank: r.vectorRank,
      ftsRank: r.ftsRank
    }));

    // Add to context tracking (so references work)
    for (const r of results) {
      if (!ctx.searchResults.has(r.chunk_id)) {
        ctx.searchResults.set(r.chunk_id, r);
        ctx.resultOrder.push(r.chunk_id);
      }
    }

    // Build document list for context (just titles and URLs, no content previews)
    const docList = results.map((r, i) => {
      const globalIdx = ctx.resultOrder.indexOf(r.chunk_id) + 1;
      const location = r.headings.length > 0
        ? `${r.title} > ${r.headings.join(' > ')}`
        : r.title;
      return `[${globalIdx}] ${location}\n    URL: ${r.url}`;
    }).join('\n\n');

    const context = `\n\n---\nPre-search for "${searchQuery}" found these potentially relevant documents:\n\n${docList}\n\nUse search tools to read these documents in detail, or search for other relevant documents.`;

    // Verbose: show the exact context being appended
    if (ctx.verbose) {
      console.log(`[${ts()}]    📋 Pre-search found ${results.length} documents`);
      console.log(`[${ts()}]    ┌─ Context appended to prompt:`);
      for (const line of context.split('\n')) {
        console.log(`[${ts()}]    │ ${line}`);
      }
      console.log(`[${ts()}]    └─`);
    }

    return { context, results, searchQuery };
  } catch (error) {
    // Don't fail the whole request if pre-search fails
    if (ctx.verbose) {
      console.log(`[${ts()}] ⚠️ Pre-search failed: ${(error as Error).message}`);
    }
    return { context: '', results: [], searchQuery };
  }
}

interface SearchResult {
  chunk_id: string;
  doc_id: string;
  url: string;
  title: string;
  headings: string[];
  content: string;
  score: number;
  /** Clinical assertion status (Phase 2). Surfaced to the LLM so it respects negation. */
  assertion?: string;
  /** Per-finding assertions (Phase 2) as a JSON string, hydrated before formatting. */
  findings?: string;
  method: 'hybrid' | 'fts' | 'literal' | 'document' | 'related' | 'grep';
  vectorRank?: number;
  ftsRank?: number;
}

interface ToolCall {
  tool: string;
  query?: string;
  doc_id?: string;
  limit?: number;
}

interface AgentContext {
  embedder: Embedder;
  store: SqliteStore;
  manifest: ManifestData;
  model: string;
  verbose: boolean;
  searchResults: Map<string, SearchResult>;  // Deduplicated results by chunk_id
  resultOrder: string[];  // Order of first appearance
  showChunks: boolean;  // Whether to display full chunk content
  footnoteDir: string;  // Path to footnote index directory (for grep search)
  debugDir: string;  // Path to debug folder for conversation logs
}

/**
 * Result from tool execution
 */
interface ToolExecutionResult {
  formatted: string;  // Formatted text for LLM
  chunks: Array<{
    title: string;
    url: string;
    headings: string[];
    snippet: string;
  }>;
}

/**
 * Execute a tool call and return formatted results
 */
async function executeTool(toolCall: ToolCall, ctx: AgentContext): Promise<ToolExecutionResult> {
  const { tool, query, doc_id, limit = 5 } = toolCall;
  let results: SearchResult[] = [];

  if (ctx.verbose) {
    const arg = query || doc_id || '';
    console.log(`   🔧 ${tool}("${arg}"${limit !== 5 ? `, ${limit}` : ''})`);
  }

  const errorResult = (msg: string): ToolExecutionResult => ({
    formatted: msg,
    chunks: []
  });

  switch (tool) {
    case 'search_hybrid': {
      if (!query) return errorResult('Error: search_hybrid requires a query');
      const [queryVector] = await ctx.embedder.embed([query]);
      const hybridResults = ctx.store.hybridSearch(queryVector, query, limit);
      results = hybridResults.map(r => ({
        chunk_id: r.chunk_id,
        doc_id: r.doc_id,
        url: r.url,
        title: r.title,
        headings: r.headings,
        content: r.content,
        score: r.score,
        assertion: r.assertion,
        method: 'hybrid' as const,
        vectorRank: r.vectorRank,
        ftsRank: r.ftsRank
      }));
      break;
    }
    
    case 'search_fts': {
      if (!query) return errorResult('Error: search_fts requires a query');
      const ftsResults = ctx.store.ftsSearch(query, limit);
      results = ftsResults.map((r, i) => ({
        chunk_id: r.chunk_id,
        doc_id: r.doc_id,
        url: r.url,
        title: r.title,
        headings: r.headings,
        content: r.content,
        score: -r.bm25Score,
        assertion: r.assertion,
        method: 'fts' as const,
        ftsRank: i + 1
      }));
      break;
    }
    
    case 'search_literal': {
      if (!query) return errorResult('Error: search_literal requires a query');
      const literalResults = ctx.store.literalSearch(query, limit);
      results = literalResults.map((r, i) => ({
        chunk_id: r.chunk_id,
        doc_id: r.doc_id,
        url: r.url,
        title: r.title,
        headings: r.headings,
        content: r.content,
        score: r.matchCount,
        assertion: r.assertion,
        method: 'literal' as const,
        ftsRank: i + 1  // Use ftsRank for display consistency
      }));
      break;
    }

    case 'read_document': {
      let docIdentifier = doc_id || query;
      if (!docIdentifier) return errorResult('Error: read_document requires a doc_id');
      
      // Resolve [N] references to actual doc_ids from search results
      const refMatch = docIdentifier.match(/^\[(\d+)\]$/);
      if (refMatch) {
        const refNum = parseInt(refMatch[1]);
        const refChunkId = ctx.resultOrder[refNum - 1];
        if (refChunkId) {
          const refResult = ctx.searchResults.get(refChunkId);
          if (refResult) {
            // Use the URL as the doc identifier (most reliable)
            docIdentifier = refResult.url;
            if (ctx.verbose) {
              console.log(`   📖 Resolved [${refNum}] → ${docIdentifier}`);
            }
          }
        }
        if (docIdentifier.match(/^\[(\d+)\]$/)) {
          return errorResult(`Reference [${refNum}] not found in search results. Use the URL or doc_id instead.`);
        }
      }
      
      const chunks = ctx.store.getDocumentChunks(docIdentifier);
      if (chunks.length === 0) {
        return errorResult(`No document found matching "${docIdentifier}"`);
      }

      // Combine all chunks into full document
      const fullContent = chunks.map(c => c.content).join('\n\n');
      const doc = chunks[0];
      
      // Create a single "result" representing the full document
      const docResult: SearchResult = {
        chunk_id: `${doc.doc_id}:full`,
        doc_id: doc.doc_id,
        url: doc.url,
        title: doc.title,
        headings: [],
        content: fullContent,
        score: 1,
        method: 'document' as const
      };

      // Add to context
      if (!ctx.searchResults.has(docResult.chunk_id)) {
        ctx.searchResults.set(docResult.chunk_id, docResult);
        ctx.resultOrder.push(docResult.chunk_id);
      }

      const globalIdx = ctx.resultOrder.indexOf(docResult.chunk_id) + 1;
      const tokenEst = Math.ceil(fullContent.length / 4);

      if (ctx.showChunks) {
        console.log(`\n   📖 Full document: ${doc.title}`);
        console.log(`       URL: ${doc.url}`);
        console.log(`       ${chunks.length} chunks, ~${tokenEst} tokens`);
        console.log(`   ─────────────────────────────────────────────`);
        console.log(fullContent.split('\n').map(line => `   ${line}`).join('\n'));
        console.log('');
      }

      return {
        formatted: `[${globalIdx}] Full document: ${doc.title}\n    URL: ${doc.url}\n    (${chunks.length} chunks, ~${tokenEst} tokens)\n\n${fullContent}`,
        chunks: [{
          title: doc.title,
          url: doc.url,
          headings: [],
          snippet: fullContent.slice(0, 300) + (fullContent.length > 300 ? '...' : '')
        }]
      };
    }

    case 'find_related': {
      let docIdentifier = doc_id || query;
      if (!docIdentifier) return errorResult('Error: find_related requires a doc_id');
      
      // Resolve [N] references to actual doc_ids from search results
      const refMatch = docIdentifier.match(/^\[(\d+)\]$/);
      if (refMatch) {
        const refNum = parseInt(refMatch[1]);
        const refChunkId = ctx.resultOrder[refNum - 1];
        if (refChunkId) {
          const refResult = ctx.searchResults.get(refChunkId);
          if (refResult) {
            docIdentifier = refResult.url;
            if (ctx.verbose) {
              console.log(`   📎 Resolved [${refNum}] → ${docIdentifier}`);
            }
          }
        }
        if (docIdentifier.match(/^\[(\d+)\]$/)) {
          return errorResult(`Reference [${refNum}] not found in search results. Use the URL or doc_id instead.`);
        }
      }
      
      const related = ctx.store.findRelatedDocuments(docIdentifier, limit);
      if (related.length === 0) {
        return errorResult(`No related documents found for "${docIdentifier}"`);
      }

      const formatted = related.map((r, i) => 
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   doc_id: ${r.doc_id}`
      ).join('\n\n');

      if (ctx.verbose) {
        console.log(`   📎 Found ${related.length} related documents`);
      }

      return {
        formatted: `Found ${related.length} related documents:\n\n${formatted}\n\nUse read_document to read any of these.`,
        chunks: related.map(r => ({
          title: r.title,
          url: r.url,
          headings: [],
          snippet: `doc_id: ${r.doc_id}`
        }))
      };
    }

    case 'search_grep': {
      if (!query) return errorResult('Error: search_grep requires a query');
      
      // Check if grep is enabled via manifest
      if (!ctx.manifest.content_copy?.enabled) {
        return errorResult('Error: search_grep is not available. Rebuild with --copy-content to enable.');
      }
      
      const contentDir = path.join(ctx.footnoteDir, 'content');
      if (!fs.existsSync(contentDir)) {
        return errorResult(`Error: Content directory not found at ${contentDir}. Index may need rebuilding.`);
      }

      const startTime = performance.now();
      try {
        // Use grep to search markdown files
        // -r: recursive, -i: case insensitive, -l: files only, -n: line numbers
        const escapedQuery = query.replace(/['"\\]/g, '\\$&');
        const grepCmd = `grep -rin --include="*.md" "${escapedQuery}" "${contentDir}" | head -${limit * 10}`;
        
        const output = execSync(grepCmd, { 
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024  // 10MB buffer
        });
        
        const endTime = performance.now();
        const elapsed = (endTime - startTime).toFixed(1);

        // Parse grep output: file:line:content
        const lines = output.trim().split('\n').filter(l => l.length > 0);
        
        // Group by file and take first N files
        const fileMatches = new Map<string, { line: number; content: string }[]>();
        for (const line of lines) {
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (match) {
            const [, filePath, lineNum, content] = match;
            const relPath = filePath.replace(contentDir + '/', '');
            if (!fileMatches.has(relPath)) {
              fileMatches.set(relPath, []);
            }
            fileMatches.get(relPath)!.push({ 
              line: parseInt(lineNum), 
              content: content.trim().slice(0, 200) 
            });
          }
        }

        // Convert to results
        const uniqueFiles = [...fileMatches.keys()].slice(0, limit);
        results = uniqueFiles.map((relPath, i) => {
          const matches = fileMatches.get(relPath)!;
          const url = '/' + relPath.replace(/\.md$/, '/').replace(/\/_index\//, '/');
          const title = path.basename(relPath, '.md').replace(/-/g, ' ');
          const snippets = matches.slice(0, 3).map(m => `L${m.line}: ${m.content}`).join('\n');
          
          return {
            chunk_id: `grep_${relPath}_${i}`,
            doc_id: relPath,
            url,
            title,
            headings: [],
            content: snippets,
            score: matches.length,
            method: 'grep' as const,
            ftsRank: i + 1
          };
        });

        if (ctx.verbose) {
          console.log(`   ⏱️  grep completed in ${elapsed}ms, ${lines.length} matches in ${fileMatches.size} files`);
        }
      } catch (error) {
        // grep returns exit code 1 if no matches
        if ((error as any).status === 1) {
          return errorResult(`No grep matches found for "${query}"`);
        }
        return errorResult(`Grep error: ${(error as Error).message}`);
      }
      break;
    }
    
    default:
      return errorResult(`Error: Unknown tool "${tool}"`);
  }

  if (results.length === 0) {
    return errorResult(`No results found for "${query}"`);
  }

  // Hydrate per-finding assertions (Phase 2) so the model can reason per finding —
  // e.g. a chunk where one finding is denied and another is present.
  const findingsByChunk = ctx.store.getFindingsByChunkIds(results.map(r => r.chunk_id));
  for (const r of results) r.findings = findingsByChunk.get(r.chunk_id);

  // Add results to context (deduplicated)
  for (const r of results) {
    if (!ctx.searchResults.has(r.chunk_id)) {
      ctx.searchResults.set(r.chunk_id, r);
      ctx.resultOrder.push(r.chunk_id);
    }
  }

  // Show chunks if requested
  if (ctx.showChunks) {
    console.log(`\n   📄 Chunks retrieved (${results.length}):`);
    for (const r of results) {
      const globalIdx = ctx.resultOrder.indexOf(r.chunk_id) + 1;
      const location = r.headings.length > 0
        ? `${r.title} > ${r.headings.join(' > ')}`
        : r.title;
      const tokenEst = Math.ceil(r.content.length / 4);  // ~4 chars per token
      console.log(`   ─────────────────────────────────────────────`);
      console.log(`   [${globalIdx}] ${location}`);
      console.log(`       URL: ${r.url}`);
      console.log(`       Chunk ID: ${r.chunk_id}`);
      console.log(`       ~${tokenEst} tokens, ${r.content.length} chars`);
      console.log(`   ─────────────────────────────────────────────`);
      console.log(r.content.split('\n').map(line => `   ${line}`).join('\n'));
      console.log('');
    }
  }

  // Format results for the LLM - include FULL content, not just snippets
  // Explicit assertion guidance per status. Scoped to THIS passage so the model
  // doesn't over-apply "absent" to findings that appear (present) in other passages.
  const ASSERTION_NOTE: Record<string, string> = {
    absent: '[Assertion: the specific findings named in THIS passage are documented as ABSENT/denied. Applies ONLY to findings stated here — not to findings in other passages.]',
    possible: '[Assertion: findings in THIS passage are POSSIBLE/uncertain (a differential), not confirmed.]',
    historical: '[Assertion: findings in THIS passage are HISTORICAL — past, not necessarily current.]',
  };
  const formatted = results.map((r, i) => {
    const globalIdx = ctx.resultOrder.indexOf(r.chunk_id) + 1;
    const location = r.headings.length > 0
      ? `${r.title} > ${r.headings.join(' > ')}`
      : r.title;
    // Surface the clinical assertion so the LLM doesn't report a denied finding as present.
    const a = (r.assertion || 'unspecified').toLowerCase();
    const tag = a !== 'unspecified' ? ` (assertion: ${a.toUpperCase()})` : '';
    const note = ASSERTION_NOTE[a] ? `\n    ${ASSERTION_NOTE[a]}` : '';
    // Per-finding assertions (Phase 2): specific findings tagged individually from the
    // prose. More precise than the chunk-level tag — a single passage can have both.
    let perFinding = '';
    try {
      const fs = JSON.parse(r.findings || '[]') as Array<{ finding: string; assertion: string; temporality?: string }>;
      if (fs.length > 0) {
        perFinding = '\n    Per-finding: ' + fs.map(f => {
          // Flag historical/hypothetical so the model doesn't report a past or conditional
          // finding as a current one; 'recent' is the default and left unlabeled.
          const when = f.temporality && f.temporality !== 'recent' ? ` (${f.temporality})` : '';
          return `${f.finding} = ${f.assertion.toUpperCase()}${when}`;
        }).join('; ');
      }
    } catch { /* ignore malformed findings */ }
    // Include full content so LLM can actually read the documents
    return `[${globalIdx}]${tag} ${location}\n    URL: ${r.url}${note}${perFinding}\n\n${r.content}`;
  }).join('\n\n---\n\n');

  // Build chunk metadata for streaming
  const chunks = results.map(r => ({
    title: r.title,
    url: r.url,
    headings: r.headings,
    snippet: r.content.replace(/\n+/g, ' ').slice(0, 200) + (r.content.length > 200 ? '...' : '')
  }));

  return {
    formatted: `Found ${results.length} results:\n\n${formatted}`,
    chunks
  };
}

/**
 * Parse tool calls from LLM response
 */
function parseToolCalls(response: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  
  // Try code block format first: ```tool ... ```
  const toolBlockRegex = /```tool\s*\n?([\s\S]*?)\n?```/g;
  let match;
  while ((match = toolBlockRegex.exec(response)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool && (parsed.query || parsed.doc_id)) {
        toolCalls.push(parsed);
      }
    } catch {
      // Invalid JSON, skip
    }
  }
  
  // Also try bare JSON objects with "tool" key
  if (toolCalls.length === 0) {
    // Match JSON with either query or doc_id
    const jsonRegex = /\{[^{}]*"tool"\s*:\s*"[^"]+"[^{}]*(?:"query"|"doc_id")\s*:\s*"[^"]*"[^{}]*\}/g;
    while ((match = jsonRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.tool && (parsed.query || parsed.doc_id)) {
          toolCalls.push(parsed);
        }
      } catch {
        // Invalid JSON, skip
      }
    }
  }
  
  return toolCalls;
}

/**
 * Extract the final answer (text after last tool call or full response if no tools)
 */
function extractAnswer(response: string): string {
  // Remove tool blocks
  const withoutTools = response.replace(/```tool\s*\n?[\s\S]*?\n?```/g, '').trim();
  return withoutTools;
}

/**
 * Clean a response for display (strip code fences that wrap the whole answer)
 */
function cleanResponse(text: string): string {
  let cleaned = text;
  // Remove leading code fence (```markdown or ``` at start)
  cleaned = cleaned.replace(/^```[a-z]*\n?/i, '');
  // Remove trailing code fence
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  return cleaned.trim();
}

/**
 * Detect whether a model name refers to an OpenAI chat model (gpt-*, o1/o3/o4
 * reasoning models, or chatgpt-*). Ollama models are anything else.
 */
function isOpenAIModel(model: string): boolean {
  return /^(gpt-|o[0-9]|chatgpt)/i.test(model);
}

let openaiChatClient: OpenAI | null = null;
function getOpenAIChatClient(): OpenAI {
  if (!openaiChatClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required to use an OpenAI chat model');
    }
    openaiChatClient = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL });
  }
  return openaiChatClient;
}

/**
 * Call OpenAI for chat completion (non-streaming).
 * Note: newer models (gpt-5, o-series) only accept the default temperature,
 * so we don't send a custom temperature and use max_completion_tokens.
 */
async function chatOpenAI(
  messages: Array<{ role: string; content: string }>,
  model: string
): Promise<string> {
  const client = getOpenAIChatClient();
  const completion = await client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    stream: false
  });
  return completion.choices[0]?.message?.content ?? '';
}

/**
 * Call OpenAI with streaming - yields content deltas as they arrive.
 */
async function* chatStreamOpenAI(
  messages: Array<{ role: string; content: string }>,
  model: string
): AsyncGenerator<string, string, unknown> {
  const client = getOpenAIChatClient();
  const stream = await client.chat.completions.create({
    model,
    messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    stream: true
  });

  let fullContent = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullContent += delta;
      yield delta;
    }
  }
  return fullContent;
}

/**
 * Chat completion (non-streaming). Dispatches to OpenAI or Ollama based on the
 * model name.
 */
async function chat(
  messages: Array<{ role: string; content: string }>,
  model: string
): Promise<string> {
  if (isOpenAIModel(model)) {
    return chatOpenAI(messages, model);
  }

  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: 2000
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  const data = await response.json() as { message: { content: string } };
  return data.message.content;
}

/**
 * Chat completion with streaming - yields tokens as they arrive. Dispatches to
 * OpenAI or Ollama based on the model name.
 */
async function* chatStream(
  messages: Array<{ role: string; content: string }>,
  model: string
): AsyncGenerator<string, string, unknown> {
  if (isOpenAIModel(model)) {
    return yield* chatStreamOpenAI(messages, model);
  }

  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: {
        temperature: 0.2,
        num_predict: 2000
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    // Ollama streams newline-delimited JSON
    const lines = chunk.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      try {
        const data = JSON.parse(line) as { message?: { content: string }; done?: boolean };
        if (data.message?.content) {
          fullContent += data.message.content;
          yield data.message.content;
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  return fullContent;
}

/**
 * Verbose logging helper - formats messages for display
 */
function logMessages(messages: Array<{ role: string; content: string }>, label: string): void {
  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] ┌─ ${label}`);
  for (const msg of messages) {
    const roleIcon = msg.role === 'system' ? '⚙️' : msg.role === 'user' ? '👤' : '🤖';
    console.log(`[${ts()}] │ ${roleIcon} [${msg.role.toUpperCase()}]`);
    // Show content with indentation, truncate very long content
    const lines = msg.content.split('\n');
    const maxLines = msg.role === 'system' ? 10 : 50; // Truncate system prompt more
    const displayLines = lines.length > maxLines ? [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`] : lines;
    for (const line of displayLines) {
      // Truncate very long lines
      const displayLine = line.length > 200 ? line.slice(0, 200) + '...' : line;
      console.log(`[${ts()}] │   ${displayLine}`);
    }
    console.log(`[${ts()}] │`);
  }
  console.log(`[${ts()}] └─`);
}

function logResponse(response: string, label: string): void {
  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] ┌─ ${label}`);
  const lines = response.split('\n');
  for (const line of lines) {
    // Truncate very long lines
    const displayLine = line.length > 200 ? line.slice(0, 200) + '...' : line;
    console.log(`[${ts()}] │ ${displayLine}`);
  }
  console.log(`[${ts()}] └─`);
}

/**
 * Event types for streaming responses
 */
type StreamEvent =
  | { type: 'start'; timestamp: string; debugFile?: string; reportToken?: string }
  | { type: 'thinking'; message: string }
  | { type: 'tool_call'; tool: string; query: string }
  | { type: 'tool_result'; tool: string; resultCount: number; chunks: Array<{ title: string; url: string; headings: string[]; snippet: string }> }
  | { type: 'token'; content: string }
  | { type: 'done'; references: ReturnType<typeof getReferencesData> }
  | { type: 'error'; message: string };

/**
 * Sanitize a string for use in a filename
 */
function sanitizeFilename(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Save conversation history to a debug JSON file in OpenAI messages[] format
 */
function saveDebugConversation(
  question: string,
  messages: Array<{ role: string; content: string }>,
  finalAnswer: string,
  ctx: AgentContext,
  debugFile: string,
  reportToken: string
): void {
  try {
    // Ensure debug directory exists
    if (!fs.existsSync(ctx.debugDir)) {
      fs.mkdirSync(ctx.debugDir, { recursive: true });
    }
    
    // Use the provided debugFile name for consistency with emitted events
    const filepath = path.join(ctx.debugDir, debugFile);
    
    // Build the debug data in OpenAI messages format
    const debugData = {
      metadata: {
        question,
        timestamp: new Date().toISOString(),
        model: ctx.model,
        documentsConsulted: ctx.searchResults.size,
        footnoteDir: ctx.footnoteDir,
        debugFile,
        reportToken  // Secret token for validating report requests
      },
      messages: [
        ...messages,
        // Add the final assistant response if we have one
        ...(finalAnswer ? [{ role: 'assistant', content: finalAnswer }] : [])
      ],
      references: Array.from(ctx.searchResults.values()).map((r, i) => ({
        index: ctx.resultOrder.indexOf(r.chunk_id) + 1,
        title: r.title,
        url: r.url,
        headings: r.headings,
        chunk_id: r.chunk_id,
        doc_id: r.doc_id
      }))
    };
    
    fs.writeFileSync(filepath, JSON.stringify(debugData, null, 2));
    
    if (ctx.verbose) {
      console.log(`[${new Date().toISOString()}] 📝 Debug conversation saved to: ${filepath}`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Failed to save debug conversation:`, error);
  }
}

/**
 * Extract the final answer from a response that may contain FINAL: prefix
 */
function extractFinalAnswer(response: string): string | null {
  // Look for FINAL: prefix (with optional whitespace)
  const finalMatch = response.match(/(?:^|\n)\s*FINAL:\s*([\s\S]*)$/i);
  if (finalMatch) {
    return cleanResponse(finalMatch[1].trim());
  }
  return null;
}

/**
 * Run the agent loop with streaming - yields events as they happen.
 * Uses FINAL: prefix protocol for reliable answer detection.
 * 
 * Protocol:
 * - LLM outputs ONLY tool calls (JSON) OR final answer prefixed with FINAL:
 * - All content before FINAL: is treated as thinking/internal reasoning
 * - If FINAL: never appears, accumulated thinking is converted to answer
 */
async function* runAgentStream(
  question: string,
  ctx: AgentContext,
  maxIterations: number = 5
): AsyncGenerator<StreamEvent, void, unknown> {
  // Generate session timestamp for debug correlation
  const sessionTimestamp = new Date().toISOString();
  
  // Compute debug filename for conversation log
  const sanitized = sanitizeFilename(question);
  const debugFile = `${sessionTimestamp.replace(/[:.]/g, '-')}-${sanitized}.json`;
  
  // Generate a secret token for report validation - only the browser that received this can report
  const reportToken = crypto.randomUUID();
  
  yield { type: 'start', timestamp: sessionTimestamp, debugFile, reportToken };
  
  const baseSystemPrompt = buildSystemPrompt(ctx.manifest);

  // Perform pre-search to provide immediate context
  yield { type: 'thinking', message: 'Finding relevant documents...' };
  const { context: preSearchContext, results: preSearchResults } = await buildPreSearchContext(question, ctx);
  
  // Emit pre-search results if any were found
  if (preSearchResults.length > 0) {
    yield { 
      type: 'tool_result', 
      tool: 'pre-search', 
      resultCount: preSearchResults.length,
      chunks: preSearchResults.map(r => ({
        title: r.title,
        url: r.url,
        headings: r.headings,
        snippet: r.content.replace(/\n+/g, ' ').slice(0, 200) + (r.content.length > 200 ? '...' : '')
      }))
    };
  }

  // Build system prompt with pre-search context appended (user message stays clean)
  const systemPrompt = preSearchContext 
    ? baseSystemPrompt + preSearchContext
    : baseSystemPrompt;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question }
  ];

  // Track all accumulated thinking across iterations
  let allThinking = '';
  // Track actual search iterations (not including retries for protocol compliance)
  let searchIteration = 0;
  // Track final answer for debug logging
  let finalAnswerForDebug = '';

  for (let i = 0; i < maxIterations; i++) {
    // Emit thinking status at start of first iteration only
    if (i === 0) {
      yield { type: 'thinking', message: 'Analyzing question...' };
    }
    
    // Verbose: log what we're sending to the model
    if (ctx.verbose) {
      logMessages(messages, `📤 SENDING TO MODEL (iteration ${i + 1})`);
    }
    
    let response = '';
    let foundFinal = false;
    let finalAnswerBuffer = '';
    
    // Can we stream tokens? Only if we already have search results (won't need retry)
    const canStreamTokens = ctx.searchResults.size > 0;
    
    try {
      // Stream the LLM response
      const stream = chatStream(messages, ctx.model);
      for await (const token of stream) {
        response += token;
        
        // Check if we've hit the FINAL: marker
        const finalIdx = response.search(/(?:^|\n)\s*FINAL:/i);
        if (finalIdx !== -1 && !foundFinal) {
          foundFinal = true;
          // Everything before FINAL: is thinking
          const thinkingPart = response.slice(0, finalIdx);
          if (thinkingPart.trim()) {
            allThinking += thinkingPart + '\n';
          }
          // Extract what we have so far after FINAL:
          const afterFinal = response.slice(finalIdx).replace(/^\s*FINAL:\s*/i, '');
          finalAnswerBuffer = afterFinal;
          // Stream immediately if we have search results
          if (canStreamTokens && afterFinal) {
            yield { type: 'token', content: afterFinal };
          }
        } else if (foundFinal) {
          finalAnswerBuffer += token;
          // Stream tokens in real-time if we have search results
          if (canStreamTokens) {
            yield { type: 'token', content: token };
          }
        }
        // If not found yet, we're accumulating (don't stream - it's thinking or tool call)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        yield { type: 'error', message: 'Ollama is not running. Start it with: ollama serve' };
        return;
      }
      throw error;
    }

    // Verbose: log what we received from the model
    if (ctx.verbose) {
      logResponse(response, `📥 RECEIVED FROM MODEL (iteration ${i + 1})`);
    }

    // If we found FINAL: but haven't searched yet, force a retry (up to 2 attempts)
    if (foundFinal && ctx.searchResults.size === 0 && i < 2) {
      if (ctx.verbose) {
        console.log(`[${new Date().toISOString()}] ⚠️ LLM tried to answer without searching - forcing retry (attempt ${i + 1})`);
      }
      // Add a more forceful protocol repair prompt
      messages.push({ role: 'assistant', content: response });
      messages.push({ 
        role: 'user', 
        content: `DO NOT ANSWER YET. You MUST search the documentation first. Output ONLY a tool call like this:
\`\`\`tool
{"tool": "search_fts", "query": "encounter"}
\`\`\`
Do not include any other text. Just the tool call.` 
      });
      // Continue to next iteration (don't return)
      continue;
    }

    // If we found FINAL:, we're done (either we searched, or we gave up trying)
    if (foundFinal) {
      // If still no search results, do a forced search as last resort
      if (ctx.searchResults.size === 0) {
        if (ctx.verbose) {
          console.log(`[${new Date().toISOString()}] ⚠️ LLM refused to search - performing forced search`);
        }
        // Extract likely search terms from the question
        const searchQuery = question.replace(/^(what|how|why|when|where|who|is|are|do|does|can|could|would|should)\s+/i, '').slice(0, 50);
        yield { type: 'thinking', message: 'Searching documentation...' };
        yield { type: 'tool_call', tool: 'search_hybrid', query: searchQuery };
        const result = await executeTool({ tool: 'search_hybrid', query: searchQuery, limit: 5 }, ctx);
        yield { type: 'tool_result', tool: 'search_hybrid', resultCount: result.chunks.length, chunks: result.chunks };
      }
      // Emit the buffered answer only if we didn't stream it already
      if (finalAnswerBuffer && !canStreamTokens) {
        finalAnswerForDebug = finalAnswerBuffer;
        yield { type: 'token', content: finalAnswerBuffer };
      } else if (finalAnswerBuffer) {
        finalAnswerForDebug = finalAnswerBuffer;
      }
      saveDebugConversation(question, messages, finalAnswerForDebug, ctx, debugFile, reportToken);
      yield { type: 'done', references: getReferencesData(ctx) };
      return;
    }

    // Check for tool calls
    const toolCalls = parseToolCalls(response);
    
    if (toolCalls.length === 0) {
      // No tool calls and no FINAL:
      // If we haven't searched yet, force a search
      if (ctx.searchResults.size === 0 && i < 2) {
        if (ctx.verbose) {
          console.log(`[${new Date().toISOString()}] ⚠️ LLM gave no tools or FINAL - forcing retry (attempt ${i + 1})`);
          console.log(`[${new Date().toISOString()}]    LLM response was:`);
          const truncated = response.length > 500 ? response.slice(0, 500) + '...' : response;
          truncated.split('\n').forEach(line => console.log(`[${new Date().toISOString()}]    | ${line}`));
        }
        messages.push({ role: 'assistant', content: response });
        messages.push({ 
          role: 'user', 
          content: `Output ONLY a tool call. Example:
\`\`\`tool
{"tool": "search_fts", "query": "encounter"}
\`\`\``
        });
        continue;
      }
      
      // Not first iteration - treat entire response as answer (fallback)
      const answer = cleanResponse(extractAnswer(response));
      if (answer) {
        finalAnswerForDebug = answer;
        yield { type: 'token', content: answer };
      }
      saveDebugConversation(question, messages, finalAnswerForDebug, ctx, debugFile, reportToken);
      yield { type: 'done', references: getReferencesData(ctx) };
      return;
    }

    // We have tool calls - add non-tool content to thinking
    const thinkingContent = extractAnswer(response).trim();
    if (thinkingContent) {
      allThinking += thinkingContent + '\n';
    }

    // Increment search iteration counter and emit thinking status
    searchIteration++;
    yield { type: 'thinking', message: `Searching documentation...${searchIteration > 1 ? ` (search ${searchIteration})` : ''}` };

    // Execute tool calls
    const toolResults: string[] = [];
    for (const tc of toolCalls) {
      yield { type: 'tool_call', tool: tc.tool, query: tc.query || tc.doc_id || '' };
      const result = await executeTool(tc, ctx);
      yield { type: 'tool_result', tool: tc.tool, resultCount: result.chunks.length, chunks: result.chunks };
      toolResults.push(`Tool: ${tc.tool}("${tc.query || tc.doc_id}")\n${result.formatted}`);
    }

    // Add assistant response and tool results to conversation
    messages.push({ role: 'assistant', content: response });
    const toolResultsMessage = `Tool results:\n\n${toolResults.join('\n\n---\n\n')}`;
    messages.push({ role: 'user', content: toolResultsMessage });
    
    // Verbose: show tool results being added
    if (ctx.verbose) {
      logResponse(toolResultsMessage, '📨 TOOL RESULTS ADDED TO CONVERSATION');
    }
  }

  // Iteration limit reached - try to get a final answer with what we have
  if (ctx.searchResults.size > 0) {
    yield { type: 'thinking', message: 'Synthesizing answer from gathered information...' };
    
    // Ask for a final synthesis, emphasizing the FINAL: requirement
    messages.push({ 
      role: 'user', 
      content: 'Please provide your best answer based on all the information gathered so far. Do not make any more tool calls. Start your response with FINAL:' 
    });
    
    try {
      let finalResponse = '';
      let foundFinal = false;
      const stream = chatStream(messages, ctx.model);
      for await (const token of stream) {
        finalResponse += token;
        
        // Check for FINAL: marker
        const finalIdx = finalResponse.search(/(?:^|\n)\s*FINAL:/i);
        if (finalIdx !== -1 && !foundFinal) {
          foundFinal = true;
          const afterFinal = finalResponse.slice(finalIdx).replace(/^\s*FINAL:\s*/i, '');
          if (afterFinal) {
            yield { type: 'token', content: afterFinal };
          }
        } else if (foundFinal) {
          yield { type: 'token', content: token };
        }
      }
      
      // If no FINAL: was found, use the whole response (fallback)
      if (!foundFinal) {
        const answer = cleanResponse(extractAnswer(finalResponse));
        if (answer) {
          finalAnswerForDebug = answer;
          yield { type: 'token', content: answer };
        }
      } else {
        // Extract final answer from response for debug
        const afterFinal = finalResponse.replace(/^[\s\S]*?FINAL:\s*/i, '');
        finalAnswerForDebug = afterFinal;
      }
      
      saveDebugConversation(question, messages, finalAnswerForDebug, ctx, debugFile, reportToken);
      yield { type: 'done', references: getReferencesData(ctx) };
      return;
    } catch (error) {
      // Fall through to error
    }
  }

  // Last resort: if we have accumulated thinking, convert it to an answer
  if (allThinking.trim()) {
    yield { type: 'thinking', message: 'Converting gathered information to answer...' };
    const fallbackAnswer = cleanResponse(allThinking);
    finalAnswerForDebug = fallbackAnswer;
    yield { type: 'token', content: fallbackAnswer };
    saveDebugConversation(question, messages, finalAnswerForDebug, ctx, debugFile, reportToken);
    yield { type: 'done', references: getReferencesData(ctx) };
    return;
  }

  yield { type: 'error', message: "Couldn't find a complete answer within the iteration limit." };
}

/**
 * Run the agent loop (non-streaming)
 */
async function runAgent(
  question: string,
  ctx: AgentContext,
  maxIterations: number = 5
): Promise<string> {
  // Build system prompt from manifest (with {{TOOLS}} interpolation)
  const systemPrompt = buildSystemPrompt(ctx.manifest);

  // Perform pre-search to provide immediate context
  const { context: preSearchContext } = await buildPreSearchContext(question, ctx);
  
  // Build user message with pre-search context
  const userMessage = preSearchContext 
    ? question + preSearchContext
    : question;

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  if (ctx.verbose) {
    console.log(`\n🤖 Agent starting...`);
    if (preSearchContext) {
      console.log(`   📋 Pre-search found ${ctx.searchResults.size} relevant documents`);
    }
  }

  for (let i = 0; i < maxIterations; i++) {
    let response: string;
    
    try {
      response = await chat(messages, ctx.model);
    } catch (error) {
      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        return `⚠️ Ollama is not running. Start it with: ollama serve`;
      }
      throw error;
    }

    if (ctx.verbose) {
      console.log(`\n📝 Agent response (iteration ${i + 1}):`);
      console.log(response.slice(0, 200) + (response.length > 200 ? '...' : ''));
    }

    // Check for FINAL: prefix first
    const finalAnswer = extractFinalAnswer(response);
    
    // If FINAL: but haven't searched yet, force a retry (up to 2 attempts)
    if (finalAnswer && ctx.searchResults.size === 0 && i < 2) {
      if (ctx.verbose) {
        console.log(`\n⚠️ LLM tried to answer without searching - forcing retry (attempt ${i + 1})`);
      }
      messages.push({ role: 'assistant', content: response });
      messages.push({ 
        role: 'user', 
        content: `DO NOT ANSWER YET. You MUST search the documentation first. Output ONLY a tool call like this:
\`\`\`tool
{"tool": "search_fts", "query": "encounter"}
\`\`\`
Do not include any other text. Just the tool call.`
      });
      continue;
    }
    
    if (finalAnswer) {
      // If still no search results after retries, do a forced search
      if (ctx.searchResults.size === 0) {
        if (ctx.verbose) {
          console.log(`\n⚠️ LLM refused to search - performing forced search`);
        }
        const searchQuery = question.replace(/^(what|how|why|when|where|who|is|are|do|does|can|could|would|should)\s+/i, '').slice(0, 50);
        await executeTool({ tool: 'search_hybrid', query: searchQuery, limit: 5 }, ctx);
      }
      return finalAnswer;
    }

    // Check for tool calls
    const toolCalls = parseToolCalls(response);
    
    if (toolCalls.length === 0) {
      // No tool calls and no FINAL:
      // If we haven't searched yet, force a retry
      if (ctx.searchResults.size === 0 && i < 2) {
        if (ctx.verbose) {
          console.log(`\n⚠️ LLM gave no tools or FINAL - forcing retry (attempt ${i + 1})`);
        }
        messages.push({ role: 'assistant', content: response });
        messages.push({ 
          role: 'user', 
          content: `Output ONLY a tool call. Example:
\`\`\`tool
{"tool": "search_fts", "query": "encounter"}
\`\`\``
        });
        continue;
      }
      
      // Gave up - treat as final answer (fallback)
      return cleanResponse(extractAnswer(response));
    }

    // Execute tool calls
    const toolResults: string[] = [];
    for (const tc of toolCalls) {
      const result = await executeTool(tc, ctx);
      toolResults.push(`Tool: ${tc.tool}("${tc.query || tc.doc_id}")\n${result.formatted}`);
    }

    // Add assistant response and tool results to conversation
    messages.push({ role: 'assistant', content: response });
    messages.push({ role: 'user', content: `Tool results:\n\n${toolResults.join('\n\n---\n\n')}` });
  }

  // Iteration limit reached - try to get a final answer with what we have
  if (ctx.searchResults.size > 0) {
    if (ctx.verbose) {
      console.log(`\n⚠️ Iteration limit reached, synthesizing final answer...`);
    }
    
    messages.push({ 
      role: 'user', 
      content: 'Please provide your best answer based on all the information gathered so far. Do not make any more tool calls. Start your response with FINAL:' 
    });
    
    try {
      const finalResponse = await chat(messages, ctx.model);
      // Try to extract FINAL: answer, fallback to full response
      return extractFinalAnswer(finalResponse) || cleanResponse(extractAnswer(finalResponse));
    } catch (error) {
      // Fall through to error message
    }
  }

  return "I wasn't able to find a complete answer within the iteration limit.";
}

/**
 * Format method badge for display
 */
function formatMethodBadge(r: SearchResult): string {
  const parts: string[] = [];
  
  if (r.method === 'hybrid') {
    const vr = r.vectorRank ? `V${r.vectorRank}` : '-';
    const fr = r.ftsRank ? `F${r.ftsRank}` : '-';
    parts.push(`HYB[${vr}/${fr}]`);
  } else if (r.method === 'fts') {
    parts.push(`FTS[F${r.ftsRank}]`);
  } else if (r.method === 'literal') {
    parts.push(`LIT[#${r.ftsRank}]`);
  }
  
  parts.push(`(${r.score.toFixed(4)})`);  
  return parts.join(' ');
}

/**
 * Format references from collected search results
 */
function formatReferences(ctx: AgentContext): string {
  if (ctx.resultOrder.length === 0) return '';
  
  const refs = ctx.resultOrder.map((id, i) => {
    const r = ctx.searchResults.get(id)!;
    const location = r.headings.length > 0
      ? `${r.title} > ${r.headings.join(' > ')}`
      : r.title;
    const badge = formatMethodBadge(r);
    return `[${i + 1}] ${badge} ${location}\n    ${r.url}`;
  });
  
  return '\n📚 References:\n\n' + refs.join('\n');
}

/**
 * Format references as structured data (for API responses)
 */
function getReferencesData(ctx: AgentContext): Array<{
  index: number;
  doc_id: string;
  url: string;
  title: string;
  headings: string[];
  method: string;
  score: number;
}> {
  return ctx.resultOrder.map((id, i) => {
    const r = ctx.searchResults.get(id)!;
    return {
      index: i + 1,
      doc_id: r.doc_id,
      url: r.url,
      title: r.title,
      headings: r.headings,
      method: r.method,
      score: r.score
    };
  });
}

/**
 * Shared context initialization
 */
interface AppContext {
  embedder: Embedder;
  store: SqliteStore;
  manifest: ManifestData;
  agentModel: string;
  maxIterations: number;
  footnoteDir: string;
  verbose: boolean;
  /** Optional suggested questions (from --examples <yaml>) shown on the main page. */
  examples?: ExampleQuestion[];
}

/** A suggested question shown below the ask box. */
interface ExampleQuestion {
  /** The question text submitted when clicked. */
  question: string;
  /** Optional short topic/category label. */
  topic?: string;
}

/**
 * Load suggested questions from a YAML file.
 *
 * Accepts either a top-level list or an object with an `examples:`/`questions:`
 * key. Each entry may be a plain string or an object with `question` and
 * optional `topic`/`label`/`category`.
 */
function loadExamples(filePath: string): ExampleQuestion[] {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
  const list = Array.isArray(raw)
    ? raw
    : (raw as any)?.examples ?? (raw as any)?.questions ?? [];
  if (!Array.isArray(list)) return [];

  const examples: ExampleQuestion[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const q = item.trim();
      if (q) examples.push({ question: q });
    } else if (item && typeof item === 'object') {
      const question = String(item.question ?? item.q ?? '').trim();
      if (!question) continue;
      const topic = item.topic ?? item.label ?? item.category;
      examples.push(topic ? { question, topic: String(topic) } : { question });
    }
  }
  return examples;
}

async function initializeApp(): Promise<AppContext> {
  const verbose = args.verbose;
  
  // Auto-detect footnote index directory from project config if not specified
  let footnoteDir = args.db;
  if (!footnoteDir) {
    const { config } = await loadProjectConfig(process.cwd());
    const projectRoot = resolveContentRoot(config, process.cwd());

    // Check candidate directories in priority order
    const candidates = [
      path.join(projectRoot, 'artipod'),   // default build output
      path.join(projectRoot, '.footnote'),  // alternate name
      path.join(process.cwd(), 'artipod'),
      path.join(process.cwd(), '.footnote'),
    ];

    const found = candidates.find(d => fs.existsSync(path.join(d, 'index.sqlite')));
    footnoteDir = found || candidates[0]; // use first candidate as default even if missing
  }
  
  footnoteDir = path.resolve(footnoteDir);
  const indexPath = path.join(footnoteDir, 'index.sqlite');
  const manifestPath = path.join(footnoteDir, 'manifest.json');

  if (verbose) {
    console.log(`\n📂 Configuration:`);
    console.log(`   Index:     ${footnoteDir}`);
    console.log(`   DB:        ${indexPath}`);
    console.log(`   Manifest:  ${manifestPath}`);
  }

  if (!fs.existsSync(indexPath)) {
    throw new Error(`Index not found: ${indexPath}. Run 'docidx build' first.`);
  }

  const manifest = readManifest(manifestPath);
  if (!manifest) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  let embeddingModel = manifest.embedding.model_id;
  if (manifest.embedding.provider === 'mock') {
    embeddingModel = 'mock';
  }
  const embeddingDim = manifest.embedding.dimension;

  // Determine agent model.
  // Priority: CLI --model > OpenAI default (when a key is present) > manifest > Ollama fallback.
  // When OPENAI_API_KEY is set, default answers to OpenAI (GPT-5) so the same
  // key powers both embeddings and answer generation. Override the OpenAI model
  // with OPENAI_CHAT_MODEL, or force any model with --model.
  const openaiDefaultModel = process.env.OPENAI_CHAT_MODEL || 'gpt-5';
  const agentModel = args.model
    || (process.env.OPENAI_API_KEY ? openaiDefaultModel : (manifest.agent?.model || 'llama3.2'));
  const maxIterations = manifest.agent?.max_iterations || 5;
  
  // Determine prompt source
  const promptSource = manifest.agent?.system_prompt 
    ? 'manifest.json (custom)' 
    : 'DEFAULT_SYSTEM_PROMPT (built-in)';

  if (verbose) {
    console.log(`\n🤖 Agent Configuration:`);
    console.log(`   Model:          ${agentModel}${args.model ? ' (from CLI)' : process.env.OPENAI_API_KEY ? ' (OpenAI default)' : manifest.agent?.model ? ' (from manifest)' : ' (default)'}`);
    console.log(`   Max Iterations: ${maxIterations}`);
    console.log(`   Prompt:         ${promptSource}`);
    if (manifest.agent?.system_prompt) {
      const promptPreview = manifest.agent.system_prompt.split('\n')[0].substring(0, 60);
      console.log(`   Prompt Preview: "${promptPreview}..."`);
    }
  }

  const embedder = createEmbedder({
    model: embeddingModel,
    dimension: embeddingDim
  });

  const store = new SqliteStore({
    dbPath: indexPath,
    dimension: embeddingDim
  });

  store.init(false);

  let examples: ExampleQuestion[] | undefined;
  if (args.examples) {
    const examplesPath = path.resolve(args.examples);
    try {
      examples = loadExamples(examplesPath);
      if (verbose) console.log(`   Examples:  ${examples.length} from ${examplesPath}`);
    } catch (err) {
      console.warn(`⚠️  Could not load examples from ${examplesPath}: ${(err as Error).message}`);
    }
  }

  return { embedder, store, manifest, agentModel, maxIterations, footnoteDir, verbose: args.verbose, examples };
}

/**
 * Run a question and return structured result (for API use)
 */
async function askQuestion(
  question: string,
  app: AppContext,
  options: { verbose?: boolean; showChunks?: boolean } = {}
): Promise<{ answer: string; references: ReturnType<typeof getReferencesData> }> {
  const ctx: AgentContext = {
    embedder: app.embedder,
    store: app.store,
    manifest: app.manifest,
    model: app.agentModel,
    verbose: options.verbose || false,
    searchResults: new Map(),
    resultOrder: [],
    showChunks: options.showChunks || false,
    footnoteDir: app.footnoteDir,
    debugDir: path.join(app.footnoteDir, 'debug')
  };

  const answer = await runAgent(question, ctx, app.maxIterations);
  const references = getReferencesData(ctx);

  return { answer, references };
}

/** Escape HTML entities for server-rendered pages */
function escapeHtmlServer(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Strip HTML tags from a string */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/** Anchor slug (mirrors client-side slugify) */
function slugifyServer(heading: string): string {
  return stripHtml(heading).toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Configure marked to use clean heading IDs (strip inline HTML like mammoth anchor tags)
marked.use({
  renderer: {
    heading({ text, depth }: { text: string; depth: number }) {
      const clean = stripHtml(text);
      const id = slugifyServer(clean);
      return `<h${depth} id="${id}">${clean}</h${depth}>\n`;
    }
  }
});

/**
 * Start HTTP server for API access
 */
async function startServer(app: AppContext, port: number, host: string = '127.0.0.1'): Promise<void> {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // Static UI files
    const uiDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'ui');
    const staticFiles: Record<string, { file: string; type: string }> = {
      '/': { file: 'index.html', type: 'text/html' },
      '/index.html': { file: 'index.html', type: 'text/html' },
      '/style.css': { file: 'style.css', type: 'text/css' },
      '/script.js': { file: 'script.js', type: 'application/javascript' }
    };

    const staticMatch = staticFiles[url.pathname];
    if (staticMatch && req.method === 'GET') {
      const filePath = path.join(uiDir, staticMatch.file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': staticMatch.type });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error loading ${staticMatch.file}`);
      }
      return;
    }

    // Avoid browser favicon 404 noise when no icon is provided.
    if (url.pathname === '/favicon.ico' && req.method === 'GET') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Optional suggested questions (provided via --examples <yaml>), rendered
    // on the main page below the ask box.
    if (url.pathname === '/examples' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ examples: app.examples || [] }));
      return;
    }

    // Document tree browser
    if (url.pathname === '/browse' && req.method === 'GET') {
      const docs = app.store.listDocuments();

      // Build a path-prefix tree so we can render folder groupings
      type TreeNode = { title: string; url: string; children: Map<string, TreeNode> };
      const root: TreeNode = { title: '', url: '', children: new Map() };

      for (const doc of docs) {
        const parts = doc.url.replace(/^\/|\/$|^\//g, '').split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          if (!node.children.has(seg)) {
            node.children.set(seg, { title: seg, url: '', children: new Map() });
          }
          node = node.children.get(seg)!;
        }
        const leaf = parts[parts.length - 1] || parts[parts.length - 2] || doc.doc_id;
        node.children.set(doc.url, { title: doc.title, url: doc.url, children: new Map() });
      }

      function renderTree(node: TreeNode, depth: number): string {
        let html = depth === 0 ? '<ul class="tree root">' : '<ul class="tree">';
        for (const [, child] of node.children) {
          if (child.url) {
            html += `<li class="doc"><a href="${escapeHtmlServer(child.url)}">${escapeHtmlServer(child.title)}</a></li>`;
          } else {
            html += `<li class="folder"><span class="folder-name">${escapeHtmlServer(child.title)}/</span>${renderTree(child, depth + 1)}</li>`;
          }
        }
        html += '</ul>';
        return html;
      }

      const treeHtml = renderTree(root, 0);
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Browse – Melvil FOOTNOTE</title>
  <link rel="icon" href="data:,">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           max-width: 860px; margin: 0 auto; padding: 20px 24px; color: #333; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back { display: inline-block; margin-bottom: 16px; font-size: 0.9em; color: #666; }
    .back:hover { color: #333; }
    h1 { font-size: 1.4em; margin: 0 0 4px 0; }
    .meta { font-size: 0.8em; color: #999; margin-bottom: 20px; }
    input[type=search] { width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid #ddd;
                         border-radius: 6px; margin-bottom: 16px; box-sizing: border-box; }
    ul.tree { list-style: none; margin: 0; padding-left: 18px; }
    ul.root { padding-left: 0; }
    li.doc { padding: 3px 0; }
    li.folder { padding: 4px 0; }
    .folder-name { font-weight: 600; color: #555; font-size: 0.9em; }
    li { border-left: 1px solid #eee; padding-left: 10px; }
    ul.root > li { border-left: none; padding-left: 0; }
  </style>
</head>
<body>
  <a href="/" class="back">← Back to search</a>
  <h1>📂 Browse Documents</h1>
  <div class="meta">${docs.length} documents indexed</div>
  <input type="search" id="filter" placeholder="Filter documents…" oninput="filterTree(this.value)">
  <div id="tree">${treeHtml}</div>
  <script>
    const allItems = Array.from(document.querySelectorAll('li.doc'));
    function filterTree(q) {
      const lq = q.toLowerCase();
      allItems.forEach(li => {
        li.style.display = !lq || li.textContent.toLowerCase().includes(lq) ? '' : 'none';
      });
    }
    document.getElementById('filter').focus();
  <\/script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // Health check (also serves stats for UI)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        docCount: app.manifest.doc_count,
        chunkCount: app.manifest.chunk_count,
        model: app.agentModel,
        baseUrl: app.manifest.base_url || '',
        hasExamples: !!(app.examples && app.examples.length > 0)
      }));
      return;
    }

    // Streaming ask endpoint - Server-Sent Events
    if (url.pathname === '/ask/stream') {
      try {
        let question: string | null = null;

        if (req.method === 'GET') {
          question = url.searchParams.get('q');
        } else if (req.method === 'POST') {
          const body = await new Promise<string>((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });
          const json = JSON.parse(body);
          question = json.question || json.q;
        }

        if (!question) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing question' }));
          return;
        }

        const ts = () => new Date().toISOString();
        console.log(`\n[${ts()}] ═══════════════════════════════════════════════════════════════`);
        console.log(`[${ts()}] 📝 QUERY: ${question}`);
        console.log(`[${ts()}] ═══════════════════════════════════════════════════════════════`);

        // Set up SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const ctx: AgentContext = {
          embedder: app.embedder,
          store: app.store,
          manifest: app.manifest,
          model: app.agentModel,
          verbose: app.verbose,
          searchResults: new Map(),
          resultOrder: [],
          showChunks: false,  // Don't dump full chunks - too noisy
          footnoteDir: app.footnoteDir,
          debugDir: path.join(app.footnoteDir, 'debug')
        };

        // Stream events with verbose logging
        let fullAnswer = '';
        let iterationNum = 0;
        let debugFilename = '';  // Track for logging
        for await (const event of runAgentStream(question, ctx, app.maxIterations)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          
          // Verbose server-side logging
          if (app.verbose) {
            switch (event.type) {
              case 'start':
                if (event.debugFile) {
                  debugFilename = event.debugFile;
                  console.log(`[${ts()}] 🗂️  Debug file: ${debugFilename}`);
                }
                break;
              case 'thinking':
                if (event.message.includes('iteration')) {
                  iterationNum++;
                  console.log(`[${ts()}] ───────────────────────────────────────────────────────────────`);
                  console.log(`[${ts()}] 🔄 ITERATION ${iterationNum}: ${event.message}`);
                } else {
                  console.log(`[${ts()}] 🔄 ${event.message}`);
                }
                break;
              case 'tool_call':
                console.log(`[${ts()}]    → ${event.tool}("${event.query}")`);
                break;
              case 'tool_result':
                if (event.tool === 'pre-search') {
                  console.log(`[${ts()}]    📋 Pre-search found ${event.resultCount} related documents`);
                } else {
                  console.log(`[${ts()}]    ← ${event.resultCount} results`);
                }
                break;
              case 'token':
                fullAnswer += event.content;
                break;
              case 'done':
                console.log(`[${ts()}] ───────────────────────────────────────────────────────────────`);
                console.log(`[${ts()}] ✅ COMPLETE (${ctx.resultOrder.length} documents consulted)`);
                break;
              case 'error':
                console.log(`[${ts()}] ❌ ERROR: ${event.message}`);
                break;
            }
          }
        }
        
        // Log final answer in verbose mode (full, no truncation for debugging)
        if (app.verbose && fullAnswer) {
          const lines = fullAnswer.trim().split('\n');
          console.log(`[${ts()}] 📝 ANSWER (${lines.length} lines):`);
          for (const line of lines) {
            console.log(`[${ts()}]    ${line}`);
          }
          console.log(`[${ts()}] ═══════════════════════════════════════════════════════════════\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        console.error('Stream error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' })}\n\n`);
        res.end();
      }
      return;
    }

    // Ask endpoint - GET /ask?q=question or POST /ask with JSON body
    if (url.pathname === '/ask') {
      try {
        let question: string | null = null;

        if (req.method === 'GET') {
          question = url.searchParams.get('q');
        } else if (req.method === 'POST') {
          const body = await new Promise<string>((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });
          const json = JSON.parse(body);
          question = json.question || json.q;
        }

        if (!question) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing question. Use ?q=... or POST {"question": "..."}' }));
          return;
        }

        const ts = () => new Date().toISOString();
        console.log(`[${ts()}] Question: ${question.substring(0, 80)}${question.length > 80 ? '...' : ''}`);

        const result = await askQuestion(question, app, { verbose: app.verbose });

        // Verbose logging
        if (app.verbose) {
          console.log(`[${ts()}]   ✅ Complete (${result.references.length} refs)`);
          console.log(`[${ts()}]   📝 Response:`);
          const lines = result.answer.trim().split('\n');
          for (const line of lines) {
            console.log(`[${ts()}]      ${line}`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        console.error('Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
      }
      return;
    }

    // Report endpoint - POST /report to flag bad outcomes
    if (url.pathname === '/report' && req.method === 'POST') {
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        const json = JSON.parse(body);
        const { debugFile, reportToken, comment } = json;

        if (!debugFile) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing debugFile' }));
          return;
        }

        if (!reportToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing reportToken' }));
          return;
        }

        const debugDir = path.join(app.footnoteDir, 'debug');
        const originalPath = path.join(debugDir, debugFile);

        // Check if file exists
        if (!fs.existsSync(originalPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Debug file not found' }));
          return;
        }

        // Read existing debug data
        const debugData = JSON.parse(fs.readFileSync(originalPath, 'utf-8'));

        // Validate the report token matches - only the browser that received the answer can report
        if (debugData.metadata?.reportToken !== reportToken) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid report token' }));
          return;
        }

        // Add report metadata at the top of the object
        const reportedData = {
          reported: {
            timestamp: new Date().toISOString(),
            comment: comment || null,
            reason: 'User flagged as bad outcome'
          },
          ...debugData
        };

        // Rename file with 'reported-' prefix
        const reportedFilename = 'reported-' + debugFile;
        const reportedPath = path.join(debugDir, reportedFilename);

        // Write updated data to new file
        fs.writeFileSync(reportedPath, JSON.stringify(reportedData, null, 2));

        // Remove original file
        fs.unlinkSync(originalPath);

        const ts = () => new Date().toISOString();
        console.log(`[${ts()}] 👎 Reported: ${reportedPath}`);
        if (comment) {
          console.log(`[${ts()}]    Comment: ${comment}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          reportedFile: reportedFilename,
          message: 'Thank you for your feedback. This helps improve the system.'
        }));
      } catch (error) {
        console.error('Report error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
      }
      return;
    }

    // File download: serve original source file by its relative path
    if (url.pathname.startsWith('/file/') && req.method === 'GET') {
      const relPath = decodeURIComponent(url.pathname.slice('/file/'.length));
      const contentRoot = path.dirname(path.resolve(app.footnoteDir));
      const filePath = path.resolve(contentRoot, relPath);
      // Prevent path traversal
      if (!filePath.startsWith(contentRoot + path.sep) && filePath !== contentRoot) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
      };
      // Types that browsers can display natively — serve inline
      const inlineTypes = new Set(['.pdf', '.txt', '.md']);
      const mime = mimeTypes[ext] ?? 'application/octet-stream';
      try {
        const data = fs.readFileSync(filePath);
        const filename = encodeURIComponent(path.basename(filePath));
        const disposition = inlineTypes.has(ext)
          ? `inline; filename="${path.basename(filePath)}"; filename*=UTF-8''${filename}`
          : `attachment; filename="${path.basename(filePath)}"; filename*=UTF-8''${filename}`;
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': disposition,
          'Content-Length': String(data.length),
        });
        res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      }
      return;
    }

    // Document viewer: try to resolve any other GET path as a document URL
    if (req.method === 'GET') {
      // Normalize: decode URI encoding, strip known extensions (with optional trailing slash), ensure trailing slash
      let docPath = decodeURIComponent(url.pathname).replace(/\.(md|txt|pdf|docx)\/?$/i, '/');
      if (!docPath.endsWith('/')) docPath += '/';
      const chunks = app.store.getDocumentChunks(docPath);
      if (chunks.length > 0) {
        const doc = chunks[0];
        // Reconstruct document with headings from heading path
        let prevPath: string[] = [];
        const parts: string[] = [];
        for (const chunk of chunks) {
          const path = chunk.headings;
          // Find where path diverges from previous (default: where prevPath ends)
          let divergeAt = prevPath.length;
          for (let i = 0; i < Math.min(path.length, prevPath.length); i++) {
            if (path[i] !== prevPath[i]) { divergeAt = i; break; }
          }
          if (divergeAt < path.length) {
            for (let i = divergeAt; i < path.length; i++) {
              parts.push(`${'#'.repeat(i + 1)} ${path[i]}`);
            }
          }
          prevPath = path;
          parts.push(chunk.content);
        }
        const fullContent = parts.join('\n\n');
        const title = escapeHtmlServer(doc.title);
        // Build download link for non-markdown source files
        const srcExt = path.extname(doc.path).toLowerCase();
        const downloadableExts = new Set(['.pdf', '.docx']);
        const inlineExts = new Set(['.pdf']);
        const fileUrl = `/file/${encodeURIComponent(doc.path).replace(/%2F/g, '/')}`;
        const downloadLink = downloadableExts.has(srcExt)
          ? (inlineExts.has(srcExt)
            ? `<a class="download" href="${fileUrl}" target="_blank">📄 View PDF</a>`
            : `<a class="download" href="${fileUrl}">⬇ Download ${srcExt.slice(1).toUpperCase()}</a>`)
          : '';
        const headingsList = chunks
          .flatMap(c => c.headings.map(h => {
            const clean = stripHtml(h);
            return `<li><a href="#${slugifyServer(clean)}">${escapeHtmlServer(clean)}</a></li>`;
          }))
          .filter((v, i, a) => a.indexOf(v) === i)
          .join('\n');
        const tocHtml = headingsList ? `<nav class="toc"><h2>Contents</h2><ul>${headingsList}</ul></nav>` : '';

        // Render markdown content as HTML
        const rendered = await marked.parse(fullContent, { async: true });

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="icon" href="data:,">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           max-width: 860px; margin: 0 auto; padding: 20px 24px; color: #333; line-height: 1.7; }
    a { color: #0066cc; }
    pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow-x: auto; }
    code { font-size: 0.88em; }
    pre code { background: none; padding: 0; }
    .back { display: inline-block; margin-bottom: 20px; font-size: 0.9em; color: #666; text-decoration: none; }
    .back:hover { color: #333; }
    .download { display: inline-block; margin-left: 16px; font-size: 0.85em; color: #0066cc; text-decoration: none; vertical-align: middle; }
    .download:hover { text-decoration: underline; }
    .meta { font-size: 0.8em; color: #999; margin-bottom: 24px; border-bottom: 1px solid #eee; padding-bottom: 12px; }
    .toc { background: #f8f9fa; border-radius: 6px; padding: 12px 20px; margin-bottom: 24px; font-size: 0.9em; }
    .toc h2 { margin: 0 0 8px 0; font-size: 1em; color: #555; }
    .toc ul { margin: 0; padding-left: 1.2em; }
    .toc li { margin: 2px 0; }
    h1,h2,h3,h4 { margin-top: 1.5em; }
    h1:first-of-type { margin-top: 0; }
  </style>
</head>
<body>
  <a href="/" class="back">← Back to search</a>
  <h1>${title}${downloadLink}</h1>
  <div class="meta">URL: ${escapeHtmlServer(docPath)}</div>
  ${tocHtml}
  <div class="doc-content">${rendered}</div>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Try GET /ask?q=question or POST /ask' }));
  });

  // Start debug file cleanup timer
  const debugDir = path.join(app.footnoteDir, 'debug');
  const cleanupTimer = startDebugCleanupTimer(debugDir, app.verbose);

  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`\n🚀 docidx API server running at http://${displayHost}:${port}/ (bound to ${host})`);
    console.log(`   Model: ${app.agentModel}`);
    console.log(`   Index: ${app.manifest.doc_count} docs, ${app.manifest.chunk_count} chunks`);
    console.log(`   Debug: ${debugDir} (cleanup: 10min, max age: 1 week)`);
    console.log(`\nEndpoints:`);
    console.log(`   GET  /              - Web UI`);
    console.log(`   GET  /health        - Health check`);
    console.log(`   GET  /ask?q=...     - Ask (JSON response)`);
    console.log(`   GET  /ask/stream?q= - Ask (streaming SSE)`);
    console.log(`   POST /ask           - Ask with JSON body`);
    console.log(`   POST /report        - Report bad outcome`);
    console.log('');
  });

  // Cleanup timer on server close
  server.on('close', () => {
    clearInterval(cleanupTimer);
  });
}

async function main(): Promise<void> {
  try {
    const app = await initializeApp();

    // Server mode
    if (args.serve) {
      const port = parseInt(args.port, 10) || 3000;
      const host = args.host || '127.0.0.1';
      await startServer(app, port, host);
      return;
    }

    // CLI mode: run question helper
    const runQuestion = async (question: string): Promise<void> => {
      const ctx: AgentContext = {
        embedder: app.embedder,
        store: app.store,
        manifest: app.manifest,
        model: app.agentModel,
        verbose: args.verbose,
        searchResults: new Map(),
        resultOrder: [],
        showChunks: args.chunks,
        footnoteDir: app.footnoteDir,
        debugDir: path.join(app.footnoteDir, 'debug')
      };

      console.log('\n' + '─'.repeat(60));
      
      const answer = await runAgent(question, ctx, app.maxIterations);
      
      console.log('\n' + answer);
      console.log(formatReferences(ctx));
      console.log('');
    };

    // Single query mode
    if (cliQuery) {
      await runQuestion(cliQuery);
      app.store.close();
      process.exit(0);
    }

    // Interactive mode
    console.log(`\n🤖 Documentation Assistant (Agent Mode)`);
    console.log(`   Model: ${app.agentModel}`);
    console.log(`   Index: ${app.manifest.doc_count} docs, ${app.manifest.chunk_count} chunks`);
    console.log(`\n   Ask questions naturally. The agent will search for answers.`);
    console.log(`   Type 'quit' to exit.\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const prompt = (): void => {
      rl.question('❓ ', async (query) => {
        query = query.trim();

        if (query.toLowerCase() === 'quit' || query.toLowerCase() === 'exit') {
          console.log('\nGoodbye! 👋\n');
          app.store.close();
          rl.close();
          process.exit(0);
        }

        if (!query) {
          prompt();
          return;
        }

        try {
          await runQuestion(query);
        } catch (error) {
          console.error(`\n❌ Error: ${error instanceof Error ? error.message : error}\n`);
        }

        prompt();
      });
    };

    rl.on('close', () => {
      app.store.close();
      process.exit(0);
    });

    prompt();

  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error}`);
  process.exit(1);
});
