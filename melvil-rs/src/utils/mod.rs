use anyhow::Result;
use sha2::{Sha256, Digest};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Find all indexable files in a directory
pub fn find_indexable_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let supported_extensions = ["md", "markdown", "txt", "pdf", "docx"];

    let files: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let path = e.path();
            // Skip hidden files/directories
            if path
                .components()
                .any(|c| c.as_os_str().to_str().map_or(false, |s| s.starts_with('.')))
            {
                return false;
            }
            // Check extension
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| supported_extensions.contains(&ext.to_lowercase().as_str()))
                .unwrap_or(false)
        })
        .map(|e| e.path().to_path_buf())
        .collect();

    Ok(files)
}

/// Generate a deterministic document ID from a relative path
pub fn generate_doc_id(rel_path: &Path) -> String {
    let path_str = rel_path.to_str().unwrap_or("");
    let mut hasher = Sha256::new();
    hasher.update(path_str.as_bytes());
    let hash = hasher.finalize();
    format!("doc_{}", hex::encode(&hash[..8]))
}

/// Generate a URL from a relative path (for citations)
pub fn generate_url(rel_path: &Path) -> String {
    let path_str = rel_path
        .to_str()
        .unwrap_or("")
        .replace('\\', "/");

    // Remove file extension for clean URLs
    if let Some(stem) = path_str.strip_suffix(".md") {
        stem.to_string()
    } else {
        path_str.to_string()
    }
}

/// Generate SHA256 hash of file contents for change detection
pub fn file_content_hash(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}
