/**
 * File System Utilities
 */
import * as fs from 'fs';
import * as path from 'path';

const INDEXABLE_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.docx']);

/**
 * Recursively find all indexable files (.md, .txt, .pdf) in a directory
 */
export function findIndexableFiles(dir: string, baseDir?: string): string[] {
  const base = baseDir || dir;
  const files: string[] = [];
  
  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Skip hidden directories, asset folders, and dependency/build dirs
      if (entry.name.startsWith('.') || entry.name.endsWith('.assets') ||
          entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      files.push(...findIndexableFiles(fullPath, base));
    } else if (entry.isFile() && INDEXABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      // Return path relative to base directory
      files.push(path.relative(base, fullPath));
    }
  }
  
  return files.sort();
}

/** @deprecated Use findIndexableFiles */
export const findMarkdownFiles = findIndexableFiles;

/**
 * Get file modification time
 */
export function getFileMtime(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read file content
 */
export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Ensure directory exists
 */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
