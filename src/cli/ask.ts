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
import { execSync } from 'child_process';
import minimist from 'minimist';

import { createEmbedder, Embedder } from '../embedder/embedder.js';
import { SqliteStore } from '../storage/sqlite.js';
import { readManifest, DEFAULT_SYSTEM_PROMPT, ManifestData } from '../storage/manifest.js';
import { loadProjectConfig, resolveContentRoot } from '../config/index.js';

const args = minimist(process.argv.slice(2), {
  string: ['db', 'model', 'port'],
  boolean: ['verbose', 'interactive', 'chunks', 'serve'],
  alias: { v: 'verbose', i: 'interactive', c: 'chunks', s: 'serve', p: 'port' },
  default: {
    db: '',  // Empty = auto-detect from project root
    model: '',  // Empty = use manifest default or fallback
    verbose: false,
    interactive: false,
    chunks: false,  // Show full chunk content
    serve: false,
    port: '3000'
  }
});

const cliQuery = args._[0] || null;


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
- Citations like [1], [2] MUST reference actual search results you received.
- If you need to search, output ONLY the tool call. If you're ready to answer, start with FINAL:`;

/**
 * Build the system prompt by interpolating {{TOOLS}} placeholder with actual tools definition
 * and appending the FINAL: directive for reliable answer detection.
 */
function buildSystemPrompt(manifest: ManifestData): string {
  const template = manifest.agent?.system_prompt || DEFAULT_SYSTEM_PROMPT;
  const toolsDefinition = buildToolsDefinition(manifest);
  const basePrompt = template.replace('{{TOOLS}}', toolsDefinition.trim());
  // Always append the final answer directive for reliable detection
  return basePrompt + FINAL_ANSWER_DIRECTIVE;
}

interface SearchResult {
  chunk_id: string;
  doc_id: string;
  url: string;
  title: string;
  headings: string[];
  content: string;
  score: number;
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
  artipodDir: string;  // Path to artipod directory (for grep search)
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
        method: 'literal' as const,
        ftsRank: i + 1  // Use ftsRank for display consistency
      }));
      break;
    }

    case 'read_document': {
      const docIdentifier = doc_id || query;
      if (!docIdentifier) return errorResult('Error: read_document requires a doc_id');
      
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
      const docIdentifier = doc_id || query;
      if (!docIdentifier) return errorResult('Error: find_related requires a doc_id');
      
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
      
      const contentDir = path.join(ctx.artipodDir, 'content');
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

  // Format results for the LLM
  const formatted = results.map((r, i) => {
    const globalIdx = ctx.resultOrder.indexOf(r.chunk_id) + 1;
    const location = r.headings.length > 0
      ? `${r.title} > ${r.headings.join(' > ')}`
      : r.title;
    const snippet = r.content.replace(/\n+/g, ' ').slice(0, 500);
    return `[${globalIdx}] ${location}\n    URL: ${r.url}\n    ${snippet}${r.content.length > 500 ? '...' : ''}`;
  }).join('\n\n');

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
 * Call Ollama for chat completion (non-streaming)
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
 * Call Ollama with streaming - yields tokens as they arrive
 */
async function* chatStream(
  messages: Array<{ role: string; content: string }>,
  model: string
): AsyncGenerator<string, string, unknown> {
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
 * Event types for streaming responses
 */
type StreamEvent = 
  | { type: 'thinking'; message: string }
  | { type: 'tool_call'; tool: string; query: string }
  | { type: 'tool_result'; tool: string; resultCount: number; chunks: Array<{ title: string; url: string; headings: string[]; snippet: string }> }
  | { type: 'token'; content: string }
  | { type: 'done'; references: ReturnType<typeof getReferencesData> }
  | { type: 'error'; message: string };

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
  const systemPrompt = buildSystemPrompt(ctx.manifest);

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question }
  ];

  // Track all accumulated thinking across iterations
  let allThinking = '';
  // Track actual search iterations (not including retries for protocol compliance)
  let searchIteration = 0;

  for (let i = 0; i < maxIterations; i++) {
    // Emit thinking status at start of first iteration only
    if (i === 0) {
      yield { type: 'thinking', message: 'Analyzing question...' };
    }
    
    let response = '';
    let foundFinal = false;
    let finalAnswerBuffer = '';
    
    try {
      // Stream the LLM response, buffering until complete
      // We DON'T stream tokens yet - we need to check if we should force a retry first
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
          // DON'T stream yet - wait until we verify we won't retry
        } else if (foundFinal) {
          // Accumulate the answer but don't stream yet
          finalAnswerBuffer += token;
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

    // If we found FINAL: but haven't searched yet, force a retry (up to 2 attempts)
    if (foundFinal && ctx.searchResults.size === 0 && i < 2) {
      if (ctx.verbose) {
        console.log(`[${new Date().toISOString()}] ⚠️ LLM tried to answer without searching - forcing retry (attempt ${i + 1})`);
        console.log(`[${new Date().toISOString()}]    LLM response was:`);
        // Show truncated response for debugging
        const truncated = response.length > 500 ? response.slice(0, 500) + '...' : response;
        truncated.split('\n').forEach(line => console.log(`[${new Date().toISOString()}]    | ${line}`));
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
          console.log(`[${new Date().toISOString()}]    LLM final response was:`);
          const truncated = response.length > 500 ? response.slice(0, 500) + '...' : response;
          truncated.split('\n').forEach(line => console.log(`[${new Date().toISOString()}]    | ${line}`));
        }
        // Extract likely search terms from the question
        const searchQuery = question.replace(/^(what|how|why|when|where|who|is|are|do|does|can|could|would|should)\s+/i, '').slice(0, 50);
        yield { type: 'thinking', message: 'Searching documentation...' };
        yield { type: 'tool_call', tool: 'search_hybrid', query: searchQuery };
        const result = await executeTool({ tool: 'search_hybrid', query: searchQuery, limit: 5 }, ctx);
        yield { type: 'tool_result', tool: 'search_hybrid', resultCount: result.chunks.length, chunks: result.chunks };
      }
      // NOW emit the buffered answer (after we've verified no retry needed)
      if (finalAnswerBuffer) {
        yield { type: 'token', content: finalAnswerBuffer };
      }
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
        yield { type: 'token', content: answer };
      }
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
    messages.push({ role: 'user', content: `Tool results:\n\n${toolResults.join('\n\n---\n\n')}\n\nBased on these results, provide your final answer. Remember to prefix it with FINAL:` });
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
          yield { type: 'token', content: answer };
        }
      }
      
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
    yield { type: 'token', content: fallbackAnswer };
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
    messages.push({ role: 'user', content: `Tool results:\n\n${toolResults.join('\n\n---\n\n')}\n\nBased on these results, provide your final answer. Remember to prefix it with FINAL:` });
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
  artipodDir: string;
  verbose: boolean;
}

async function initializeApp(): Promise<AppContext> {
  const verbose = args.verbose;
  
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

  if (verbose) {
    console.log(`\n📂 Configuration:`);
    console.log(`   Artipod:   ${artipodDir}`);
    console.log(`   Index:     ${indexPath}`);
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

  // Determine agent model: CLI arg > manifest config > default
  const agentModel = args.model || manifest.agent?.model || 'llama3.2';
  const maxIterations = manifest.agent?.max_iterations || 5;
  
  // Determine prompt source
  const promptSource = manifest.agent?.system_prompt 
    ? 'manifest.json (custom)' 
    : 'DEFAULT_SYSTEM_PROMPT (built-in)';

  if (verbose) {
    console.log(`\n🤖 Agent Configuration:`);
    console.log(`   Model:          ${agentModel}${args.model ? ' (from CLI)' : manifest.agent?.model ? ' (from manifest)' : ' (default)'}`);
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

  return { embedder, store, manifest, agentModel, maxIterations, artipodDir, verbose: args.verbose };
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
    artipodDir: app.artipodDir
  };

  const answer = await runAgent(question, ctx, app.maxIterations);
  const references = getReferencesData(ctx);

  return { answer, references };
}

/**
 * Start HTTP server for API access
 */
async function startServer(app: AppContext, port: number): Promise<void> {
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

    // Health check (also serves stats for UI)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        docCount: app.manifest.doc_count,
        chunkCount: app.manifest.chunk_count,
        model: app.agentModel
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
          artipodDir: app.artipodDir
        };

        // Stream events with verbose logging
        let fullAnswer = '';
        let iterationNum = 0;
        for await (const event of runAgentStream(question, ctx, app.maxIterations)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          
          // Verbose server-side logging
          if (app.verbose) {
            switch (event.type) {
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
                console.log(`[${ts()}]    ← ${event.resultCount} results`);
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

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Try GET /ask?q=question or POST /ask' }));
  });

  server.listen(port, () => {
    console.log(`\n🚀 docidx API server running at http://localhost:${port}/`);
    console.log(`   Model: ${app.agentModel}`);
    console.log(`   Index: ${app.manifest.doc_count} docs, ${app.manifest.chunk_count} chunks`);
    console.log(`\nEndpoints:`);
    console.log(`   GET  /              - Web UI`);
    console.log(`   GET  /health        - Health check`);
    console.log(`   GET  /ask?q=...     - Ask (JSON response)`);
    console.log(`   GET  /ask/stream?q= - Ask (streaming SSE)`);
    console.log(`   POST /ask           - Ask with JSON body`);
    console.log('');
  });
}

async function main(): Promise<void> {
  try {
    const app = await initializeApp();

    // Server mode
    if (args.serve) {
      const port = parseInt(args.port, 10) || 3000;
      await startServer(app, port);
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
        artipodDir: app.artipodDir
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
