/**
 * Configuration Loader
 * 
 * Loads docidx.config.js from project root and merges with defaults.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DocidxConfig, DEFAULT_CONFIG, mergeConfig } from './schema.js';

const CONFIG_FILENAMES = [
  'docidx.config.js',
  'docidx.config.mjs',
  'docidx.config.ts',
  '.docidxrc.js',
  '.docidxrc.json'
];

/**
 * Find config file in directory or parent directories
 */
export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  
  for (let i = 0; i < 10; i++) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = path.join(dir, filename);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  
  return null;
}

/**
 * Load configuration from file
 */
export async function loadConfig(configPath: string): Promise<DocidxConfig> {
  const ext = path.extname(configPath);
  
  if (ext === '.json') {
    const content = fs.readFileSync(configPath, 'utf-8');
    const userConfig = JSON.parse(content) as Partial<DocidxConfig>;
    return mergeConfig(userConfig);
  }
  
  // For JS/TS files, use dynamic import
  try {
    const fileUrl = pathToFileURL(configPath).href;
    const module = await import(fileUrl);
    const userConfig = module.default || module;
    return mergeConfig(userConfig);
  } catch (error) {
    throw new Error(`Failed to load config from ${configPath}: ${error}`);
  }
}

/**
 * Load configuration, searching from startDir
 * Returns default config if no config file found
 */
export async function loadProjectConfig(startDir: string): Promise<{ config: DocidxConfig; configPath: string | null }> {
  const configPath = findConfigFile(startDir);
  
  if (!configPath) {
    return { config: DEFAULT_CONFIG, configPath: null };
  }
  
  const config = await loadConfig(configPath);
  return { config, configPath };
}

/**
 * Resolve content root from config and working directory
 */
export function resolveContentRoot(config: DocidxConfig, workingDir: string): string {
  if (config.content?.root) {
    return path.resolve(workingDir, config.content.root);
  }
  
  // Auto-detect by looking for content/ directory
  let dir = path.resolve(workingDir);
  for (let i = 0; i < 10; i++) {
    const contentDir = path.join(dir, config.content?.dir || 'content');
    if (fs.existsSync(contentDir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  
  return workingDir;
}
