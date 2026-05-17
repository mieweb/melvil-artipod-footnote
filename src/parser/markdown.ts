/**
 * Markdown Parser
 * 
 * Parses markdown content files, extracting front matter and processing shortcodes.
 */
import yaml from 'js-yaml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import type { Root, Heading, Content } from 'mdast';

export interface FrontMatter {
  id?: string;
  title?: string;
  date?: string;
  version?: number;
  lastAuthor?: string;
  mimeType?: string;
  links?: string[];
  source?: string;
  wikigdrive?: string;
  draft?: boolean;
  tags?: string[];
  slug?: string;
  aliases?: string[];
  description?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface ParsedDocument {
  frontMatter: FrontMatter;
  content: string;
  headings: HeadingInfo[];
  sections: Section[];
}

export interface HeadingInfo {
  depth: number;
  text: string;
  line: number;
}

export interface Section {
  headingPath: string[];
  content: string;
  startLine: number;
  endLine: number;
}

// Front matter extraction pattern
const FRONTMATTER_PATTERN = /^-{3}(?:\r\n|\r|\n)([\s\S]*?)-{3}(?:\r\n|\r|\n)/;

/**
 * Parse front matter from markdown content
 */
export function parseFrontMatter(content: string): { data: FrontMatter; body: string } {
  const match = content.match(FRONTMATTER_PATTERN);
  
  if (!match) {
    return { data: {}, body: content };
  }

  try {
    const data = yaml.load(match[1]) as FrontMatter || {};
    const body = content.slice(match[0].length);
    return { data, body };
  } catch {
    return { data: {}, body: content };
  }
}

/**
 * Shortcode processor configuration
 */
interface ShortcodeRule {
  // Extract inner content (for block shortcodes like {{% info %}})
  extractContent?: boolean;
  // Replace with static text
  replacement?: string | ((brand: 'eh' | 'wc' | 'both') => string);
  // Skip entirely (navigation-only shortcodes)
  skip?: boolean;
  // Conditional on brand
  brandFilter?: 'eh' | 'wc';
}

const SHORTCODE_RULES: Record<string, ShortcodeRule> = {
  // Content-affecting shortcodes - extract inner content
  'info': { extractContent: true },
  'note': { extractContent: true },
  'tip': { extractContent: true },
  'warning': { extractContent: true },
  'panel': { extractContent: true },
  'section': { extractContent: true },
  'column': { extractContent: true },
  'columns': { extractContent: true },
  'pre': { extractContent: true },
  'glow': { extractContent: true },

  // Substitution shortcodes
  'system-name': { 
    replacement: (brand) => brand === 'wc' ? 'WebChart' : brand === 'eh' ? 'Enterprise Health' : '{{% system-name %}}'
  },
  'sys-name': {
    replacement: (brand) => brand === 'wc' ? 'WC' : brand === 'eh' ? 'EH' : '{{% sys-name %}}'
  },

  // Link shortcodes - extract text
  'syslink': { extractContent: true },

  // Navigation/structure shortcodes - skip
  'children': { skip: true },
  'toc': { skip: true },
  'anchor': { skip: true },

  // Media shortcodes - skip
  'youtube': { skip: true },
  'vimeo': { skip: true },
  'drawio': { skip: true },

  // Conditional shortcodes
  'only': { extractContent: true } // handled specially
};

/**
 * Process shortcodes in markdown content
 */
export function processShortcodes(content: string, brand: 'eh' | 'wc' | 'both'): string {
  let result = content;

  // Process block shortcodes: {{% name %}}content{{% /name %}}
  // and {{< name >}}content{{< /name >}}
  const blockPattern = /\{\{[<%]\s*(\w+)(?:\s+[^%>]*)?\s*[%>]\}\}([\s\S]*?)\{\{[<%]\s*\/\1\s*[%>]\}\}/g;
  
  result = result.replace(blockPattern, (match, name: string, inner: string) => {
    const rule = SHORTCODE_RULES[name];
    
    // Handle 'only' shortcode specially for brand filtering
    if (name === 'only') {
      const sysMatch = match.match(/sys=["']?(eh|wc)["']?/);
      if (sysMatch) {
        const shortcodeBrand = sysMatch[1] as 'eh' | 'wc';
        if (brand !== 'both' && brand !== shortcodeBrand) {
          return ''; // Filter out content for other brand
        }
      }
      return inner.trim();
    }

    if (!rule) {
      return inner.trim(); // Unknown shortcode, keep inner content
    }

    if (rule.skip) {
      return '';
    }

    if (rule.extractContent) {
      return inner.trim();
    }

    if (rule.replacement) {
      const text = typeof rule.replacement === 'function' 
        ? rule.replacement(brand) 
        : rule.replacement;
      return text + ' ' + inner.trim();
    }

    return inner.trim();
  });

  // Process inline shortcodes: {{% name %}} or {{< name >}}
  const inlinePattern = /\{\{[<%]\s*(\w+)(?:\s+([^%>]*))?\s*[%>]\}\}/g;
  
  result = result.replace(inlinePattern, (match, name: string, args: string) => {
    const rule = SHORTCODE_RULES[name];
    
    if (!rule) {
      return ''; // Unknown inline shortcode
    }

    if (rule.skip) {
      return '';
    }

    if (rule.replacement) {
      return typeof rule.replacement === 'function' 
        ? rule.replacement(brand) 
        : rule.replacement;
    }

    // For syslink, extract the text argument
    if (name === 'syslink' && args) {
      const textMatch = args.match(/["']([^"']+)["']/);
      return textMatch ? textMatch[1] : '';
    }

    return '';
  });

  return result;
}

/**
 * Parse markdown and extract heading structure
 */
export function parseMarkdown(content: string): { headings: HeadingInfo[]; sections: Section[] } {
  const processor = unified().use(remarkParse);
  const tree = processor.parse(content) as Root;

  const headings: HeadingInfo[] = [];
  const sections: Section[] = [];
  
  // First pass: collect headings
  visit(tree, 'heading', (node: Heading) => {
    headings.push({
      depth: node.depth,
      text: toString(node),
      line: node.position?.start.line || 0
    });
  });

  // Second pass: extract sections between headings
  const lines = content.split('\n');
  let currentHeadingPath: string[] = [];
  let currentStart = 0;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeading = headings[i + 1];
    const endLine = nextHeading ? nextHeading.line - 1 : lines.length;

    // Update heading path based on depth
    currentHeadingPath = currentHeadingPath.slice(0, heading.depth - 1);
    currentHeadingPath[heading.depth - 1] = heading.text;

    // Extract section content
    const sectionLines = lines.slice(heading.line, endLine);
    const sectionContent = sectionLines.join('\n').trim();

    if (sectionContent) {
      sections.push({
        headingPath: [...currentHeadingPath.filter(Boolean)],
        content: sectionContent,
        startLine: heading.line,
        endLine: endLine
      });
    }

    currentStart = endLine;
  }

  // Handle content before first heading
  if (headings.length === 0 || headings[0].line > 1) {
    const endLine = headings.length > 0 ? headings[0].line - 1 : lines.length;
    const preContent = lines.slice(0, endLine).join('\n').trim();
    if (preContent) {
      sections.unshift({
        headingPath: [],
        content: preContent,
        startLine: 1,
        endLine: endLine
      });
    }
  }

  return { headings, sections };
}

/**
 * Parse a complete markdown document
 */
export function parseDocument(rawContent: string, brand: 'eh' | 'wc' | 'both'): ParsedDocument {
  const { data: frontMatter, body } = parseFrontMatter(rawContent);
  const processedContent = processShortcodes(body, brand);
  const { headings, sections } = parseMarkdown(processedContent);

  return {
    frontMatter,
    content: processedContent,
    headings,
    sections
  };
}
