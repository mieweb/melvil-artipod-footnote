/**
 * Heading-Aware Content Chunker
 * 
 * Splits markdown content into chunks respecting heading boundaries,
 * with configurable max tokens and overlap.
 */
import { createHash } from 'crypto';
import { renderEmbeddingText, embeddingHashInput } from '../render/embedding-text.js';
import { detectAssertion, type AssertionStatus } from '../assertion/assertion.js';
import { extractFindings, type FindingAssertion } from '../assertion/findings.js';

export interface ChunkConfig {
  maxTokens: number;
  overlap: number;
}

export interface Chunk {
  index: number;
  headingPath: string[];
  /** Raw chunk body — used for storage, display, citations, FTS and literal search. */
  content: string;
  /** Hash of the raw body. Stable display/provenance identity for the chunk. */
  contentHash: string;
  /** Context-rendered text that is actually embedded (heading ancestry + assertion cues + body). */
  embeddingText: string;
  /** Hash of embeddingText (with render version) — the embedding cache key. */
  embeddingHash: string;
  /** Chunk-level clinical assertion status (Phase 2) — queryable retrieval metadata. */
  assertion: AssertionStatus;
  /** Per-finding assertions for curated high-risk clinical findings (Phase 2, bullet 2). */
  findings: FindingAssertion[];
  tokenCount: number;
}

/**
 * Simple token estimator (approximately 4 chars per token for English)
 * For production, consider using a proper tokenizer
 */
export function estimateTokens(text: string): number {
  // More accurate estimation based on whitespace and punctuation
  const words = text.split(/\s+/).filter(w => w.length > 0);
  // Average English word is ~1.3 tokens
  return Math.ceil(words.length * 1.3);
}

/**
 * Generate deterministic hash for content
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Build a complete Chunk from its raw pieces, deriving contentHash and the
 * context-rendered embeddingText / embeddingHash. All chunk construction routes
 * through here so the embedding fields are never forgotten on a return path.
 */
function finalizeChunk(params: {
  index: number;
  headingPath: string[];
  content: string;
  tokenCount: number;
  /** Source document title/basename, folded into embeddingText (not the raw body). */
  docTitle?: string;
}): Chunk {
  const embeddingText = renderEmbeddingText({
    docTitle: params.docTitle,
    headingPath: params.headingPath,
    content: params.content
  });
  const assertion = detectAssertion({
    headingPath: params.headingPath,
    content: params.content
  }).status;
  const findings = extractFindings({
    headingPath: params.headingPath,
    content: params.content
  });
  return {
    index: params.index,
    headingPath: [...params.headingPath],
    content: params.content,
    contentHash: hashContent(params.content),
    embeddingText,
    embeddingHash: hashContent(embeddingHashInput(embeddingText)),
    assertion,
    findings,
    tokenCount: params.tokenCount
  };
}

/**
 * Grammar-aware sentence splitter (chunking direction #2).
 *
 * Splits text into sentence-ish units WITHOUT cutting inside a balanced span:
 * parentheses `()`, brackets `[]`, braces `{}`, double quotes (straight or smart),
 * inline code (backtick), or a fenced code block (``` / ~~~). A split is only taken
 * at "depth 0" — every counter closed and no open quote/code context. A boundary is
 * either a sentence terminator (`.!?`) that is followed by whitespace/end (so decimals
 * like `1.5` and abbreviations mid-token are not cut), or a newline.
 *
 * Fallback: a single balanced span that grows past the size budget (`maxUnitChars`)
 * is force-split at the next whitespace even at depth > 0, so a giant parenthetical,
 * an unbalanced quote, or a huge code block can never produce one unbounded unit.
 *
 * Notes / deliberate limits:
 *  - Single quotes / apostrophes are NOT tracked — in English "don't", "patients'"
 *    would otherwise open phantom quote spans. Only double quotes are balanced.
 *  - An unbalanced delimiter (a stray `"` inch-mark, an unclosed `(`) degrades to the
 *    size-budget fallback rather than swallowing the rest of the text.
 *  - Inline code auto-closes at a newline (markdown inline code never spans lines).
 */
export function splitIntoSentences(text: string, maxUnitChars: number = Infinity): string[] {
  const OPEN: Record<string, 'round' | 'square' | 'curly'> = { '(': 'round', '[': 'square', '{': 'curly' };
  const CLOSE: Record<string, 'round' | 'square' | 'curly'> = { ')': 'round', ']': 'square', '}': 'curly' };

  const units: string[] = [];
  let buf = '';
  const depth = { round: 0, square: 0, curly: 0 };
  let inQuote = false;      // straight or smart double quote
  let inInlineCode = false; // single-backtick span (within a line)
  let inFence = false;      // ``` or ~~~ fenced code block

  const depthZero = () =>
    depth.round === 0 && depth.square === 0 && depth.curly === 0 &&
    !inQuote && !inInlineCode && !inFence;

  const flush = () => {
    const t = buf.trim();
    if (t) units.push(t);
    buf = '';
  };

  const n = text.length;
  let i = 0;
  let atLineStart = true;

  while (i < n) {
    // Fenced code block toggling — detected at the start of a line.
    if (atLineStart && !inInlineCode) {
      let eol = text.indexOf('\n', i);
      if (eol === -1) eol = n;
      if (/^\s*(`{3,}|~{3,})/.test(text.slice(i, eol))) {
        inFence = !inFence;
        buf += text.slice(i, eol); // keep the fence marker line with the code unit
        i = eol;
        atLineStart = false;
        continue;
      }
    }

    const c = text[i];

    // Inside a fence, nothing is a boundary; content is copied verbatim.
    if (inFence) {
      buf += c;
      atLineStart = c === '\n';
      i++;
      if (buf.length >= maxUnitChars && /\s/.test(c)) flush();
      continue;
    }

    // Inline code span (single backtick). Auto-closes at a newline.
    if (c === '`') {
      inInlineCode = !inInlineCode;
      buf += c;
      atLineStart = false;
      i++;
      continue;
    }
    if (inInlineCode) {
      if (c === '\n') inInlineCode = false;
      buf += c;
      atLineStart = c === '\n';
      i++;
      continue;
    }

    // Double quotes: straight toggles; smart quotes are directional.
    if (c === '"') { inQuote = !inQuote; buf += c; atLineStart = false; i++; continue; }
    if (c === '“') { inQuote = true; buf += c; atLineStart = false; i++; continue; }
    if (c === '”') { inQuote = false; buf += c; atLineStart = false; i++; continue; }

    // Bracket depth.
    if (OPEN[c]) { depth[OPEN[c]]++; buf += c; atLineStart = false; i++; continue; }
    if (CLOSE[c]) { if (depth[CLOSE[c]] > 0) depth[CLOSE[c]]--; buf += c; atLineStart = false; i++; continue; }

    // Newline: a boundary only at depth 0.
    if (c === '\n') {
      buf += c;
      atLineStart = true;
      i++;
      if (depthZero()) flush();
      else if (buf.length >= maxUnitChars) flush(); // fallback for an oversized open span
      continue;
    }

    // Sentence terminator: a boundary only at depth 0 AND when followed by whitespace/end
    // (so `1.5`, `e.g.`, `U.S.A` mid-token are not cut).
    if ((c === '.' || c === '!' || c === '?') && depthZero()) {
      let j = i;
      while (j < n && (text[j] === '.' || text[j] === '!' || text[j] === '?')) j++;
      buf += text.slice(i, j);
      const next = j < n ? text[j] : '';
      i = j;
      atLineStart = false;
      if (next === '' || /\s/.test(next)) flush();
      continue;
    }

    // Default: accumulate. Size-budget fallback fires at a whitespace boundary.
    buf += c;
    atLineStart = false;
    i++;
    if (buf.length >= maxUnitChars && /\s/.test(c)) flush();
  }

  flush();
  return units;
}

/**
 * Split text into paragraphs on blank lines — but never break inside a fenced code
 * block (``` / ~~~), whose internal blank lines are part of the code, not paragraph
 * separators. Finer delimiter handling (parens/quotes/inline code) is left to the
 * sentence splitter; paragraph splitting only guards the fence case, which is the one
 * place a blank-line split would corrupt structure.
 */
export function splitIntoParagraphs(text: string): string[] {
  const paras: string[] = [];
  let cur: string[] = [];
  let inFence = false;

  const flush = () => {
    const p = cur.join('\n').trim();
    if (p) paras.push(p);
    cur = [];
  };

  for (const line of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
    } else {
      cur.push(line);
    }
  }
  flush();
  return paras;
}

/**
 * Pack content into chunks with overlap
 */
function packWithOverlap(
  units: string[],
  maxTokens: number,
  overlapTokens: number,
  headingPath: string[],
  docTitle?: string
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentUnits: string[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const unitTokens = estimateTokens(unit);

    // If adding this unit would exceed max tokens, finalize current chunk
    if (currentTokens + unitTokens > maxTokens && currentUnits.length > 0) {
      const content = currentUnits.join('\n\n');
      chunks.push(finalizeChunk({
        index: chunkIndex++,
        headingPath,
        content,
        tokenCount: currentTokens,
        docTitle
      }));

      // Calculate overlap: keep trailing units up to overlapTokens
      let overlapUnits: string[] = [];
      let overlapCount = 0;
      
      for (let j = currentUnits.length - 1; j >= 0 && overlapCount < overlapTokens; j--) {
        const unitToks = estimateTokens(currentUnits[j]);
        if (overlapCount + unitToks <= overlapTokens) {
          overlapUnits.unshift(currentUnits[j]);
          overlapCount += unitToks;
        } else {
          break;
        }
      }

      currentUnits = overlapUnits;
      currentTokens = overlapCount;
    }

    currentUnits.push(unit);
    currentTokens += unitTokens;
  }

  // Final chunk
  if (currentUnits.length > 0) {
    const content = currentUnits.join('\n\n');
    chunks.push(finalizeChunk({
      index: chunkIndex,
      headingPath,
      content,
      tokenCount: currentTokens,
      docTitle
    }));
  }

  return chunks;
}

/**
 * Chunk a section of content
 */
export function chunkSection(
  content: string,
  headingPath: string[],
  config: ChunkConfig,
  startIndex: number = 0,
  docTitle?: string
): Chunk[] {
  const paragraphs = splitIntoParagraphs(content);

  if (paragraphs.length === 0) {
    return [];
  }

  // For small content, just return as single chunk
  const totalTokens = estimateTokens(content);
  if (totalTokens <= config.maxTokens) {
    return [finalizeChunk({
      index: startIndex,
      headingPath,
      content: content.trim(),
      tokenCount: totalTokens,
      docTitle
    })];
  }

  // Try paragraph-level chunking first
  const paragraphChunks = packWithOverlap(paragraphs, config.maxTokens, config.overlap, headingPath, docTitle);

  // Check if any paragraph is too large and needs sentence-level splitting
  const result: Chunk[] = [];

  for (const chunk of paragraphChunks) {
    if (chunk.tokenCount > config.maxTokens * 1.2) {
      // Chunk is too large, split by sentences. The size-budget fallback (~4 chars/token,
      // matching estimateTokens) force-splits any single balanced span that is itself
      // larger than the chunk budget, so grammar-awareness can never yield an unbounded unit.
      const sentences = splitIntoSentences(chunk.content, config.maxTokens * 4);
      const sentenceChunks = packWithOverlap(sentences, config.maxTokens, config.overlap, headingPath, docTitle);
      result.push(...sentenceChunks);
    } else {
      result.push(chunk);
    }
  }

  // Reindex
  return result.map((chunk, i) => ({ ...chunk, index: startIndex + i }));
}

/**
 * Chunk an entire document's sections
 */
export function chunkDocument(
  sections: Array<{ headingPath: string[]; content: string }>,
  config: ChunkConfig,
  docTitle?: string
): Chunk[] {
  const allChunks: Chunk[] = [];
  let globalIndex = 0;

  for (const section of sections) {
    const sectionChunks = chunkSection(section.content, section.headingPath, config, globalIndex, docTitle);
    allChunks.push(...sectionChunks);
    globalIndex = allChunks.length;
  }

  return allChunks;
}
