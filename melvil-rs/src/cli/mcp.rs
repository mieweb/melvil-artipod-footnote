use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use tracing::info;

use crate::embedder::create_embedder;
use crate::storage::SqliteStore;

/// MCP JSON-RPC request
#[derive(Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

/// MCP JSON-RPC response
#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

/// Run the MCP server over stdio
pub async fn run_mcp(db: &str) -> Result<()> {
    let index_path = std::path::Path::new(db).join("index.sqlite");
    let manifest_path = std::path::Path::new(db).join("manifest.json");

    if !index_path.exists() {
        anyhow::bail!("Index not found: {}", index_path.display());
    }

    let manifest_content = std::fs::read_to_string(&manifest_path)?;
    let manifest: Value = serde_json::from_str(&manifest_content)?;
    let model_id = manifest["embedding"]["model_id"].as_str().unwrap_or("bge-small-en-v1.5");
    let dim = manifest["embedding"]["dimension"].as_u64().unwrap_or(384) as usize;

    info!("MCP server starting with model: {} (dim: {})", model_id, dim);

    let embedder = create_embedder(model_id)?;
    let store = SqliteStore::new(index_path.to_str().unwrap(), dim)?;

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {"code": -32700, "message": format!("Parse error: {}", e)}
                });
                writeln!(stdout, "{}", serde_json::to_string(&err_resp)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let _ = request.jsonrpc; // validate presence
        let response = handle_request(&request.method, request.params.as_ref(), embedder.as_ref(), &store);

        let resp = JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: request.id.unwrap_or(Value::Null),
            result: response.as_ref().ok().cloned(),
            error: response.as_ref().err().map(|e| {
                json!({"code": -32603, "message": e.to_string()})
            }),
        };

        writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
        stdout.flush()?;
    }

    Ok(())
}

fn handle_request(
    method: &str,
    params: Option<&Value>,
    embedder: &dyn crate::embedder::Embedder,
    store: &SqliteStore,
) -> Result<Value> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "melvil",
                "version": env!("CARGO_PKG_VERSION")
            }
        })),

        "initialized" => Ok(json!({})),

        "tools/list" => Ok(json!({
            "tools": [
                {
                    "name": "hybrid_search",
                    "description": "Search documentation using hybrid vector + full-text search with reciprocal rank fusion. Returns relevant chunks with citations.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query"},
                            "k": {"type": "integer", "description": "Number of results (default: 5)", "default": 5}
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "fts_search",
                    "description": "Full-text BM25 keyword search across documentation. Best for exact term matching.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query (FTS5 syntax supported)"},
                            "k": {"type": "integer", "description": "Number of results (default: 5)", "default": 5}
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "vector_search",
                    "description": "Pure semantic similarity search. Best for conceptual/meaning-based queries.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query"},
                            "k": {"type": "integer", "description": "Number of results (default: 5)", "default": 5}
                        },
                        "required": ["query"]
                    }
                }
            ]
        })),

        "tools/call" => {
            let params = params.ok_or_else(|| anyhow::anyhow!("Missing params"))?;
            let tool_name = params["name"].as_str().unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let query = args["query"].as_str().unwrap_or("");
            let k = args["k"].as_u64().unwrap_or(5) as usize;

            if query.is_empty() {
                anyhow::bail!("query parameter is required");
            }

            let results = match tool_name {
                "hybrid_search" => {
                    let vecs = embedder.embed(&[query])?;
                    store.hybrid_search(query, &vecs[0], k)?
                }
                "fts_search" => store.fts_search(query, k)?,
                "vector_search" => {
                    let vecs = embedder.embed(&[query])?;
                    store.vector_search(&vecs[0], k)?
                }
                _ => anyhow::bail!("Unknown tool: {}", tool_name),
            };

            let content: Vec<Value> = results
                .iter()
                .map(|r| {
                    json!({
                        "type": "text",
                        "text": format!(
                            "## {} (score: {:.4})\n**Source:** {}\n\n{}",
                            r.title, r.score, r.url, r.content
                        )
                    })
                })
                .collect();

            Ok(json!({"content": content}))
        }

        "ping" => Ok(json!({})),

        _ => Err(anyhow::anyhow!("Method not found: {}", method)),
    }
}
