/**
 * File System Utilities
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively find all markdown files in a directory
 */
export function findMarkdownFiles(dir: string, baseDir?: string): string[] {
  const base = baseDir || dir;
  const files: string[] = [];
  
  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Skip hidden directories and asset folders
      if (entry.name.startsWith('.') || entry.name.endsWith('.assets')) {
        continue;
      }
      files.push(...findMarkdownFiles(fullPath, base));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Return path relative to base directory
      files.push(path.relative(base, fullPath));
    }
  }
  
  return files.sort();
}

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
