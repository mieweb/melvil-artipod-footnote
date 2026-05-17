/**
 * DOCX Parser
 *
 * Converts Word documents to Markdown using mammoth, then parses heading
 * structure so chunks inherit proper section context.
 */
import mammoth from 'mammoth';
import { parseMarkdown } from './markdown.js';
import type { HeadingInfo, Section } from './markdown.js';

/**
 * Convert a DOCX buffer to Markdown and parse heading-aware sections.
 */
export async function parseDocx(buffer: Buffer): Promise<{ headings: HeadingInfo[]; sections: Section[] }> {
  const result = await (mammoth as any).convertToMarkdown({ buffer });
  const markdown = result.value.trim();

  if (!markdown) return { headings: [], sections: [] };

  return parseMarkdown(markdown);
}
