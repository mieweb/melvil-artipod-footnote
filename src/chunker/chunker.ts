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
}): Chunk {
  const embeddingText = renderEmbeddingText({
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
 * Split text into sentences (roughly)
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence boundaries while preserving them
  const sentences: string[] = [];
  const pattern = /[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g;
  let match;
  
  while ((match = pattern.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence) {
      sentences.push(sentence);
    }
  }
  
  return sentences;
}

/**
 * Split text into paragraphs
 */
function splitIntoParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Pack content into chunks with overlap
 */
function packWithOverlap(
  units: string[],
  maxTokens: number,
  overlapTokens: number,
  headingPath: string[]
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
        tokenCount: currentTokens
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
      tokenCount: currentTokens
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
  startIndex: number = 0
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
      tokenCount: totalTokens
    })];
  }

  // Try paragraph-level chunking first
  const paragraphChunks = packWithOverlap(paragraphs, config.maxTokens, config.overlap, headingPath);
  
  // Check if any paragraph is too large and needs sentence-level splitting
  const result: Chunk[] = [];
  
  for (const chunk of paragraphChunks) {
    if (chunk.tokenCount > config.maxTokens * 1.2) {
      // Chunk is too large, split by sentences
      const sentences = splitIntoSentences(chunk.content);
      const sentenceChunks = packWithOverlap(sentences, config.maxTokens, config.overlap, headingPath);
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
  config: ChunkConfig
): Chunk[] {
  const allChunks: Chunk[] = [];
  let globalIndex = 0;

  for (const section of sections) {
    const sectionChunks = chunkSection(section.content, section.headingPath, config, globalIndex);
    allChunks.push(...sectionChunks);
    globalIndex = allChunks.length;
  }

  return allChunks;
}
