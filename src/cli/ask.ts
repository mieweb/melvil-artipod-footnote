#!/usr/bin/env npx tsx
/**
 * Ask Agent CLI
 * 
 * An agentic RAG assistant that can use tools to search documentation.
 * The LLM decides which search strategies to use based on the question.
 * 
 * Usage: npx tsx src/cli/ask.ts "your question here"
 */
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import minimist from 'minimist';

import { createEmbedder, Embedder } from '../embedder/embedder.js';
import { SqliteStore } from '../storage/sqlite.js';
import { readManifest, DEFAULT_SYSTEM_PROMPT, ManifestData } from '../storage/manifest.js';
import { loadProjectConfig, resolveContentRoot } from '../config/index.js';

const args = minimist(process.argv.slice(2), {
  string: ['db', 'model'],
  boolean: ['verbose', 'interactive'],
  alias: { v: 'verbose', i: 'interactive' },
  default: {
    db: '',  // Empty = auto-detect from project root
    model: '',  // Empty = use manifest default or fallback
    verbose: false,
    interactive: false
  }
});

const cliQuery = args._[0] || null;

/**
 * Tool definitions for the LLM - generic, not application-specific
 * These describe the search capabilities available in any docidx index.
 */
const TOOLS_DEFINITION = `
You have access to the following tools to search documentation:

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

To use a tool, respond with a JSON block:
\`\`\`tool
{"tool": "search_fts", "query": "some search term", "limit": 5}
\`\`\`

You can call multiple tools in sequence. After gathering enough information, provide your final answer.
When answering, cite sources using [1], [2], etc. matching the document numbers in the search results.
`;

/**
 * Build the system prompt by interpolating {{TOOLS}} placeholder with actual tools definition
 */
function buildSystemPrompt(manifest: ManifestData): string {
  const template = manifest.agent?.system_prompt || DEFAULT_SYSTEM_PROMPT;
  return template.replace('{{TOOLS}}', TOOLS_DEFINITION.trim());
}

interface SearchResult {
  chunk_id: string;
  doc_id: string;
  url: string;
  title: string;
  headings: string[];
  content: string;
  score: number;
  method: 'hybrid' | 'fts' | 'literal';
  vectorRank?: number;
  ftsRank?: number;
}

interface ToolCall {
  tool: string;
  query: string;
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
}

/**
 * Execute a tool call and return formatted results
 */
async function executeTool(toolCall: ToolCall, ctx: AgentContext): Promise<string> {
  const { tool, query, limit = 5 } = toolCall;
  let results: SearchResult[] = [];

  if (ctx.verbose) {
    console.log(`   🔧 ${tool}("${query}", ${limit})`);
  }

  switch (tool) {
    case 'search_hybrid': {
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
        method: 'hybrid' as const,
        vectorRank: r.vectorRank,
        ftsRank: r.ftsRank
      }));
      break;
    }
    
    case 'search_fts': {
      const ftsResults = ctx.store.ftsSearch(query, limit);
      results = ftsResults.map((r, i) => ({
        chunk_id: r.chunk_id,
        doc_id: r.doc_id,
        url: r.url,
        title: r.title,
        headings: r.headings,
        content: r.content,
        score: -r.bm25Score,
        method: 'fts' as const,
        ftsRank: i + 1
      }));
      break;
    }
    
    case 'search_literal': {
      const literalResults = ctx.store.literalSearch(query, limit);
      results = literalResults.map((r, i) => ({
        chunk_id: r.chunk_id,
        doc_id: r.doc_id,
        url: r.url,
        title: r.title,
        headings: r.headings,
        content: r.content,
        score: r.matchCount,
        method: 'literal' as const,
        ftsRank: i + 1  // Use ftsRank for display consistency
      }));
      break;
    }
    
    default:
      return `Error: Unknown tool "${tool}"`;
  }

  if (results.length === 0) {
    return `No results found for "${query}"`;
  }

  // Add results to context (deduplicated)
  for (const r of results) {
    if (!ctx.searchResults.has(r.chunk_id)) {
      ctx.searchResults.set(r.chunk_id, r);
      ctx.resultOrder.push(r.chunk_id);
    }
  }

  // Format results for the LLM
  const formatted = results.map((r, i) => {
    const globalIdx = ctx.resultOrder.indexOf(r.chunk_id) + 1;
    const location = r.headings.length > 0
      ? `${r.title} > ${r.headings.join(' > ')}`
      : r.title;
    const snippet = r.content.replace(/\n+/g, ' ').slice(0, 500);
    return `[${globalIdx}] ${location}\n    URL: ${r.url}\n    ${snippet}${r.content.length > 500 ? '...' : ''}`;
  }).join('\n\n');

  return `Found ${results.length} results:\n\n${formatted}`;
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
      if (parsed.tool && parsed.query) {
        toolCalls.push(parsed);
      }
    } catch {
      // Invalid JSON, skip
    }
  }
  
  // Also try bare JSON objects with "tool" key
  if (toolCalls.length === 0) {
    const jsonRegex = /\{[^{}]*"tool"\s*:\s*"[^"]+"\s*,\s*"query"\s*:\s*"[^"]*"[^{}]*\}/g;
    while ((match = jsonRegex.exec(response)) !== null) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.tool && parsed.query) {
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
 * Call Ollama for chat completion
 */
async function chat(
  messages: Array<{ role: string; content: string }>,
  model: string
): Promise<string> {
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
 * Run the agent loop
 */
async function runAgent(
  question: string,
  ctx: AgentContext,
  maxIterations: number = 5
): Promise<string> {
  // Build system prompt from manifest (with {{TOOLS}} interpolation)
  const systemPrompt = buildSystemPrompt(ctx.manifest);

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question }
  ];

  if (ctx.verbose) {
    console.log(`\n🤖 Agent starting...`);
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

    // Check for tool calls
    const toolCalls = parseToolCalls(response);
    
    if (toolCalls.length === 0) {
      // No tool calls - this is the final answer
      return extractAnswer(response);
    }

    // Execute tool calls
    const toolResults: string[] = [];
    for (const tc of toolCalls) {
      const result = await executeTool(tc, ctx);
      toolResults.push(`Tool: ${tc.tool}("${tc.query}")\n${result}`);
    }

    // Add assistant response and tool results to conversation
    messages.push({ role: 'assistant', content: response });
    messages.push({ role: 'user', content: `Tool results:\n\n${toolResults.join('\n\n---\n\n')}\n\nBased on these results, please provide your answer (or search again if needed).` });
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

async function main(): Promise<void> {
  // Auto-detect artipod directory from project config if not specified
  let artipodDir = args.db;
  if (!artipodDir) {
    // Try to find artipod in project root
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

  if (!fs.existsSync(indexPath)) {
    console.error(`❌ Index not found: ${indexPath}`);
    console.error(`   Run 'docidx build' first to create an index.`);
    process.exit(1);
  }

  const manifest = readManifest(manifestPath);
  if (!manifest) {
    console.error(`❌ Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  let embeddingModel = manifest.embedding.model_id;
  if (manifest.embedding.provider === 'mock') {
    embeddingModel = 'mock';
  }
  const embeddingDim = manifest.embedding.dimension;

  // Determine agent model: CLI arg > manifest config > default
  const agentModel = args.model || manifest.agent?.model || 'llama3.2';
  const maxIterations = manifest.agent?.max_iterations || 5;

  const embedder = createEmbedder({
    model: embeddingModel,
    dimension: embeddingDim
  });

  const store = new SqliteStore({
    dbPath: indexPath,
    dimension: embeddingDim
  });

  store.init(false);

  const runQuestion = async (question: string): Promise<void> => {
    const ctx: AgentContext = {
      embedder,
      store,
      manifest,
      model: agentModel,
      verbose: args.verbose,
      searchResults: new Map(),
      resultOrder: []
    };

    console.log('\n' + '─'.repeat(60));
    
    const answer = await runAgent(question, ctx, maxIterations);
    
    console.log('\n' + answer);
    console.log(formatReferences(ctx));
    console.log('');
  };

  // Single query mode
  if (cliQuery) {
    await runQuestion(cliQuery);
    store.close();
    process.exit(0);
  }

  // Interactive mode
  console.log(`\n🤖 Documentation Assistant (Agent Mode)`);
  console.log(`   Model: ${agentModel}`);
  console.log(`   Index: ${manifest.doc_count} docs, ${manifest.chunk_count} chunks`);
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
        store.close();
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
    store.close();
    process.exit(0);
  });

  prompt();
}

main().catch(error => {
  console.error(`Fatal error: ${error}`);
  process.exit(1);
});
