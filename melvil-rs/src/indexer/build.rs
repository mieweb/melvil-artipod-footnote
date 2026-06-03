use std::collections::HashMap;
use std::path::{Path, PathBuf};
use anyhow::Result;
use tracing::{info, warn};
use indicatif::{ProgressBar, ProgressStyle};

use crate::chunker::{chunk_document, ChunkConfig};
use crate::config::ProjectConfig;
use crate::embedder::{create_embedder_with_config, FastEmbedOptions};
use crate::parser;
use crate::storage::SqliteStore;
use crate::utils;

/// Build options
pub struct BuildOptions {
    pub root: String,
    pub content: String,
    pub out: String,
    pub clean: bool,
    pub incremental: bool,
    pub include_drafts: bool,
    pub filters: HashMap<String, String>,
    pub embedding_model: String,
    pub embedding_dim: Option<usize>,
    pub max_tokens: usize,
    pub overlap: usize,
    pub compress: bool,
    pub copy_content: bool,
    pub show_download_progress: bool,
    pub cache_dir: Option<String>,
    pub config: ProjectConfig,
}

pub struct BuildResult {
    pub doc_count: usize,
    pub chunk_count: usize,
    pub embeddings_generated: usize,
}

/// Main build orchestration with incremental support
pub async fn run_build(options: BuildOptions) -> Result<BuildResult> {
    let root = Path::new(&options.root).canonicalize()?;
    let content_dir = root.join(&options.content);
    let out_dir = root.join(&options.out);

    info!("Building index from: {}", content_dir.display());
    info!("Output directory: {}", out_dir.display());

    std::fs::create_dir_all(&out_dir)?;

    let db_path = out_dir.join("index.sqlite");
    if options.clean && db_path.exists() {
        info!("Cleaning existing index...");
        std::fs::remove_file(&db_path)?;
    }

    let embedder = create_embedder_with_config(
        &options.embedding_model,
        FastEmbedOptions {
            show_download_progress: options.show_download_progress,
            cache_dir: options.cache_dir,
        },
    )?;
    let dim = options.embedding_dim.unwrap_or_else(|| embedder.dimension());
    info!("Embedding model: {} (dim: {})", embedder.model_id(), dim);

    let mut store = SqliteStore::new(db_path.to_str().unwrap(), dim)?;
    store.init(options.clean)?;

    let files = utils::find_indexable_files(&content_dir)?;
    info!("Found {} indexable files", files.len());

    if files.is_empty() {
        warn!("No files found to index");
        return Ok(BuildResult { doc_count: 0, chunk_count: 0, embeddings_generated: 0 });
    }

    // Incremental: determine which files need processing
    let files_to_process = if options.incremental && !options.clean {
        filter_changed_files(&files, &content_dir, &store)?
    } else {
        files.clone()
    };

    if options.incremental && files_to_process.len() < files.len() {
        info!(
            "Incremental: {} of {} files changed, processing only changed files",
            files_to_process.len(),
            files.len()
        );
    }

    // Parse
    let pb = ProgressBar::new(files_to_process.len() as u64);
    pb.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} {msg}")
            .unwrap()
            .progress_chars("█▓░"),
    );

    let chunk_config = ChunkConfig {
        max_tokens: options.max_tokens,
        overlap: options.overlap,
    };

    let mut all_chunks: Vec<(PathBuf, String, crate::chunker::Chunk)> = Vec::new();
    let mut doc_count = 0;

    for file_path in &files_to_process {
        pb.set_message(
            file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        );

        match parser::parse_file(file_path) {
            Ok(mut doc) => {
                // Filter based on front matter
                if !parser::should_include_document(
                    &doc,
                    &options.filters,
                    options.include_drafts,
                    &options.config,
                ) {
                    pb.inc(1);
                    continue;
                }

                // Apply shortcode transforms and substitutions
                doc.content = parser::process_shortcodes(&doc.content, &options.config);

                let rel_path = file_path.strip_prefix(&content_dir).unwrap_or(file_path.as_path());

                // For incremental: remove old chunks before re-adding
                if options.incremental {
                    let rel_str = rel_path.to_string_lossy().to_string();
                    if let Ok(Some((_, _, old_ids))) = store.get_tracked_file(&rel_str) {
                        store.remove_chunks(&old_ids)?;
                        store.remove_tracked_file(&rel_str)?;
                    }
                }

                let chunks = chunk_document(&doc.content, &doc.headings, &chunk_config);
                for chunk in chunks {
                    all_chunks.push((rel_path.to_path_buf(), doc.title.clone(), chunk));
                }
                doc_count += 1;
            }
            Err(e) => {
                warn!("Failed to parse {}: {}", file_path.display(), e);
            }
        }
        pb.inc(1);
    }
    pb.finish_with_message("Parsing complete");

    info!("Generated {} chunks from {} documents", all_chunks.len(), doc_count);

    // Embed
    let batch_size = 64;
    let embed_pb = ProgressBar::new(all_chunks.len() as u64);
    embed_pb.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} embeddings")
            .unwrap()
            .progress_chars("█▓░"),
    );

    let mut embeddings_count = 0;
    // Track chunks per file for incremental tracking
    let mut file_chunks: HashMap<String, Vec<String>> = HashMap::new();

    for batch in all_chunks.chunks(batch_size) {
        let texts: Vec<&str> = batch.iter().map(|(_, _, c)| c.content.as_str()).collect();
        let vectors = embedder.embed(&texts)?;

        for (i, (rel_path, title, chunk)) in batch.iter().enumerate() {
            let doc_id = utils::generate_doc_id(rel_path);
            let chunk_id = format!("{}#{}", doc_id, chunk.index);
            let url = utils::generate_url(rel_path);

            store.insert_chunk(
                &chunk_id,
                &doc_id,
                rel_path.to_str().unwrap_or(""),
                &url,
                title,
                &chunk.heading_path.join(" > "),
                &chunk.content,
                &chunk.content_hash,
                &vectors[i],
            )?;

            // Track for incremental
            let rel_str = rel_path.to_string_lossy().to_string();
            file_chunks.entry(rel_str).or_default().push(chunk_id);

            embeddings_count += 1;
        }
        embed_pb.inc(batch.len() as u64);
    }
    embed_pb.finish_with_message("Embeddings complete");

    // Update file tracking for incremental builds
    for (rel_path, chunk_ids) in &file_chunks {
        let full_path = content_dir.join(rel_path);
        let mtime = std::fs::metadata(&full_path)
            .map(|m| m.modified().ok())
            .ok()
            .flatten()
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
            .unwrap_or(0);
        let hash = utils::file_content_hash(&full_path).unwrap_or_default();
        store.track_file(rel_path, &hash, mtime, chunk_ids)?;
    }

    // Write manifest
    let total_chunks = store.chunk_count().unwrap_or(all_chunks.len());
    let manifest = serde_json::json!({
        "version": "2.0.0",
        "generator": "melvil-rs",
        "created_at": chrono::Utc::now().to_rfc3339(),
        "embedding": {
            "model_id": embedder.model_id(),
            "dimension": dim,
            "provider": embedder.provider()
        },
        "stats": {
            "documents": doc_count,
            "chunks": total_chunks
        }
    });
    std::fs::write(out_dir.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;

    // Compression: create .footnote.tar.zst
    if options.compress {
        compress_index(&out_dir)?;
    }

    info!(
        "Build complete: {} docs, {} chunks, {} embeddings",
        doc_count, total_chunks, embeddings_count
    );

    Ok(BuildResult {
        doc_count,
        chunk_count: total_chunks,
        embeddings_generated: embeddings_count,
    })
}

/// Filter files that have changed since last build (incremental)
fn filter_changed_files(
    files: &[PathBuf],
    content_dir: &Path,
    store: &SqliteStore,
) -> Result<Vec<PathBuf>> {
    let mut changed = Vec::new();
    for file_path in files {
        let rel_path = file_path.strip_prefix(content_dir).unwrap_or(file_path.as_path());
        let rel_str = rel_path.to_string_lossy().to_string();

        let needs_update = match store.get_tracked_file(&rel_str)? {
            None => true, // New file
            Some((old_hash, _old_mtime, _)) => {
                // Check content hash
                let current_hash = utils::file_content_hash(file_path).unwrap_or_default();
                current_hash != old_hash
            }
        };

        if needs_update {
            changed.push(file_path.clone());
        }
    }
    Ok(changed)
}

/// Compress the .footnote directory into .footnote.tar.zst
fn compress_index(out_dir: &Path) -> Result<()> {
    let archive_path = out_dir.with_extension("tar.zst");
    info!("Compressing index to: {}", archive_path.display());

    let file = std::fs::File::create(&archive_path)?;
    let zst_encoder = zstd::Encoder::new(file, 3)?; // compression level 3
    let mut tar_builder = tar::Builder::new(zst_encoder);

    // Add all files in the output directory
    let dir_name = out_dir.file_name().unwrap_or_default();
    tar_builder.append_dir_all(dir_name, out_dir)?;

    let zst_encoder = tar_builder.into_inner()?;
    zst_encoder.finish()?;

    let size = std::fs::metadata(&archive_path)?.len();
    info!("Archive created: {} ({:.1} MB)", archive_path.display(), size as f64 / 1_048_576.0);
    Ok(())
}
