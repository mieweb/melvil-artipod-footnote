use anyhow::Result;
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use tracing::info;

/// Embedder trait for generating vector embeddings
pub trait Embedder: Send + Sync {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>>;
    fn dimension(&self) -> usize;
    fn model_id(&self) -> &str;
    fn provider(&self) -> &str;
}

/// Options for creating a FastEmbed embedder
pub struct FastEmbedOptions {
    pub show_download_progress: bool,
    pub cache_dir: Option<String>,
}

impl Default for FastEmbedOptions {
    fn default() -> Self {
        Self {
            show_download_progress: true,
            cache_dir: None,
        }
    }
}

// ─── FastEmbed (in-process ONNX) ───────────────────────────────────────────

pub struct FastEmbedEmbedder {
    model_name: String,
    dim: usize,
    model: TextEmbedding,
}

impl FastEmbedEmbedder {
    pub fn new(model_name: &str) -> Result<Self> {
        Self::with_options(model_name, FastEmbedOptions::default())
    }

    pub fn with_options(model_name: &str, opts: FastEmbedOptions) -> Result<Self> {
        info!("Loading fastembed model: {}", model_name);

        let (embedding_model, dim) = match model_name {
            "bge-small-en-v1.5" | "BAAI/bge-small-en-v1.5" => {
                (EmbeddingModel::BGESmallENV15, 384)
            }
            "bge-base-en-v1.5" | "BAAI/bge-base-en-v1.5" => {
                (EmbeddingModel::BGEBaseENV15, 768)
            }
            "bge-large-en-v1.5" | "BAAI/bge-large-en-v1.5" => {
                (EmbeddingModel::BGELargeENV15, 1024)
            }
            "all-MiniLM-L6-v2" | "AllMiniLML6V2" => {
                (EmbeddingModel::AllMiniLML6V2, 384)
            }
            "all-MiniLM-L12-v2" | "AllMiniLML12V2" => {
                (EmbeddingModel::AllMiniLML12V2, 384)
            }
            "nomic-embed-text-v1.5" | "NomicEmbedTextV15" => {
                (EmbeddingModel::NomicEmbedTextV15, 768)
            }
            _ => {
                info!("Unknown model '{}', falling back to BGESmallENV15", model_name);
                (EmbeddingModel::BGESmallENV15, 384)
            }
        };

        let mut init_opts = InitOptions::new(embedding_model)
            .with_show_download_progress(opts.show_download_progress);

        if let Some(cache) = opts.cache_dir {
            init_opts = init_opts.with_cache_dir(cache.into());
        }

        let model = TextEmbedding::try_new(init_opts)?;
        info!("Model loaded: {} (dim: {})", model_name, dim);

        Ok(Self {
            model_name: model_name.to_string(),
            dim,
            model,
        })
    }
}

impl Embedder for FastEmbedEmbedder {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let documents: Vec<String> = texts.iter().map(|t| t.to_string()).collect();
        let embeddings = self.model.embed(documents, None)?;
        Ok(embeddings)
    }

    fn dimension(&self) -> usize {
        self.dim
    }

    fn model_id(&self) -> &str {
        &self.model_name
    }

    fn provider(&self) -> &str {
        "fastembed"
    }
}

// ─── Ollama Embedder (HTTP API) ────────────────────────────────────────────

#[derive(Serialize)]
struct OllamaEmbedRequest {
    model: String,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct OllamaEmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModelInfo>,
}

#[derive(Deserialize)]
struct OllamaModelInfo {
    name: String,
}

pub struct OllamaEmbedder {
    model_name: String,
    dim: usize,
    base_url: String,
    client: Client,
}

impl OllamaEmbedder {
    pub fn new(model_name: &str, base_url: Option<&str>) -> Result<Self> {
        let base_url = base_url
            .unwrap_or("http://localhost:11434")
            .trim_end_matches('/')
            .to_string();
        let client = Client::new();

        info!("Connecting to Ollama at {} (model: {})", base_url, model_name);

        // Probe dimension by embedding a test string
        let req = OllamaEmbedRequest {
            model: model_name.to_string(),
            input: vec!["dimension probe".to_string()],
        };

        let resp = client
            .post(format!("{}/api/embed", base_url))
            .json(&req)
            .send()
            .map_err(|e| anyhow::anyhow!("Ollama connection failed (is it running?): {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            anyhow::bail!(
                "Ollama embed failed (status {}): {}. Is model '{}' pulled?",
                status,
                body,
                model_name
            );
        }

        let embed_resp: OllamaEmbedResponse = resp.json()?;
        let dim = embed_resp
            .embeddings
            .first()
            .map(|v| v.len())
            .unwrap_or(0);

        if dim == 0 {
            anyhow::bail!("Ollama returned empty embeddings for model '{}'", model_name);
        }

        info!("Ollama embedder ready: {} (dim: {})", model_name, dim);

        Ok(Self {
            model_name: model_name.to_string(),
            dim,
            base_url,
            client,
        })
    }

    /// Check if Ollama is reachable
    pub fn is_available(base_url: Option<&str>) -> bool {
        let url = base_url.unwrap_or("http://localhost:11434");
        Client::new()
            .get(format!("{}/api/tags", url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// List installed models
    pub fn list_models(base_url: Option<&str>) -> Vec<String> {
        let url = base_url.unwrap_or("http://localhost:11434");
        Client::new()
            .get(format!("{}/api/tags", url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .ok()
            .and_then(|r| r.json::<OllamaTagsResponse>().ok())
            .map(|t| t.models.into_iter().map(|m| m.name).collect())
            .unwrap_or_default()
    }

    /// Pull a model
    pub fn pull_model(model: &str, base_url: Option<&str>) -> Result<()> {
        let url = base_url.unwrap_or("http://localhost:11434");
        info!("Pulling Ollama model: {}", model);
        let resp = Client::new()
            .post(format!("{}/api/pull", url))
            .json(&serde_json::json!({"name": model, "stream": false}))
            .timeout(std::time::Duration::from_secs(600))
            .send()?;
        if !resp.status().is_success() {
            anyhow::bail!("Failed to pull model '{}': {}", model, resp.text()?);
        }
        Ok(())
    }
}

impl Embedder for OllamaEmbedder {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let input: Vec<String> = texts.iter().map(|t| t.to_string()).collect();
        let req = OllamaEmbedRequest {
            model: self.model_name.clone(),
            input,
        };

        let resp = self
            .client
            .post(format!("{}/api/embed", self.base_url))
            .json(&req)
            .send()?;

        if !resp.status().is_success() {
            anyhow::bail!("Ollama embed failed: {}", resp.text()?);
        }

        let embed_resp: OllamaEmbedResponse = resp.json()?;
        Ok(embed_resp.embeddings)
    }

    fn dimension(&self) -> usize {
        self.dim
    }

    fn model_id(&self) -> &str {
        &self.model_name
    }

    fn provider(&self) -> &str {
        "ollama"
    }
}

// ─── OpenAI Embedder (HTTP API) ────────────────────────────────────────────

#[derive(Serialize)]
struct OpenAIEmbedRequest {
    model: String,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct OpenAIEmbedResponse {
    data: Vec<OpenAIEmbedData>,
}

#[derive(Deserialize)]
struct OpenAIEmbedData {
    embedding: Vec<f32>,
}

pub struct OpenAIEmbedder {
    model_name: String,
    dim: usize,
    api_key: String,
    base_url: String,
    client: Client,
}

impl OpenAIEmbedder {
    pub fn new(model_name: &str, api_key: &str, base_url: Option<&str>) -> Result<Self> {
        let base_url = base_url
            .unwrap_or("https://api.openai.com/v1")
            .trim_end_matches('/')
            .to_string();
        let client = Client::new();

        info!("Connecting to OpenAI API (model: {})", model_name);

        // Known model dimensions
        let dim = match model_name {
            "text-embedding-3-small" => 1536,
            "text-embedding-3-large" => 3072,
            "text-embedding-ada-002" => 1536,
            _ => {
                // Probe dimension
                let req = OpenAIEmbedRequest {
                    model: model_name.to_string(),
                    input: vec!["probe".to_string()],
                };
                let resp = client
                    .post(format!("{}/embeddings", base_url))
                    .header("Authorization", format!("Bearer {}", api_key))
                    .json(&req)
                    .send()?;
                if !resp.status().is_success() {
                    anyhow::bail!("OpenAI API error: {}", resp.text()?);
                }
                let embed_resp: OpenAIEmbedResponse = resp.json()?;
                embed_resp.data.first().map(|d| d.embedding.len()).unwrap_or(1536)
            }
        };

        info!("OpenAI embedder ready: {} (dim: {})", model_name, dim);

        Ok(Self {
            model_name: model_name.to_string(),
            dim,
            api_key: api_key.to_string(),
            base_url,
            client,
        })
    }
}

impl Embedder for OpenAIEmbedder {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let input: Vec<String> = texts.iter().map(|t| t.to_string()).collect();

        // OpenAI has batch limits; split into chunks of 2048
        let mut all_embeddings = Vec::with_capacity(texts.len());
        for batch in input.chunks(2048) {
            let req = OpenAIEmbedRequest {
                model: self.model_name.clone(),
                input: batch.to_vec(),
            };

            let resp = self
                .client
                .post(format!("{}/embeddings", self.base_url))
                .header("Authorization", format!("Bearer {}", self.api_key))
                .json(&req)
                .send()?;

            if !resp.status().is_success() {
                anyhow::bail!("OpenAI embed failed: {}", resp.text()?);
            }

            let embed_resp: OpenAIEmbedResponse = resp.json()?;
            for d in embed_resp.data {
                all_embeddings.push(d.embedding);
            }
        }

        Ok(all_embeddings)
    }

    fn dimension(&self) -> usize {
        self.dim
    }

    fn model_id(&self) -> &str {
        &self.model_name
    }

    fn provider(&self) -> &str {
        "openai"
    }
}

// ─── Auto-detection & Factory ──────────────────────────────────────────────

/// Auto-detect the best available embedder:
/// 1. If Ollama is running and has an embedding model → use it
/// 2. If OPENAI_API_KEY is set → use OpenAI
/// 3. Fall back to fastembed (local ONNX)
pub fn auto_detect_embedder() -> Result<Box<dyn Embedder>> {
    // Try Ollama first
    if OllamaEmbedder::is_available(None) {
        let models = OllamaEmbedder::list_models(None);
        // Look for common embedding models
        let embed_models = [
            "nomic-embed-text",
            "mxbai-embed-large",
            "all-minilm",
            "bge-m3",
            "snowflake-arctic-embed",
        ];
        for candidate in &embed_models {
            if models.iter().any(|m| m.contains(candidate)) {
                let full_name = models
                    .iter()
                    .find(|m| m.contains(candidate))
                    .unwrap()
                    .clone();
                info!("Auto-detected Ollama embedding model: {}", full_name);
                match OllamaEmbedder::new(&full_name, None) {
                    Ok(e) => return Ok(Box::new(e)),
                    Err(e) => {
                        tracing::warn!("Ollama model {} failed: {}", full_name, e);
                    }
                }
            }
        }
    }

    // Try OpenAI
    if let Ok(api_key) = std::env::var("OPENAI_API_KEY") {
        if !api_key.is_empty() {
            info!("Auto-detected OpenAI API key, using text-embedding-3-small");
            return Ok(Box::new(OpenAIEmbedder::new(
                "text-embedding-3-small",
                &api_key,
                None,
            )?));
        }
    }

    // Default: fastembed
    info!("Using fastembed (local ONNX) as default");
    Ok(Box::new(FastEmbedEmbedder::new("bge-small-en-v1.5")?))
}

/// Create an embedder from a provider:model spec with options
pub fn create_embedder_with_config(
    model_spec: &str,
    opts: FastEmbedOptions,
) -> Result<Box<dyn Embedder>> {
    if model_spec == "mock" {
        return Ok(Box::new(MockEmbedder { dim: 384 }));
    }

    if model_spec == "auto" {
        return auto_detect_embedder();
    }

    // Parse provider:model format
    if let Some(model) = model_spec.strip_prefix("ollama:") {
        return Ok(Box::new(OllamaEmbedder::new(model, None)?));
    }

    if let Some(model) = model_spec.strip_prefix("openai:") {
        let api_key = std::env::var("OPENAI_API_KEY")
            .map_err(|_| anyhow::anyhow!("OPENAI_API_KEY environment variable required for OpenAI embeddings"))?;
        return Ok(Box::new(OpenAIEmbedder::new(model, &api_key, None)?));
    }

    // Default: fastembed
    let model_name = model_spec.strip_prefix("fastembed:").unwrap_or(model_spec);
    Ok(Box::new(FastEmbedEmbedder::with_options(model_name, opts)?))
}

/// Create an embedder based on the model specification string (simple API)
pub fn create_embedder(model_spec: &str) -> Result<Box<dyn Embedder>> {
    create_embedder_with_config(model_spec, FastEmbedOptions::default())
}

// ─── Mock Embedder (testing) ───────────────────────────────────────────────

struct MockEmbedder {
    dim: usize,
}

impl Embedder for MockEmbedder {
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|_| vec![0.0f32; self.dim]).collect())
    }

    fn dimension(&self) -> usize {
        self.dim
    }

    fn model_id(&self) -> &str {
        "mock"
    }

    fn provider(&self) -> &str {
        "mock"
    }
}
