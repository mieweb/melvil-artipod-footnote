use anyhow::Result;
use axum::{
    extract::State,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

use crate::config::ProjectConfig;
use crate::embedder::{create_embedder, create_embedder_with_config, Embedder, FastEmbedOptions};
use crate::storage::{SearchResult, SqliteStore};

/// Shared state for the web server and ask agent
struct AppState {
    store: SqliteStore,
    embedder: Box<dyn Embedder>,
    model_id: String,
    agent_config: AgentLLMConfig,
}

/// LLM configuration for RAG synthesis
#[derive(Clone)]
struct AgentLLMConfig {
    provider: String,      // "ollama" | "openai" | "llama_cpp" | "none"
    model: String,
    model_path: Option<String>,
    system_prompt: String,
    ollama_url: String,
    openai_key: Option<String>,
    openai_url: String,
    max_iterations: usize,
    n_gpu_layers: Option<u32>,
    ctx_size: usize,
}

impl AgentLLMConfig {
    fn from_project_config(cfg: &ProjectConfig) -> Self {
        let openai_key = std::env::var("OPENAI_API_KEY").ok();
        Self {
            provider: cfg.agent.provider.clone().unwrap_or_else(|| "none".to_string()),
            model: cfg.agent.model.clone().unwrap_or_else(|| "qwen2.5:1.5b".to_string()),
            model_path: cfg.agent.model_path.clone(),
            system_prompt: cfg.agent.system_prompt.clone().unwrap_or_default(),
            ollama_url: cfg.agent.ollama_url.clone().unwrap_or_else(|| "http://localhost:11434".to_string()),
            openai_key,
            openai_url: cfg.embedding.openai_url.as_deref().unwrap_or("https://api.openai.com").to_string(),
            max_iterations: cfg.agent.max_iterations,
            n_gpu_layers: cfg.agent.n_gpu_layers,
            ctx_size: cfg.agent.ctx_size,
        }
    }

    fn is_available(&self) -> bool {
        match self.provider.as_str() {
            "ollama" => {
                let url = format!("{}/api/tags", self.ollama_url);
                reqwest::blocking::get(&url).is_ok()
            }
            "openai" => self.openai_key.is_some(),
            "llama_cpp" => {
                if let Some(ref path) = self.model_path {
                    std::path::Path::new(path).exists()
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}

/// Call LLM to synthesize an answer from context
fn call_llm(config: &AgentLLMConfig, context: &str, question: &str) -> Result<String> {
    let client = reqwest::blocking::Client::new();

    let system = if config.system_prompt.is_empty() {
        "You are a helpful documentation assistant. Answer the question based ONLY on the provided context. Cite sources using [N] notation. If the context doesn't contain the answer, say so.".to_string()
    } else {
        config.system_prompt.clone()
    };

    let user_msg = format!("Context:\n{}\n\nQuestion: {}", context, question);

    match config.provider.as_str() {
        "ollama" => {
            let url = format!("{}/api/chat", config.ollama_url);
            let body = serde_json::json!({
                "model": config.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_msg}
                ],
                "stream": false
            });
            let resp = client.post(&url).json(&body).send()?;
            let json: serde_json::Value = resp.json()?;
            Ok(json["message"]["content"].as_str().unwrap_or("").to_string())
        }
        "openai" => {
            let api_key = config.openai_key.as_deref().unwrap_or("");
            let url = format!("{}/v1/chat/completions", config.openai_url);
            let body = serde_json::json!({
                "model": config.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_msg}
                ],
                "temperature": 0.2
            });
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()?;
            let json: serde_json::Value = resp.json()?;
            Ok(json["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string())
        }
        #[cfg(feature = "llm")]
        "llama_cpp" => {
            call_llm_llama_cpp(config, &system, &user_msg)
        }
        #[cfg(not(feature = "llm"))]
        "llama_cpp" => {
            anyhow::bail!(
                "llama_cpp provider requires the 'llm' feature. Rebuild with:\n  cargo build --release --features llm"
            )
        }
        _ => anyhow::bail!("No LLM configured. Set [agent] provider in Config.toml"),
    }
}

/// Local GGUF model inference via llama-cpp-2
#[cfg(feature = "llm")]
fn call_llm_llama_cpp(config: &AgentLLMConfig, system: &str, user_msg: &str) -> Result<String> {
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::model::LlamaModel;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::sampling::LlamaSampler;

    let model_path = config.model_path.as_deref()
        .ok_or_else(|| anyhow::anyhow!("llama_cpp provider requires 'model_path' in [agent] config"))?;

    if !std::path::Path::new(model_path).exists() {
        anyhow::bail!("GGUF model file not found: {}", model_path);
    }

    // Initialize backend
    let backend = LlamaBackend::init()?;

    // Load model
    let mut model_params = LlamaModelParams::default();
    if let Some(n_gpu) = config.n_gpu_layers {
        model_params = model_params.with_n_gpu_layers(n_gpu);
    }

    let model = LlamaModel::load_from_file(&backend, model_path, &model_params)
        .map_err(|e| anyhow::anyhow!("Failed to load GGUF model: {:?}", e))?;

    // Create context
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(std::num::NonZeroU32::new(config.ctx_size as u32));
    let mut ctx = model.new_context(&backend, ctx_params)
        .map_err(|e| anyhow::anyhow!("Failed to create context: {:?}", e))?;

    // Format prompt using ChatML template
    let prompt = format!(
        "<|im_start|>system\n{}<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n",
        system, user_msg
    );

    // Tokenize
    let tokens = model.str_to_token(&prompt, llama_cpp_2::model::AddBos::Always)
        .map_err(|e| anyhow::anyhow!("Tokenization failed: {:?}", e))?;

    // Create batch and add prompt tokens
    let mut batch = LlamaBatch::new(config.ctx_size, 1);
    for (i, &token) in tokens.iter().enumerate() {
        let is_last = i == tokens.len() - 1;
        batch.add(token, i as i32, &[0], is_last)
            .map_err(|_| anyhow::anyhow!("Failed to add token to batch"))?;
    }

    // Process prompt
    ctx.decode(&mut batch)
        .map_err(|e| anyhow::anyhow!("Decode failed: {:?}", e))?;

    // Create sampler chain: temp → top_p → sample
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::temp(0.3),
        LlamaSampler::top_p(0.9, 1),
        LlamaSampler::greedy(),
    ]);

    // Accept prompt tokens into sampler state
    sampler.accept_many(tokens.iter().copied());

    // Generate tokens
    let mut output = String::new();
    let max_gen_tokens = 2048;
    let eos_token = model.token_eos();
    let mut n_cur = tokens.len() as i32;

    for _ in 0..max_gen_tokens {
        let new_token = sampler.sample(&ctx, -1);
        sampler.accept(new_token);

        if new_token == eos_token {
            break;
        }

        // Decode token to string
        let piece = model.token_to_str(new_token, llama_cpp_2::model::Special::Tokenize)
            .unwrap_or_default();

        // Stop at end-of-turn markers
        if piece.contains("<|im_end|>") || piece.contains("<|endoftext|>") {
            break;
        }
        output.push_str(&piece);

        // Prepare next batch
        batch.clear();
        batch.add(new_token, n_cur, &[0], true)
            .map_err(|_| anyhow::anyhow!("Failed to add token to batch"))?;
        ctx.decode(&mut batch)
            .map_err(|e| anyhow::anyhow!("Decode step failed: {:?}", e))?;
        n_cur += 1;
    }

    Ok(output.trim().to_string())
}

#[derive(Deserialize)]
struct AskRequest {
    question: String,
    #[serde(default = "default_k")]
    k: usize,
}

fn default_k() -> usize {
    5
}

#[derive(Serialize)]
struct AskResponse {
    answer: String,
    sources: Vec<SourceCitation>,
}

#[derive(Serialize)]
struct SourceCitation {
    title: String,
    url: String,
    excerpt: String,
    score: f64,
}

/// Run the ask agent or serve the web UI
pub async fn run_ask(
    db: String,
    serve: bool,
    port: u16,
    verbose: bool,
    interactive: bool,
    _chunks: bool,
    question: Option<String>,
    config: ProjectConfig,
) -> Result<()> {
    let index_path = std::path::Path::new(&db).join("index.sqlite");
    let manifest_path = std::path::Path::new(&db).join("manifest.json");

    if !index_path.exists() {
        anyhow::bail!("Index not found: {}", index_path.display());
    }

    let manifest_content = std::fs::read_to_string(&manifest_path)?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_content)?;
    let model_id = manifest["embedding"]["model_id"]
        .as_str()
        .unwrap_or("bge-small-en-v1.5")
        .to_string();
    let dim = manifest["embedding"]["dimension"].as_u64().unwrap_or(384) as usize;
    let provider = manifest["embedding"]["provider"].as_str().unwrap_or("fastembed");

    // Reconstruct model spec from manifest
    let model_spec = format!("{}:{}", provider, model_id);
    let embedder = create_embedder_with_config(&model_spec, FastEmbedOptions {
        show_download_progress: true,
        cache_dir: None,
    })?;

    let store = SqliteStore::new(index_path.to_str().unwrap(), dim)?;
    let agent_config = AgentLLMConfig::from_project_config(&config);

    if serve {
        info!("Starting Melvil web UI on http://localhost:{}", port);
        run_web_server(store, embedder, model_id, agent_config, port).await?;
    } else if interactive {
        run_interactive_repl(&store, embedder.as_ref(), &agent_config, verbose).await?;
    } else if let Some(q) = question {
        run_cli_ask(&q, &store, embedder.as_ref(), &agent_config, verbose).await?;
    } else {
        println!("Usage: melvil ask \"your question here\"");
        println!("       melvil ask --serve --port 3000");
        println!("       melvil ask -i  (interactive REPL)");
    }
    Ok(())
}

/// Interactive REPL mode
async fn run_interactive_repl(
    store: &SqliteStore,
    embedder: &dyn Embedder,
    agent_config: &AgentLLMConfig,
    verbose: bool,
) -> Result<()> {
    use std::io::{self, BufRead, Write};

    println!("╭─── Melvil Interactive ───╮");
    println!("│ Type your questions.      │");
    println!("│ Type 'quit' or Ctrl+D to  │");
    println!("│ exit.                      │");
    println!("╰───────────────────────────╯\n");

    let stdin = io::stdin();
    loop {
        print!("melvil> ");
        io::stdout().flush()?;
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break; // EOF
        }
        let q = line.trim();
        if q.is_empty() {
            continue;
        }
        if q == "quit" || q == "exit" || q == ":q" {
            break;
        }
        run_cli_ask(q, store, embedder, agent_config, verbose).await?;
        println!();
    }
    println!("\nGoodbye!");
    Ok(())
}

/// CLI ask: retrieve context and synthesize answer
async fn run_cli_ask(
    query: &str,
    store: &SqliteStore,
    embedder: &dyn Embedder,
    agent_config: &AgentLLMConfig,
    verbose: bool,
) -> Result<()> {
    let vecs = embedder.embed(&[query])?;
    let results = store.hybrid_search(query, &vecs[0], 5)?;

    if results.is_empty() {
        println!("No relevant documents found for: \"{}\"", query);
        return Ok(());
    }

    if verbose {
        println!("── Retrieved {} chunks ──\n", results.len());
        for (i, r) in results.iter().enumerate() {
            println!("[{}] {} (score: {:.4})", i + 1, r.title, r.score);
            println!("    {}", r.url);
        }
        println!();
    }

    // Build RAG context
    let context = build_context(&results);

    // Try LLM synthesis
    if agent_config.provider != "none" && agent_config.is_available() {
        match tokio::task::block_in_place(|| call_llm(agent_config, &context, query)) {
            Ok(answer) => {
                println!("╭─── Melvil Answer ───╮\n");
                println!("{}", answer);
                println!("\n── Sources ──");
                for (i, r) in results.iter().enumerate() {
                    println!("  [{}] {} — {}", i + 1, r.title, r.url);
                }
                println!("\n╰─────────────────────╯");
                return Ok(());
            }
            Err(e) => {
                if verbose {
                    eprintln!("LLM call failed ({}), falling back to excerpts", e);
                }
            }
        }
    }

    // Fallback: display retrieved context
    println!("╭─── Melvil Answer ───╮\n");
    println!("Based on {} relevant sources:\n", results.len());
    for (i, r) in results.iter().enumerate() {
        let excerpt = truncate(&r.content, 300);
        println!("  [{}] **{}**", i + 1, r.title);
        println!("      {}", r.url);
        println!("      {}\n", excerpt);
    }
    println!("╰─────────────────────╯");
    if agent_config.provider == "none" {
        println!("\nTo get AI-synthesized answers, configure [agent] in Config.toml");
        println!("  or pipe: melvil ask \"{}\" | llm -s \"Answer using context\"", query);
    }

    Ok(())
}

fn build_context(results: &[SearchResult]) -> String {
    let mut ctx = String::new();
    for (i, r) in results.iter().enumerate() {
        ctx.push_str(&format!("--- Source {} [{}] ---\n", i + 1, r.url));
        ctx.push_str(&r.content);
        ctx.push_str("\n\n");
    }
    ctx
}

/// Axum web server for the UI
async fn run_web_server(
    store: SqliteStore,
    embedder: Box<dyn Embedder>,
    model_id: String,
    agent_config: AgentLLMConfig,
    port: u16,
) -> Result<()> {
    let state = Arc::new(Mutex::new(AppState {
        store,
        embedder,
        model_id,
        agent_config,
    }));

    let app = Router::new()
        .route("/", get(serve_ui))
        .route("/api/search", post(api_search))
        .route("/api/ask", post(api_ask))
        .route("/api/health", get(api_health))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("Melvil web UI: http://localhost:{}", port);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn serve_ui() -> Html<&'static str> {
    Html(include_str!("../ui/index.html"))
}

async fn api_health(State(state): State<Arc<Mutex<AppState>>>) -> impl IntoResponse {
    let st = state.lock().await;
    let count = st.store.chunk_count().unwrap_or(0);
    Json(serde_json::json!({
        "status": "ok",
        "model": st.model_id,
        "chunks": count
    }))
}

async fn api_search(
    State(state): State<Arc<Mutex<AppState>>>,
    Json(req): Json<AskRequest>,
) -> impl IntoResponse {
    let st = state.lock().await;
    let vecs = match st.embedder.embed(&[req.question.as_str()]) {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({"error": e.to_string()})),
    };

    let results = match st.store.hybrid_search(&req.question, &vecs[0], req.k) {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({"error": e.to_string()})),
    };

    let sources: Vec<SourceCitation> = results
        .iter()
        .map(|r| SourceCitation {
            title: r.title.clone(),
            url: r.url.clone(),
            excerpt: truncate(&r.content, 500),
            score: r.score,
        })
        .collect();

    Json(serde_json::json!({"results": sources}))
}

async fn api_ask(
    State(state): State<Arc<Mutex<AppState>>>,
    Json(req): Json<AskRequest>,
) -> impl IntoResponse {
    let st = state.lock().await;
    let vecs = match st.embedder.embed(&[req.question.as_str()]) {
        Ok(v) => v,
        Err(e) => {
            return Json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let results = match st.store.hybrid_search(&req.question, &vecs[0], req.k) {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({"error": e.to_string()})),
    };

    let sources: Vec<SourceCitation> = results
        .iter()
        .map(|r| SourceCitation {
            title: r.title.clone(),
            url: r.url.clone(),
            excerpt: truncate(&r.content, 500),
            score: r.score,
        })
        .collect();

    // Try LLM synthesis
    let context = build_context(&results);
    let answer = if st.agent_config.provider != "none" && st.agent_config.is_available() {
        match call_llm(&st.agent_config, &context, &req.question) {
            Ok(a) => a,
            Err(_) => fallback_answer(&results),
        }
    } else {
        fallback_answer(&results)
    };

    Json(serde_json::json!(AskResponse { answer, sources }))
}

fn fallback_answer(results: &[SearchResult]) -> String {
    if results.is_empty() {
        return "No relevant documents found.".to_string();
    }
    let mut ans = format!("Based on {} sources:\n\n", results.len());
    for (i, r) in results.iter().enumerate() {
        ans.push_str(&format!("**[{}] {}**\n{}\n\n", i + 1, r.title, truncate(&r.content, 300)));
    }
    ans
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}
