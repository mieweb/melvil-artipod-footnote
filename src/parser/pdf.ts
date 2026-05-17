/**
 * PDF Parser
 *
 * Extracts plain text from PDF files using pdf-parse v2.
 * Returns content as a single section (no heading structure).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PDFParse } from 'pdf-parse';
import type { HeadingInfo, Section } from './markdown.js';

/**
 * Extract text from a PDF buffer and return as a single section.
 */
export async function parsePdf(buffer: Buffer): Promise<{ headings: HeadingInfo[]; sections: Section[] }> {
  // Write to a temp file so PDFParse can load it via url
  const tmpPath = path.join(os.tmpdir(), `docidx-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const parser = new PDFParse({ url: tmpPath });
    const result = await parser.getText();
    const text = result.text.trim();

    if (!text) return { headings: [], sections: [] };

    const lineCount = text.split('\n').length;
    return {
      headings: [],
      sections: [{ headingPath: [], content: text, startLine: 1, endLine: lineCount }]
    };
  } finally {
    fs.unlinkSync(tmpPath);
  }
}
