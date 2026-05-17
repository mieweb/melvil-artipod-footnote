/**
 * PDF Parser
 *
 * Uses pdfjs-dist to extract text with font-height metadata.
 * Heading levels are derived from font size relative to body text size,
 * so diagram labels and captions at body size are never promoted to headings.
 * Output is parsed into multi-section structure (same as DOCX/Markdown parsers).
 */
import { parseMarkdown } from './markdown.js';
import type { HeadingInfo, Section } from './markdown.js';

/** One logical line extracted from a PDF page */
interface PdfLine {
  text: string;
  /** Max font height of items on this line (points, rounded) */
  height: number;
  /** Absolute Y position (page Y offset applied, decreases down the document) */
  pageY: number;
}

/**
 * Extract lines from all pages using pdfjs-dist.
 * Each line carries the maximum font height of its text items.
 */
async function extractLines(buffer: Buffer): Promise<PdfLine[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as any;
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const allLines: PdfLine[] = [];
  let pageYOffset = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent({ includeMarkedContent: false });

    let curText = '';
    let curH = 0;
    let curY = 0;
    let curEndX = 0; // right edge of last appended item (for space detection)

    const flush = () => {
      const t = curText.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
      if (t && curH > 0) {
        allLines.push({ text: t, height: curH, pageY: pageYOffset + curY });
      }
      curText = '';
      curH = 0;
      curEndX = 0;
    };

    for (const item of items) {
      if (!('str' in item)) continue; // skip MarkedContent items only
      const s = item.str as string;
      const h = Math.round(item.height as number);
      const x = Math.round((item.transform as number[])[4]);
      const y = Math.round((item.transform as number[])[5]);
      // Flush when y-position changes significantly (different visual line)
      if (curText && curH > 0 && Math.abs(y - curY) > curH * 0.4) {
        flush();
      }
      if (h > 0) { curY = y; if (h > curH) curH = h; }
      if (s) {
        // Insert a space if there's an x-gap between consecutive items on the same line
        if (curText && !curText.endsWith(' ') && !s.startsWith(' ') && x > curEndX + 3) {
          curText += ' ';
        }
        curText += s;
        curEndX = x + Math.round(((item.width as number) ?? 0));
      }
      if (item.hasEOL) flush();
    }
    flush();

    const viewport = page.getViewport({ scale: 1 });
    pageYOffset -= viewport.height;
  }

  return allLines;
}

/**
 * Convert extracted PDF lines to markdown using font-height thresholds.
 *
 * Algorithm:
 *  1. Body font size = most frequent height across all lines
 *  2. Lines with height > 1.4× body → heading; rank by size for H1/H2/H3
 *  3. Consecutive same-depth headings without sentence-end → join (word-wrapped)
 *  4. Body lines accumulate into paragraph; large Y-gap → paragraph break
 *  5. Strip lines that are only page numbers
 */
function linesToMarkdown(lines: PdfLine[]): string {
  if (lines.length === 0) return '';

  // Body height: most frequent non-zero height
  const hCounts = new Map<number, number>();
  for (const l of lines) hCounts.set(l.height, (hCounts.get(l.height) ?? 0) + 1);
  const bodyH = [...hCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const headingMin = bodyH * 1.4;

  // Heading heights sorted descending → depth 1, 2, 3
  const headingHeights = [
    ...new Set(lines.filter(l => l.height > headingMin).map(l => l.height))
  ].sort((a, b) => b - a);
  const depthOf = (h: number) => Math.min(headingHeights.indexOf(h) + 1, 3) || 1;

  const pageNumOnly = /^[\d\s\u2013\u2014\-]+$/;

  /** Fix column-break split words: "P RIMARY" → "PRIMARY" — excludes A and I (standalone English words) */
  const fixColumnBreak = (text: string) =>
    text.replace(/\b([B-HJ-Z]) ([A-Z]{3,})\b/g, '$1$2');

  /** Replace isolated ligature artifacts used as visual separators */
  const fixLigatures = (text: string) =>
    text.replace(/\s+\uFB01\s+/g, ' \u2013 ')   // ﬁ used as separator
        .replace(/\s+fi\s+/g, ' \u2013 ')          // fi decoded ligature as separator
        .replace(/\s+fl\s+/g, ' \u2013 ');         // fl decoded ligature as separator

  const cleanHeading = (text: string) => fixLigatures(fixColumnBreak(text.trim()));

  // Heuristic: medium-height text (1.4× to 2× body) is a heading only if all-caps or short
  // (filters out subtitles and callout text in larger-than-body but non-heading fonts)
  const isHeadingLine = (h: number, text: string): boolean => {
    if (h <= headingMin) return false;
    if (h > bodyH * 2.0) return true; // clearly large → always heading
    const letters = text.replace(/[^a-zA-Z]/g, '');
    const isAllCaps = letters.length > 0 && letters === letters.toUpperCase();
    return isAllCaps || text.trim().length <= 40;
  };

  const out: string[] = [];
  let pendingHeading = '';
  let pendingDepth = 0;
  let bodyBuffer: string[] = [];
  let prevPageY = lines[0].pageY;

  const flushHeading = () => {
    if (!pendingHeading) return;
    if (bodyBuffer.length) { out.push(bodyBuffer.join(' ')); bodyBuffer = []; out.push(''); }
    out.push(`${'#'.repeat(pendingDepth)} ${pendingHeading.trim()}`);
    out.push('');
    pendingHeading = '';
    pendingDepth = 0;
  };

  const flushBody = () => {
    if (bodyBuffer.length) { out.push(bodyBuffer.join(' ')); bodyBuffer = []; }
  };

  for (const line of lines) {
    if (pageNumOnly.test(line.text) && line.text.length <= 6) continue;

    const isHeading = isHeadingLine(line.height, line.text);
    const depth = isHeading ? depthOf(line.height) : 0;
    const yGap = Math.abs(line.pageY - prevPageY);
    const isParagraphBreak = yGap > bodyH * 2.5;

    if (isHeading) {
      if (depth === pendingDepth && pendingHeading && !/[.!?:]\s*$/.test(pendingHeading)) {
        pendingHeading = cleanHeading(pendingHeading + ' ' + line.text);
      } else {
        flushHeading();
        flushBody();
        if (isParagraphBreak && out.length > 0) out.push('');
        pendingHeading = cleanHeading(line.text);
        pendingDepth = depth;
      }
    } else {
      flushHeading();
      if (isParagraphBreak && bodyBuffer.length > 0) { flushBody(); out.push(''); }
      bodyBuffer.push(line.text);
    }
    prevPageY = line.pageY;
  }

  flushHeading();
  flushBody();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function parsePdf(buffer: Buffer): Promise<{ headings: HeadingInfo[]; sections: Section[] }> {
  const lines = await extractLines(buffer);
  if (lines.length === 0) return { headings: [], sections: [] };

  const markdown = linesToMarkdown(lines);
  if (!markdown) return { headings: [], sections: [] };

  return parseMarkdown(markdown);
}
