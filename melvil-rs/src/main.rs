use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing::info;

mod cli;
mod chunker;
mod config;
mod embedder;
mod indexer;
mod parser;
mod storage;
mod utils;

#[derive(Parser)]
#[command(name = "melvil")]
#[command(about = "High-performance document indexer and RAG engine")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Build or update the SQLite hybrid index from document content
    Build {
        /// Project root directory
        #[arg(long, default_value = ".")]
        root: String,

        /// Content directory relative to root
        #[arg(long, default_value = ".")]
        content: String,

        /// Output directory for the .footnote index
        #[arg(long, default_value = "./.footnote")]
        out: String,

        /// Remove existing index and rebuild from scratch
        #[arg(long)]
        clean: bool,

        /// Only process changed files
        #[arg(long)]
        incremental: bool,

        /// Include draft documents
        #[arg(long)]
        include_drafts: bool,

        /// Content filter (e.g., brand=eh)
        #[arg(long, value_name = "NAME=VALUE")]
        filter: Vec<String>,

        /// Embedding model (default from Config.toml or fastembed:bge-small-en-v1.5)
        #[arg(long, default_value = "fastembed:bge-small-en-v1.5")]
        embedding_model: String,

        /// Embedding dimensions (auto-detected based on model)
        #[arg(long)]
        embedding_dim: Option<usize>,

        /// Max tokens per chunk
        #[arg(long, default_value_t = 500)]
        max_tokens: usize,

        /// Token overlap between chunks
        #[arg(long, default_value_t = 80)]
        overlap: usize,

        /// Generate .footnote.tar.zst after build
        #[arg(long)]
        compress: bool,

        /// Copy markdown files to footnote index for grep-based search
        #[arg(long)]
        copy_content: bool,

        /// Auto-pull Ollama model if not installed
        #[arg(long)]
        pull: bool,
    },

    /// Ask Melvil a question (agentic RAG assistant with citations)
    Ask {
        /// Path to index directory
        #[arg(long, default_value = "./.footnote")]
        db: String,

        /// Start HTTP web UI instead of single-question mode
        #[arg(long, short = 's')]
        serve: bool,

        /// Port for web server
        #[arg(long, short = 'p', default_value_t = 3000)]
        port: u16,

        /// Show tool calls and reasoning steps
        #[arg(long, short = 'v')]
        verbose: bool,

        /// Show full chunk content in answers
        #[arg(long, short = 'c')]
        chunks: bool,

        /// Interactive REPL mode
        #[arg(long, short = 'i')]
        interactive: bool,

        /// Project root (for loading Config.toml)
        #[arg(long, default_value = ".")]
        root: String,

        /// The question to ask
        question: Option<String>,
    },

    /// Run a test query against an existing index
    Query {
        /// Path to index directory
        #[arg(long, default_value = "./.footnote")]
        db: String,

        /// Query string for hybrid search
        #[arg(long)]
        hybrid: String,

        /// Number of results to return
        #[arg(long, short = 'k', default_value_t = 10)]
        k: usize,
    },

    /// Start an MCP (Model Context Protocol) server for AI assistants
    Mcp {
        /// Path to index directory
        #[arg(long, default_value = "./.footnote")]
        db: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("melvil=info".parse()?),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Build {
            root,
            content,
            out,
            clean,
            incremental,
            include_drafts,
            filter,
            embedding_model,
            embedding_dim,
            max_tokens,
            overlap,
            compress,
            copy_content,
            pull,
        } => {
            // Load Config.toml from root (CLI args override config values)
            let cfg = config::load_config(&root);
            let filters = cli::parse_filters(&filter);

            // CLI defaults match struct defaults, so only override if user explicitly set them
            let effective_model = if embedding_model == "fastembed:bge-small-en-v1.5" {
                cfg.embedding_model_spec()
            } else {
                embedding_model
            };
            let effective_dim = embedding_dim.or(cfg.embedding.dimension);
            let effective_max_tokens = if max_tokens == 500 { cfg.chunking.max_tokens } else { max_tokens };
            let effective_overlap = if overlap == 80 { cfg.chunking.overlap } else { overlap };

            // Handle --pull for Ollama models
            if (pull || cfg.embedding.auto_pull) && effective_model.starts_with("ollama:") {
                let model_name = effective_model.strip_prefix("ollama:").unwrap();
                if !crate::embedder::OllamaEmbedder::is_available(None) {
                    anyhow::bail!("Ollama is not running. Start it with: ollama serve");
                }
                let models = crate::embedder::OllamaEmbedder::list_models(None);
                if !models.iter().any(|m| m.contains(model_name)) {
                    info!("Model '{}' not found locally, pulling...", model_name);
                    crate::embedder::OllamaEmbedder::pull_model(model_name, None)?;
                }
            }

            indexer::build::run_build(indexer::build::BuildOptions {
                root,
                content,
                out,
                clean,
                incremental,
                include_drafts,
                filters,
                embedding_model: effective_model,
                embedding_dim: effective_dim,
                max_tokens: effective_max_tokens,
                overlap: effective_overlap,
                compress,
                copy_content,
                show_download_progress: cfg.embedding.show_download_progress,
                cache_dir: cfg.embedding.cache_dir.clone(),
                config: cfg,
            })
            .await?;
        }
        Commands::Ask {
            db,
            serve,
            port,
            verbose,
            chunks,
            interactive,
            root,
            question,
        } => {
            let cfg = config::load_config(&root);
            cli::ask::run_ask(db, serve, port, verbose, interactive, chunks, question, cfg).await?;
        }
        Commands::Query { db, hybrid, k } => {
            indexer::query::run_query(&db, &hybrid, k).await?;
        }
        Commands::Mcp { db } => {
            cli::mcp::run_mcp(&db).await?;
        }
    }

    Ok(())
}
