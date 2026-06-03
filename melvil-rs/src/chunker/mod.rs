use sha2::{Sha256, Digest};

/// Configuration for the chunker
pub struct ChunkConfig {
    pub max_tokens: usize,
    pub overlap: usize,
}

/// A single chunk of content
#[derive(Debug, Clone)]
pub struct Chunk {
    pub index: usize,
    pub heading_path: Vec<String>,
    pub content: String,
    pub content_hash: String,
    pub token_count: usize,
}

/// Estimate token count (roughly 1.3 tokens per word for English)
pub fn estimate_tokens(text: &str) -> usize {
    let words = text.split_whitespace().count();
    ((words as f64) * 1.3).ceil() as usize
}

/// Generate deterministic hash for content
pub fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..8])
}

/// Chunk a document respecting heading boundaries
pub fn chunk_document(
    content: &str,
    headings: &[String],
    config: &ChunkConfig,
) -> Vec<Chunk> {
    let paragraphs: Vec<&str> = content
        .split("\n\n")
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();

    let mut chunks = Vec::new();
    let mut current_content = String::new();
    let mut current_tokens = 0;

    for para in &paragraphs {
        let para_tokens = estimate_tokens(para);

        if current_tokens + para_tokens > config.max_tokens && !current_content.is_empty() {
            // Flush current chunk
            let content_str = current_content.trim().to_string();
            let hash = hash_content(&content_str);
            chunks.push(Chunk {
                index: chunks.len(),
                heading_path: headings.to_vec(),
                content: content_str.clone(),
                content_hash: hash,
                token_count: current_tokens,
            });

            // Overlap: keep last portion
            let overlap_text = get_overlap_text(&content_str, config.overlap);
            current_content = overlap_text;
            current_tokens = estimate_tokens(&current_content);
        }

        if !current_content.is_empty() {
            current_content.push_str("\n\n");
        }
        current_content.push_str(para);
        current_tokens += para_tokens;
    }

    // Final chunk
    if !current_content.trim().is_empty() {
        let content_str = current_content.trim().to_string();
        let hash = hash_content(&content_str);
        chunks.push(Chunk {
            index: chunks.len(),
            heading_path: headings.to_vec(),
            content: content_str,
            content_hash: hash,
            token_count: current_tokens,
        });
    }

    chunks
}

/// Get the overlap text from the end of a chunk
fn get_overlap_text(text: &str, overlap_tokens: usize) -> String {
    let sentences: Vec<&str> = text.split(". ").collect();
    let mut result = String::new();
    let mut tokens = 0;

    for sentence in sentences.iter().rev() {
        let t = estimate_tokens(sentence);
        if tokens + t > overlap_tokens && !result.is_empty() {
            break;
        }
        if result.is_empty() {
            result = sentence.to_string();
        } else {
            result = format!("{}. {}", sentence, result);
        }
        tokens += t;
    }

    result
}
