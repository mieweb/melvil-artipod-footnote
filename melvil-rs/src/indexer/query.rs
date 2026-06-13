use anyhow::Result;
use tracing::info;

use crate::embedder::create_embedder;
use crate::storage::SqliteStore;

/// Run a hybrid query against an existing index
pub async fn run_query(db_path: &str, query: &str, k: usize) -> Result<()> {
    let index_path = std::path::Path::new(db_path).join("index.sqlite");
    let manifest_path = std::path::Path::new(db_path).join("manifest.json");

    if !index_path.exists() {
        anyhow::bail!("Index not found: {}", index_path.display());
    }

    // Read manifest
    let manifest_content = std::fs::read_to_string(&manifest_path)?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content)?;

    let model_id = manifest["embedding"]["model_id"]
        .as_str()
        .unwrap_or("mock");
    let dim = manifest["embedding"]["dimension"]
        .as_u64()
        .unwrap_or(384) as usize;

    info!("Querying index with model: {} (dim: {})", model_id, dim);

    // Create embedder and store
    let embedder = create_embedder(model_id)?;
    let store = SqliteStore::new(index_path.to_str().unwrap(), dim)?;

    // Generate query embedding
    let query_vec = embedder.embed(&[query])?;
    let query_embedding = &query_vec[0];

    // Run hybrid search (vector + FTS5)
    let results = store.hybrid_search(query, query_embedding, k)?;

    // Display results
    println!("\n{} results for: \"{}\"\n", results.len(), query);
    println!("{:-<80}", "");

    for (i, result) in results.iter().enumerate() {
        println!(
            "[{}] {} (score: {:.4})",
            i + 1,
            result.title,
            result.score
        );
        println!("    URL: {}", result.url);
        println!("    {}", truncate(&result.content, 200));
        println!();
    }

    Ok(())
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}
