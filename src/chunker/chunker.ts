/**
 * Heading-Aware Content Chunker
 * 
 * Splits markdown content into chunks respecting heading boundaries,
 * with configurable max tokens and overlap.
 */
import { createHash } from 'crypto';

export interface ChunkConfig {
  maxTokens: number;
  overlap: number;
}

export interface Chunk {
  index: number;
  headingPath: string[];
  content: string;
  contentHash: string;
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
      const content = currentUnits.join(' ');
      chunks.push({
        index: chunkIndex++,
        headingPath: [...headingPath],
        content,
        contentHash: hashContent(content),
        tokenCount: currentTokens
      });

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
    const content = currentUnits.join(' ');
    chunks.push({
      index: chunkIndex,
      headingPath: [...headingPath],
      content,
      contentHash: hashContent(content),
      tokenCount: currentTokens
    });
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
    return [{
      index: startIndex,
      headingPath: [...headingPath],
      content: content.trim(),
      contentHash: hashContent(content.trim()),
      tokenCount: totalTokens
    }];
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
