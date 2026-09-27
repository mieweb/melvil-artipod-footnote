use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tracing::info;

/// Top-level configuration loaded from Config.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
    #[serde(default)]
    pub project: ProjectSection,
    #[serde(default)]
    pub embedding: EmbeddingSection,
    #[serde(default)]
    pub chunking: ChunkingSection,
    #[serde(default)]
    pub storage: StorageSection,
    #[serde(default)]
    pub filters: HashMap<String, FilterConfig>,
    #[serde(default)]
    pub shortcodes: HashMap<String, ShortcodeRule>,
    #[serde(default)]
    pub substitutions: HashMap<String, String>,
    #[serde(default)]
    pub agent: AgentSection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSection {
    /// Project name
    #[serde(default)]
    pub name: Option<String>,
    /// Base URL for document links (e.g., "https://docs.example.com/")
    #[serde(default)]
    pub base_url: Option<String>,
    /// Content directory relative to root
    #[serde(default = "default_content_dir")]
    pub content_dir: String,
    /// Output directory for the .footnote index
    #[serde(default = "default_out_dir")]
    pub out_dir: String,
    /// Include draft documents
    #[serde(default)]
    pub include_drafts: bool,
    /// File patterns to include
    #[serde(default)]
    pub include: Vec<String>,
    /// File patterns to exclude
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingSection {
    /// Which embedding provider to use: "fastembed", "ollama", "openai", "auto"
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Model name (depends on provider)
    #[serde(default = "default_model")]
    pub model: String,
    /// Embedding dimension (auto-detected if omitted)
    pub dimension: Option<usize>,
    /// Ollama base URL
    pub ollama_url: Option<String>,
    /// OpenAI base URL (for compatible APIs)
    pub openai_url: Option<String>,
    /// Whether to show download progress for model files
    #[serde(default = "default_true")]
    pub show_download_progress: bool,
    /// Cache directory for model files
    pub cache_dir: Option<String>,
    /// Automatically pull Ollama model if not installed
    #[serde(default)]
    pub auto_pull: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkingSection {
    /// Max tokens per chunk
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
    /// Token overlap between chunks
    #[serde(default = "default_overlap")]
    pub overlap: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageSection {
    /// Enable compression (.footnote.tar.zst)
    #[serde(default)]
    pub compress: bool,
    /// Copy markdown source files into the index
    #[serde(default)]
    pub copy_content: bool,
}

/// Content filter configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterConfig {
    /// Front matter field to filter on
    #[serde(default)]
    pub field: String,
    /// Values to include
    #[serde(default)]
    pub include: Vec<String>,
    /// Values to exclude
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Default value if field is missing
    pub default: Option<String>,
}

/// Shortcode transform rule
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcodeRule {
    /// Extract inner content from block shortcodes
    #[serde(default)]
    pub extract_content: bool,
    /// Replace with static text
    pub replacement: Option<String>,
    /// Skip entirely (don't include in output)
    #[serde(default)]
    pub skip: bool,
}

/// Agent (LLM) configuration for the ask command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSection {
    /// LLM provider: "ollama", "openai", "llama_cpp"
    #[serde(default)]
    pub provider: Option<String>,
    /// LLM model name (e.g., "qwen2.5:1.5b", "gpt-4o-mini")
    #[serde(default)]
    pub model: Option<String>,
    /// Path to a local GGUF model file (for llama_cpp provider)
    #[serde(default)]
    pub model_path: Option<String>,
    /// System prompt template
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Max agent iterations
    #[serde(default = "default_max_iterations")]
    pub max_iterations: usize,
    /// Ollama base URL for generation
    pub ollama_url: Option<String>,
    /// Number of GPU layers to offload (for llama_cpp, 0 = CPU only)
    #[serde(default)]
    pub n_gpu_layers: Option<u32>,
    /// Context size for llama_cpp (tokens)
    #[serde(default = "default_ctx_size")]
    pub ctx_size: usize,
}

fn default_ctx_size() -> usize { 4096 }

// --- Defaults ---
fn default_content_dir() -> String { ".".into() }
fn default_out_dir() -> String { "./.footnote".into() }
fn default_provider() -> String { "fastembed".into() }
fn default_model() -> String { "bge-small-en-v1.5".into() }
fn default_max_tokens() -> usize { 500 }
fn default_overlap() -> usize { 80 }
fn default_true() -> bool { true }
fn default_max_iterations() -> usize { 5 }

impl Default for ProjectSection {
    fn default() -> Self {
        Self {
            name: None,
            base_url: None,
            content_dir: default_content_dir(),
            out_dir: default_out_dir(),
            include_drafts: false,
            include: Vec::new(),
            exclude: Vec::new(),
        }
    }
}

impl Default for EmbeddingSection {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            model: default_model(),
            dimension: None,
            ollama_url: None,
            openai_url: None,
            show_download_progress: true,
            cache_dir: None,
            auto_pull: false,
        }
    }
}

impl Default for ChunkingSection {
    fn default() -> Self {
        Self {
            max_tokens: default_max_tokens(),
            overlap: default_overlap(),
        }
    }
}

impl Default for StorageSection {
    fn default() -> Self {
        Self {
            compress: false,
            copy_content: false,
        }
    }
}

impl Default for AgentSection {
    fn default() -> Self {
        Self {
            provider: None,
            model: None,
            model_path: None,
            system_prompt: None,
            max_iterations: default_max_iterations(),
            ollama_url: None,
            n_gpu_layers: None,
            ctx_size: default_ctx_size(),
        }
    }
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            project: ProjectSection::default(),
            embedding: EmbeddingSection::default(),
            chunking: ChunkingSection::default(),
            storage: StorageSection::default(),
            filters: HashMap::new(),
            shortcodes: HashMap::new(),
            substitutions: HashMap::new(),
            agent: AgentSection::default(),
        }
    }
}

impl ProjectConfig {
    /// Returns the full embedding model spec string (e.g. "ollama:nomic-embed-text")
    pub fn embedding_model_spec(&self) -> String {
        match self.embedding.provider.as_str() {
            "fastembed" => format!("fastembed:{}", self.embedding.model),
            "ollama" => format!("ollama:{}", self.embedding.model),
            "openai" => format!("openai:{}", self.embedding.model),
            "auto" => "auto".into(),
            "mock" => "mock".into(),
            _ => self.embedding.model.clone(),
        }
    }
}

/// Load project configuration from Config.toml (or legacy melvil.config.json)
pub fn load_config(root: &str) -> ProjectConfig {
    let root_path = Path::new(root);

    // Prefer Config.toml
    let toml_path = root_path.join("Config.toml");
    if toml_path.exists() {
        info!("Loading config from: {}", toml_path.display());
        if let Ok(content) = std::fs::read_to_string(&toml_path) {
            match toml::from_str::<ProjectConfig>(&content) {
                Ok(cfg) => return cfg,
                Err(e) => {
                    tracing::warn!("Failed to parse Config.toml: {}", e);
                }
            }
        }
    }

    // Fallback: legacy JSON config
    let json_path = root_path.join("melvil.config.json");
    if json_path.exists() {
        info!("Loading legacy config from: {}", json_path.display());
        if let Ok(content) = std::fs::read_to_string(&json_path) {
            if let Ok(cfg) = serde_json::from_str::<ProjectConfig>(&content) {
                return cfg;
            }
        }
    }

    ProjectConfig::default()
}
