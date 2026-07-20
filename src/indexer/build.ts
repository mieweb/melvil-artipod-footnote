/**
 * Index Builder
 * 
 * Main orchestration for building the SQLite hybrid index from markdown content.
 * Uses sqlite-vec for vector search and FTS5 for BM25 full-text search.
 */
import * as path from 'path';
import * as fs from 'fs';
import { createLogger, format, transports } from 'winston';
import { createHash } from 'crypto';

import { parseFrontMatter, parseMarkdown, parseAsPlainText } from '../parser/markdown.js';
import { parsePdf } from '../parser/pdf.js';
import { parseDocx } from '../parser/docx.js';
import { parseJats } from '../parser/jats.js';
import { processShortcodes, shouldIncludeDocument } from '../parser/transform.js';
import { chunkDocument, hashContent, type Chunk } from '../chunker/chunker.js';
import { createEmbedder, type Embedder } from '../embedder/embedder.js';
import { createEmbeddingCache, type EmbeddingCache } from '../embedder/cache.js';
import { SqliteStore, type ChunkRecord } from '../storage/sqlite.js';
import { generateManifest, writeManifest } from '../storage/manifest.js';
import { generateDocId, generateChunkId, generateUrl, extractSection } from '../utils/ids.js';
import { findIndexableFiles, getFileMtime, readFile, ensureDir } from '../utils/files.js';
import type { DocidxConfig, TransformContext } from '../config/schema.js';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [new transports.Console()]
});

export interface BuildOptions {
  root: string;
  content: string;
  out: string;
  clean: boolean;
  includeDrafts: boolean;
  filters: Record<string, string>;  // Generic filters (e.g., { brand: 'eh' })
  embeddingModel: string;
  embeddingDim: number;
  maxTokens: number;
  overlap: number;
  compress: boolean;
  copyContent: boolean;  // Copy source files to footnote index for grep search
  config: DocidxConfig;  // Project configuration
}

export interface BuildResult {
  docCount: number;
  chunkCount: number;
  embeddingsGenerated: number;
}

/**
 * Compute content hash for a file
 */
function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Recursively copy a directory, preserving structure
 */
function copyContentDir(src: string, dest: string): void {
  // Remove existing content copy
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  
  const copyRecursive = (srcDir: string, destDir: string) => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      
      if (entry.isDirectory()) {
        // Skip .assets folders and hidden directories
        if (entry.name.endsWith('.assets') || entry.name.startsWith('.')) {
          continue;
        }
        fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else if (['.md', '.txt', '.pdf', '.docx', '.xml'].includes(path.extname(entry.name).toLowerCase())) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };
  
  copyRecursive(src, dest);
}

/**
 * Build or update the index
 */
export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
  const projectRoot = path.resolve(options.root);
  const contentDir = path.join(projectRoot, options.content);
  const footnoteDir = path.resolve(options.out);
  
  // Validate paths
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root not found: ${projectRoot}`);
  }
  if (!fs.existsSync(contentDir)) {
    throw new Error(`Content directory not found: ${contentDir}`);
  }

  // Ensure output directories
  ensureDir(footnoteDir);
  const indexPath = path.join(footnoteDir, 'index.sqlite');
  const manifestPath = path.join(footnoteDir, 'manifest.json');

  // Copy content files if requested (for grep-based search comparison)
  const contentCopyDir = path.join(footnoteDir, 'content');
  if (options.copyContent) {
    logger.info('Copying content files to footnote index for grep search...');
    copyContentDir(contentDir, contentCopyDir);
    logger.info(`Content copied to ${contentCopyDir}`);
  }

  // Initialize unified SQLite store
  const store = new SqliteStore({ dbPath: indexPath, dimension: options.embeddingDim });
  const embedder = createEmbedder({
    model: options.embeddingModel,
    dimension: options.embeddingDim
  });
  
  // Initialize embedding cache in the footnote index directory
  const embeddingCache = createEmbeddingCache(footnoteDir, embedder.modelId);

  try {
    // Check for dimension mismatch
    if (!options.clean) {
      const storedDim = store.getStoredDimension();
      if (storedDim !== null && storedDim !== options.embeddingDim) {
        logger.warn(`Dimension mismatch: stored=${storedDim}, requested=${options.embeddingDim}. Forcing clean build.`);
        options.clean = true;
      }
    }

    store.init(options.clean);
    
    if (options.clean) {
      logger.info('Clean build: removing existing data');
    }

    // Find all indexable files (.md, .txt, .pdf)
    const allFiles = findIndexableFiles(contentDir);
    logger.info(`Found ${allFiles.length} files to index`);

    // Determine which files need processing
    const trackedPaths = new Set(store.getAllTrackedPaths());
    const currentPaths = new Set(allFiles);
    
    // Files to remove (deleted from source)
    const removedPaths = [...trackedPaths].filter(p => !currentPaths.has(p));
    if (removedPaths.length > 0) {
      logger.info(`Removing ${removedPaths.length} deleted files from index`);
      for (const removedPath of removedPaths) {
        const fileInfo = store.getFileInfo(removedPath);
        if (fileInfo) {
          store.deleteByChunkIds(fileInfo.chunkIds);
        }
      }
      store.removeFileInfos(removedPaths);
    }

    // Files to process (new or changed)
    const filesToProcess: string[] = [];
    
    for (const relativePath of allFiles) {
      const fullPath = path.join(contentDir, relativePath);
      const content = readFile(fullPath);
      const contentHash = computeFileHash(content);
      
      const existing = store.getFileInfo(relativePath);
      
      if (!existing || existing.contentHash !== contentHash) {
        filesToProcess.push(relativePath);
      }
    }

    logger.info(`Processing ${filesToProcess.length} files (${allFiles.length - filesToProcess.length} unchanged)`);

    // Process files one at a time - embed and store immediately for crash recovery
    let totalChunks = 0;
    let embeddingsGenerated = 0;
    let embeddingsCached = 0;
    let skippedDrafts = 0;
    const startTime = Date.now();
    let lastLogTime = startTime;

    for (let fileIdx = 0; fileIdx < filesToProcess.length; fileIdx++) {
      const relativePath = filesToProcess[fileIdx];
      const fullPath = path.join(contentDir, relativePath);
      const rawContent = readFile(fullPath);
      const contentHash = computeFileHash(rawContent);
      
      const ext = path.extname(relativePath).toLowerCase();
      let frontMatter: import('../parser/markdown.js').FrontMatter = {};
      let headings: import('../parser/markdown.js').HeadingInfo[];
      let sections: import('../parser/markdown.js').Section[];

      if (ext === '.pdf') {
        // PDF: async text extraction, no front matter or shortcodes
        const pdfBuffer = fs.readFileSync(path.join(contentDir, relativePath));
        ({ headings, sections } = await parsePdf(pdfBuffer));
      } else if (ext === '.docx') {
        // DOCX: extract plain text, no front matter or shortcodes
        const docxBuffer = fs.readFileSync(path.join(contentDir, relativePath));
        ({ headings, sections } = await parseDocx(docxBuffer));
      } else if (ext === '.xml') {
        // JATS XML: lift bibliographic metadata into front matter, render body
        ({ frontMatter, headings, sections } = parseJats(rawContent));
        if (!shouldIncludeDocument(frontMatter, options.config, options.filters)) {
          continue;
        }
      } else if (ext === '.txt') {
        // Plain text: no front matter or shortcodes
        ({ headings, sections } = parseAsPlainText(rawContent));
      } else {
        // Markdown: parse front matter, apply shortcodes
        const { data: fm, body } = parseFrontMatter(rawContent);
        frontMatter = fm;

        // Check if document should be included based on filters
        if (!shouldIncludeDocument(frontMatter, options.config, options.filters)) {
          continue;
        }

        // Skip drafts unless included
        if (frontMatter.draft && !options.includeDrafts) {
          skippedDrafts++;
          continue;
        }

        const transformContext: TransformContext = {
          frontMatter,
          filePath: relativePath,
          filters: options.filters
        };
        const processedContent = processShortcodes(body, options.config, transformContext);
        ({ headings, sections } = parseMarkdown(processedContent));
      }

      // Generate document ID
      const docId = generateDocId(relativePath, contentHash);

      // Delete old chunks for this file
      const existingInfo = store.getFileInfo(relativePath);
      if (existingInfo) {
        store.deleteByChunkIds(existingInfo.chunkIds);
      }

      // Human-readable document title: front-matter title if present, else the
      // basename with its extension stripped (PDFs/DOCX/plaintext have no front matter).
      // Folded into each chunk's embedding text (Source: line) — never the raw body.
      const title = frontMatter.title as string || path.basename(relativePath, path.extname(relativePath));

      // Chunk the document
      const chunks = chunkDocument(sections, {
        maxTokens: options.maxTokens,
        overlap: options.overlap
      }, title);

      if (chunks.length === 0) continue;

      // Create chunk records
      const url = generateUrl(relativePath, options.content);
      const section = extractSection(relativePath, options.content);
      const tags = (frontMatter.tags as string[]) || [];
      const date = (frontMatter.date as string) || '';

      const chunkRecords: ChunkRecord[] = chunks.map((chunk, idx) => {
        const chunkId = generateChunkId(docId, chunk.headingPath, chunk.index, chunk.contentHash);
        return {
          chunk_id: chunkId,
          doc_id: docId,
          path: relativePath,
          url,
          title,
          section,
          tags,
          date,
          headings: chunk.headingPath,
          content: chunk.content,
          content_hash: chunk.contentHash,
          assertion: chunk.assertion,
          findings: JSON.stringify(chunk.findings),
          updated_at: Date.now(),
          vector: [] // Will be filled below
        };
      });

      // Generate embeddings for this file's chunks, using cache where possible.
      // We embed and cache by embeddingHash (derived from the context-rendered
      // embeddingText), NOT content_hash: two chunks with identical bodies under
      // different headings must not share a vector. chunks[] is index-aligned with
      // chunkRecords[] (built by .map above).
      const embeddingHashes = chunks.map(c => c.embeddingHash);
      const cachedEmbeddings = embeddingCache.getMany(embeddingHashes);

      // Find which chunks need new embeddings
      const uncachedIndices: number[] = [];
      const uncachedTexts: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        if (!cachedEmbeddings.has(chunks[i].embeddingHash)) {
          uncachedIndices.push(i);
          uncachedTexts.push(chunks[i].embeddingText);
        }
      }

      // Generate embeddings only for uncached chunks
      let newEmbeddings: number[][] = [];
      if (uncachedTexts.length > 0) {
        newEmbeddings = await embedder.embed(uncachedTexts);

        // Cache the new embeddings, keyed by embeddingHash
        const toCache = new Map<string, number[]>();
        for (let i = 0; i < uncachedIndices.length; i++) {
          const hash = chunks[uncachedIndices[i]].embeddingHash;
          toCache.set(hash, newEmbeddings[i]);
        }
        embeddingCache.setMany(toCache);
      }

      // Assign embeddings to chunk records (cached + new)
      let newEmbIdx = 0;
      for (let i = 0; i < chunkRecords.length; i++) {
        const cached = cachedEmbeddings.get(chunks[i].embeddingHash);
        if (cached) {
          chunkRecords[i].vector = cached;
        } else {
          chunkRecords[i].vector = newEmbeddings[newEmbIdx++];
        }
      }

      // Insert chunks into database immediately
      store.upsertChunks(chunkRecords);

      // Update file tracking - this is our checkpoint!
      const chunkIds = chunkRecords.map(c => c.chunk_id);
      store.setFileInfo({
        path: relativePath,
        contentHash,
        mtime: getFileMtime(fullPath),
        chunkIds
      });

      totalChunks += chunkRecords.length;
      embeddingsGenerated += newEmbeddings.length;
      embeddingsCached += cachedEmbeddings.size;

      // Progress reporting with ETA
      const now = Date.now();
      if (now - lastLogTime >= 2000 || fileIdx === filesToProcess.length - 1) {
        const elapsedSec = (now - startTime) / 1000;
        const filesProcessed = fileIdx + 1;
        const filesRemaining = filesToProcess.length - filesProcessed;
        const rate = filesProcessed / elapsedSec;
        const etaSec = filesRemaining / rate;
        const pct = Math.round(filesProcessed / filesToProcess.length * 100);
        
        // Format ETA as mm:ss or hh:mm:ss
        const etaStr = etaSec < 3600 
          ? `${Math.floor(etaSec / 60)}:${String(Math.floor(etaSec % 60)).padStart(2, '0')}`
          : `${Math.floor(etaSec / 3600)}:${String(Math.floor((etaSec % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(etaSec % 60)).padStart(2, '0')}`;
        
        const embRate = embeddingsGenerated / elapsedSec;
        process.stdout.write(`\r  Files: ${filesProcessed}/${filesToProcess.length} (${pct}%) | Chunks: ${totalChunks} | ${embRate.toFixed(1)} emb/sec | ETA: ${etaStr}     `);
        lastLogTime = now;
      }
    }
    
    process.stdout.write('\n');
    
    if (skippedDrafts > 0) {
      logger.info(`Skipped ${skippedDrafts} draft documents`);
    }

    const totalSec = (Date.now() - startTime) / 1000;
    if (embeddingsGenerated > 0 || embeddingsCached > 0) {
      const cacheInfo = embeddingsCached > 0 ? ` (${embeddingsCached} cached)` : '';
      logger.info(`Completed ${embeddingsGenerated} embeddings${cacheInfo} in ${totalSec.toFixed(1)}s (${(embeddingsGenerated / totalSec).toFixed(1)}/sec)`);
    }

    // Get final counts
    const docCount = store.getDocCount();
    const chunkCount = store.getChunkCount();

    // Write manifest
    const manifest = generateManifest({
      projectName: options.config.name,
      baseUrl: options.config.baseUrl,
      maxTokens: options.maxTokens,
      overlap: options.overlap,
      embeddingModel: options.embeddingModel,
      embeddingDim: options.embeddingDim,
      docCount,
      chunkCount,
      filters: Object.keys(options.filters).length > 0 ? options.filters : undefined,
      contentCopy: options.copyContent,
      systemPrompt: options.config.agent?.systemPrompt,
      agentModel: options.config.agent?.model,
      agentMaxIterations: options.config.agent?.maxIterations
    });
    writeManifest(manifestPath, manifest);

    logger.info(`Manifest written to ${manifestPath}`);

    // Compress if requested
    if (options.compress) {
      logger.info('Compression requested but not yet implemented');
      // TODO: Implement tar.zst compression
    }

    return {
      docCount,
      chunkCount,
      embeddingsGenerated
    };

  } finally {
    store.close();
  }
}
