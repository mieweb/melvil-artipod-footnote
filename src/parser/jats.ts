/**
 * JATS XML Parser
 *
 * Parses NLM/JATS Journal Article Tag Suite XML (ANSI/NISO Z39.96), the standard
 * format served by PubMed Central, into front matter + heading-aware sections.
 *
 * Rich bibliographic metadata (title, authors, identifiers, journal, date,
 * license) is lifted into the document front matter so it flows into chunk
 * records for citation display and license-aware retrieval. The article body is
 * rendered to Markdown and reused through the shared markdown parser so chunking
 * behaves identically to other formats.
 */
import { XMLParser } from 'fast-xml-parser';
import { parseMarkdown } from './markdown.js';
import type { FrontMatter, HeadingInfo, Section } from './markdown.js';

/** A node in fast-xml-parser's preserveOrder tree. */
type XmlNode = Record<string, unknown>;

const ATTR_KEY = ':@';
const TEXT_KEY = '#text';

/** Tag name of a preserveOrder node (the single non-attribute key), or null for text. */
function tagNameOf(node: XmlNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ATTR_KEY && key !== TEXT_KEY) return key;
  }
  return null;
}

/** Child nodes of an element. */
function childrenOf(node: XmlNode | undefined): XmlNode[] {
  if (!node) return [];
  const tag = tagNameOf(node);
  if (!tag) return [];
  const value = node[tag];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

/** Value of an attribute (without the `@_` prefix). */
function attr(node: XmlNode, name: string): string | undefined {
  const attrs = node[ATTR_KEY] as Record<string, unknown> | undefined;
  const raw = attrs?.[`@_${name}`];
  return raw === undefined ? undefined : String(raw);
}

function isText(node: XmlNode): boolean {
  return Object.prototype.hasOwnProperty.call(node, TEXT_KEY);
}

/** First direct child with the given tag. */
function findChild(nodes: XmlNode[], tag: string): XmlNode | undefined {
  return nodes.find((n) => tagNameOf(n) === tag);
}

/** All direct children with the given tag. */
function findChildren(nodes: XmlNode[], tag: string): XmlNode[] {
  return nodes.filter((n) => tagNameOf(n) === tag);
}

/** First descendant (depth-first) with the given tag. */
function deepFind(nodes: XmlNode[], tag: string): XmlNode | undefined {
  for (const n of nodes) {
    if (tagNameOf(n) === tag) return n;
    const found = deepFind(childrenOf(n), tag);
    if (found) return found;
  }
  return undefined;
}

/** Concatenate all descendant text, including inline markup (italic, xref, sup…). */
function textOf(nodes: XmlNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (isText(n)) out += String(n[TEXT_KEY]);
    else out += textOf(childrenOf(n));
  }
  return out;
}

/** Collapse runs of whitespace and trim. */
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function renderList(node: XmlNode, out: string[]): void {
  for (const item of findChildren(childrenOf(node), 'list-item')) {
    const txt = cleanText(textOf(childrenOf(item)));
    if (txt) out.push(`- ${txt}`);
  }
  out.push('');
}

function renderSecChildren(kids: XmlNode[], depth: number, out: string[]): void {
  for (const k of kids) {
    const tag = tagNameOf(k);
    if (tag === 'title') continue; // headings handled by renderSec
    if (tag === 'sec') {
      renderSec(k, depth, out);
    } else if (tag === 'p') {
      const txt = cleanText(textOf(childrenOf(k)));
      if (txt) {
        out.push(txt);
        out.push('');
      }
    } else if (tag === 'list') {
      renderList(k, out);
    } else if (tag === 'fig' || tag === 'table-wrap' || tag === 'boxed-text') {
      const caption = findChild(childrenOf(k), 'caption');
      const cap = caption ? cleanText(textOf(childrenOf(caption))) : '';
      if (cap) {
        out.push(cap);
        out.push('');
      }
    }
  }
}

function renderSec(node: XmlNode, depth: number, out: string[]): void {
  const kids = childrenOf(node);
  const titleNode = findChild(kids, 'title');
  const heading = titleNode ? cleanText(textOf(childrenOf(titleNode))) : '';
  if (heading) {
    out.push(`${'#'.repeat(Math.min(depth, 6))} ${heading}`);
    out.push('');
  }
  renderSecChildren(kids, depth + 1, out);
}

/** Extract the first publication date as a YYYY-MM-DD (or partial) string. */
function extractDate(articleMeta: XmlNode[]): string | undefined {
  const pad = (s: string) => (s.length === 1 ? `0${s}` : s);
  for (const pd of findChildren(articleMeta, 'pub-date')) {
    const k = childrenOf(pd);
    const year = cleanText(textOf(childrenOf(findChild(k, 'year') ?? {})));
    if (!year) continue;
    const month = cleanText(textOf(childrenOf(findChild(k, 'month') ?? {})));
    const day = cleanText(textOf(childrenOf(findChild(k, 'day') ?? {})));
    return [year, month && pad(month), day && pad(day)].filter(Boolean).join('-');
  }
  return undefined;
}

/** Extract a concise license identifier (CC URL, type, or human-readable text). */
function extractLicense(articleMeta: XmlNode[]): string | undefined {
  const permissions = findChild(articleMeta, 'permissions');
  if (!permissions) return undefined;
  const license = findChild(childrenOf(permissions), 'license');
  if (!license) return undefined;
  const href = attr(license, 'xlink:href');
  const type = attr(license, 'license-type');
  const text = cleanText(textOf(childrenOf(license)));
  return href || type || text || undefined;
}

/**
 * Parse a JATS XML document into front matter, headings, and sections.
 */
export function parseJats(xml: string): {
  frontMatter: FrontMatter;
  headings: HeadingInfo[];
  sections: Section[];
} {
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    attributeNamePrefix: '@_',
    textNodeName: TEXT_KEY,
    trimValues: false,
    processEntities: true,
  });

  let root: XmlNode[];
  try {
    root = parser.parse(xml) as XmlNode[];
  } catch {
    return { frontMatter: {}, headings: [], sections: [] };
  }

  const article = deepFind(root, 'article');
  if (!article) return { frontMatter: {}, headings: [], sections: [] };

  const articleKids = childrenOf(article);
  const frontNodes = childrenOf(findChild(articleKids, 'front'));
  const bodyNodes = childrenOf(findChild(articleKids, 'body'));
  const backNodes = childrenOf(findChild(articleKids, 'back'));

  const journalMeta = childrenOf(findChild(frontNodes, 'journal-meta'));
  const articleMeta = childrenOf(findChild(frontNodes, 'article-meta'));

  const journal = cleanText(textOf(childrenOf(deepFind(journalMeta, 'journal-title') ?? {}))) || undefined;

  let pmid: string | undefined;
  let pmcid: string | undefined;
  let doi: string | undefined;
  for (const idNode of findChildren(articleMeta, 'article-id')) {
    const type = attr(idNode, 'pub-id-type');
    const value = cleanText(textOf(childrenOf(idNode)));
    if (type === 'pmid') pmid = value;
    else if (type === 'pmcid') pmcid = value;
    else if (type === 'doi') doi = value;
  }

  const titleGroup = childrenOf(findChild(articleMeta, 'title-group'));
  const title = cleanText(textOf(childrenOf(findChild(titleGroup, 'article-title') ?? {})));

  const authors: string[] = [];
  for (const group of findChildren(articleMeta, 'contrib-group')) {
    for (const contrib of findChildren(childrenOf(group), 'contrib')) {
      const contribType = attr(contrib, 'contrib-type');
      if (contribType && contribType !== 'author') continue;
      const nameNode = findChild(childrenOf(contrib), 'name');
      if (!nameNode) continue;
      const nameKids = childrenOf(nameNode);
      const surname = cleanText(textOf(childrenOf(findChild(nameKids, 'surname') ?? {})));
      const given = cleanText(textOf(childrenOf(findChild(nameKids, 'given-names') ?? {})));
      const full = [given, surname].filter(Boolean).join(' ');
      if (full) authors.push(full);
    }
  }

  const date = extractDate(articleMeta);
  const license = extractLicense(articleMeta);

  // Render body to Markdown, then reuse the shared markdown parser for sections.
  const out: string[] = [];
  if (title) {
    out.push(`# ${title}`);
    out.push('');
  }

  const abstract = findChild(articleMeta, 'abstract');
  if (abstract) {
    out.push('## Abstract');
    out.push('');
    renderSecChildren(childrenOf(abstract), 3, out);
  }

  for (const node of bodyNodes) {
    const tag = tagNameOf(node);
    if (tag === 'sec') {
      renderSec(node, 2, out);
    } else if (tag === 'p') {
      const txt = cleanText(textOf(childrenOf(node)));
      if (txt) {
        out.push(txt);
        out.push('');
      }
    }
  }

  const refList = deepFind(backNodes, 'ref-list');
  if (refList) {
    const refs = findChildren(childrenOf(refList), 'ref');
    const rendered = refs
      .map((ref) => cleanText(textOf(childrenOf(ref))))
      .filter(Boolean);
    if (rendered.length) {
      out.push('## References');
      out.push('');
      rendered.forEach((ref, i) => out.push(`${i + 1}. ${ref}`));
      out.push('');
    }
  }

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const { headings, sections } = parseMarkdown(markdown);

  const frontMatter: FrontMatter = { source: 'jats' };
  if (title) frontMatter.title = title;
  if (date) frontMatter.date = date;
  if (journal) frontMatter.journal = journal;
  if (pmid) frontMatter.pmid = pmid;
  if (pmcid) frontMatter.pmcid = pmcid;
  if (doi) frontMatter.doi = doi;
  if (authors.length) frontMatter.authors = authors;
  if (license) frontMatter.license = license;

  return { frontMatter, headings, sections };
}
