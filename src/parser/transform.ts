/**
 * Content Transformer
 * 
 * Processes markdown content using configuration-driven shortcode rules.
 * This replaces the hardcoded markdown.ts shortcode handling.
 */
import type { ShortcodeRule, TransformContext, DocidxConfig } from '../config/schema.js';

/**
 * Process shortcodes using configured rules
 */
export function processShortcodes(
  content: string, 
  config: DocidxConfig,
  context: TransformContext
): string {
  const rules = config.shortcodes || {};
  let result = content;

  // Process block shortcodes: {{% name %}}content{{% /name %}}
  // and {{< name >}}content{{< /name >}}
  const blockPattern = /\{\{[<%]\s*(\w+)(?:\s+([^%>]*))?\s*[%>]\}\}([\s\S]*?)\{\{[<%]\s*\/\1\s*[%>]\}\}/g;
  
  result = result.replace(blockPattern, (match, name: string, args: string, inner: string) => {
    const rule = rules[name];
    
    // Check for custom handler first
    if (rule?.handler) {
      return rule.handler(inner, args || '', context);
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
      return rule.replacement + ' ' + inner.trim();
    }

    return inner.trim();
  });

  // Process inline shortcodes: {{% name %}} or {{< name >}}
  const inlinePattern = /\{\{[<%]\s*(\w+)(?:\s+([^%>]*))?\s*[%>]\}\}/g;
  
  result = result.replace(inlinePattern, (match, name: string, args: string) => {
    const rule = rules[name];
    
    // Check for custom handler
    if (rule?.handler) {
      return rule.handler('', args || '', context);
    }
    
    if (!rule) {
      return ''; // Unknown inline shortcode
    }

    if (rule.skip) {
      return '';
    }

    if (rule.replacement) {
      return rule.replacement;
    }

    // For link-like shortcodes, try to extract text argument
    if (rule.extractContent && args) {
      const textMatch = args.match(/["']([^"']+)["']/);
      return textMatch ? textMatch[1] : '';
    }

    return '';
  });

  // Apply text substitutions
  if (config.substitutions) {
    for (const [find, replace] of Object.entries(config.substitutions)) {
      result = result.split(find).join(replace);
    }
  }

  return result;
}

/**
 * Check if document should be included based on filters
 */
export function shouldIncludeDocument(
  frontMatter: Record<string, unknown>,
  config: DocidxConfig,
  activeFilters: Record<string, string>
): boolean {
  if (!config.filters || config.filters.length === 0) {
    return true;
  }

  for (const filter of config.filters) {
    const value = frontMatter[filter.field] as string | undefined;
    const effectiveValue = value ?? filter.default;

    // Check include list
    if (filter.include && filter.include.length > 0) {
      const activeValue = activeFilters[filter.field];
      if (activeValue && activeValue !== 'all') {
        // User specified a filter value
        if (effectiveValue !== activeValue) {
          return false;
        }
      }
    }

    // Check exclude list
    if (filter.exclude && filter.exclude.length > 0) {
      if (effectiveValue && filter.exclude.includes(effectiveValue)) {
        return false;
      }
    }
  }

  return true;
}
