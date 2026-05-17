/**
 * ID Generation Utilities
 * 
 * Generates deterministic, stable IDs for documents and chunks.
 */
import { createHash } from 'crypto';

/**
 * Generate a deterministic document ID from path and content hash
 * 
 * Format: doc_{path_hash}_{content_hash_prefix}
 */
export function generateDocId(relativePath: string, contentHash: string): string {
  const pathHash = createHash('sha256')
    .update(relativePath)
    .digest('hex')
    .slice(0, 8);
  
  const contentPrefix = contentHash.slice(0, 8);
  
  return `doc_${pathHash}_${contentPrefix}`;
}

/**
 * Generate a deterministic chunk ID from doc ID, heading path, index, and content hash
 * 
 * Format: chk_{doc_id_suffix}_{heading_hash}_{index}_{content_hash_prefix}
 */
export function generateChunkId(
  docId: string,
  headingPath: string[],
  chunkIndex: number,
  contentHash: string
): string {
  const docSuffix = docId.replace('doc_', '').slice(0, 8);
  
  const headingHash = createHash('sha256')
    .update(headingPath.join('||'))
    .digest('hex')
    .slice(0, 4);
  
  const contentPrefix = contentHash.slice(0, 6);
  
  return `chk_${docSuffix}_${headingHash}_${chunkIndex}_${contentPrefix}`;
}

/**
 * Generate URL from relative path (permalink-style)
 * 
 * Converts: content/functions/e-chart/overview.md
 * To:       /functions/e-chart/overview/
 */
export function generateUrl(relativePath: string, contentRoot: string = 'content'): string {
  // Remove content root prefix
  let url = relativePath;
  if (url.startsWith(contentRoot + '/')) {
    url = url.slice(contentRoot.length + 1);
  }
  
  // Remove .md extension
  url = url.replace(/\.md$/, '');
  
  // Handle _index files
  url = url.replace(/\/_index$/, '');
  
  // Ensure leading slash
  if (!url.startsWith('/')) {
    url = '/' + url;
  }
  
  // Ensure trailing slash
  if (!url.endsWith('/')) {
    url = url + '/';
  }
  
  return url;
}

/**
 * Extract section from path (first directory under content root)
 */
export function extractSection(relativePath: string, contentRoot: string = 'content'): string {
  let path = relativePath;
  if (path.startsWith(contentRoot + '/')) {
    path = path.slice(contentRoot.length + 1);
  }
  
  const parts = path.split('/');
  if (parts.length > 1) {
    return parts[0];
  }
  
  // Root level content
  return '';
}
