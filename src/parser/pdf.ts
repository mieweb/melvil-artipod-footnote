/**
 * PDF Parser
 *
 * Extracts plain text from PDF files using pdf-parse v2, converts to
 * markdown with heading structure, then parses into sections the same
 * way the DOCX and Markdown parsers do.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PDFParse } from 'pdf-parse';
import { parseMarkdown } from './markdown.js';
import type { HeadingInfo, Section } from './markdown.js';
/**
 * Convert raw PDF text (single-newline word-wrapped lines) into markdown.
 *
 * Rules applied in order:
 *  1. Strip PDF page-number markers like "-- 4 of 27 -- 5"
 *  2. All-caps short lines (likely section headers) → ## headings
 *  3. Blank lines → paragraph break (preserved as-is)
 *  4. Lines that look like continuations (previous line doesn't end a sentence
 *     AND this line starts lowercase or with a conjunction) → join with space
 *  5. Everything else → separate paragraph (double newline)
 */
function pdfTextToMarkdown(raw: string): string {
  // Strip page-number markers: "-- 4 of 27 -- 5" or similar
  const cleaned = raw.replace(/--\s*\d+\s+of\s+\d+\s*--\s*\d*/g, '').replace(/^\s*\d+\s*$/gm, '');

  const lines = cleaned.split('\n');
  const out: string[] = [];
  let pending = '';        // accumulating body paragraph
  let pendingHeading = ''; // accumulating multi-line all-caps heading

  const flushBody = () => { if (pending) { out.push(pending); pending = ''; } };
  const flushHeading = () => {
    if (pendingHeading) {
      out.push('');
      out.push(`## ${pendingHeading}`);
      out.push('');
      pendingHeading = '';
    }
  };

  const endssentence = (s: string) => /[.!?:]\s*$/.test(s);
  const isAllCaps = (s: string) => {
    const letters = s.replace(/[^a-zA-Z]/g, '');
    return letters.length >= 3 && letters === letters.toUpperCase();
  };
  const isContinuation = (prev: string, next: string) =>
    !endssentence(prev) && next.length > 0 && /^[a-z(]/.test(next);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushHeading();
      flushBody();
      out.push('');
      continue;
    }
    if (isAllCaps(line) && line.length < 80) {
      // Consecutive all-caps lines are word-wrapped fragments of the same heading
      flushBody();
      pendingHeading = pendingHeading ? `${pendingHeading} ${line}` : line;
      continue;
    }
    // Non-caps line — emit any pending heading first
    flushHeading();
    if (pending && isContinuation(pending, line)) {
      pending += ' ' + line;
    } else {
      flushBody();
      pending = line;
    }
  }
  flushHeading();
  flushBody();

  // Collapse runs of 3+ blank lines down to 2
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function parsePdf(buffer: Buffer): Promise<{ headings: HeadingInfo[]; sections: Section[] }> {
  // Write to a temp file so PDFParse can load it via url
  const tmpPath = path.join(os.tmpdir(), `docidx-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    const parser = new PDFParse({ url: tmpPath });
    const result = await parser.getText();
    const rawText = result.text.trim();

    if (!rawText) return { headings: [], sections: [] };

    const markdown = pdfTextToMarkdown(rawText);
    return parseMarkdown(markdown);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}
