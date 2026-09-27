use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use liteparse::{LiteParse, LiteParseConfig};
use regex::Regex;

use crate::config::{ShortcodeRule, ProjectConfig};

/// A parsed document
pub struct ParsedDocument {
    pub title: String,
    pub content: String,
    pub headings: Vec<String>,
    pub front_matter: Option<serde_json::Value>,
}

/// Check if a document should be included based on front matter filters
pub fn should_include_document(
    doc: &ParsedDocument,
    filters: &HashMap<String, String>,
    include_drafts: bool,
    config: &ProjectConfig,
) -> bool {
    let fm = match &doc.front_matter {
        Some(fm) => fm,
        None => return true, // No front matter = include by default
    };

    // Check draft status
    if !include_drafts {
        if let Some(draft) = fm.get("draft") {
            if draft.as_bool().unwrap_or(false) || draft.as_str() == Some("true") {
                return false;
            }
        }
    }

    // Check CLI filters (e.g., brand=eh)
    for (key, value) in filters {
        if let Some(fm_val) = fm.get(key) {
            let fm_str = fm_val.as_str().unwrap_or("");
            if fm_str != value {
                return false;
            }
        } else {
            // Field not present - check config for default
            if let Some(filter_cfg) = config.filters.get(key) {
                if let Some(default_val) = &filter_cfg.default {
                    if default_val != value {
                        return false;
                    }
                }
            }
        }
    }

    // Check config-defined filters
    for (name, filter_cfg) in &config.filters {
        if filters.contains_key(name) {
            continue; // Already handled by CLI filter
        }
        let fm_val = fm
            .get(&filter_cfg.field)
            .and_then(|v| v.as_str())
            .unwrap_or(filter_cfg.default.as_deref().unwrap_or(""));

        if !filter_cfg.include.is_empty() && !filter_cfg.include.contains(&fm_val.to_string()) {
            return false;
        }
        if filter_cfg.exclude.contains(&fm_val.to_string()) {
            return false;
        }
    }

    true
}

/// Process shortcodes in content using configured rules
pub fn process_shortcodes(content: &str, config: &ProjectConfig) -> String {
    if config.shortcodes.is_empty() && config.substitutions.is_empty() {
        return content.to_string();
    }

    let mut result = content.to_string();

    // Process block shortcodes: {{% name %}}content{{% /name %}} and {{< name >}}content{{< /name >}}
    let block_re = Regex::new(r#"\{\{[<%]\s*(\w+)(?:\s+[^%>]*)?\s*[%>]\}\}([\s\S]*?)\{\{[<%]\s*/\1\s*[%>]\}\}"#).unwrap();

    result = block_re.replace_all(&result, |caps: &regex::Captures| {
        let name = &caps[1];
        let inner = &caps[2];

        if let Some(rule) = config.shortcodes.get(name) {
            apply_shortcode_rule(rule, inner)
        } else {
            inner.trim().to_string()
        }
    }).to_string();

    // Process inline shortcodes: {{< name args >}} and {{% name args %}}
    let inline_re = Regex::new(r#"\{\{[<%]\s*(\w+)(?:\s+[^%>]*)?\s*[%>]\}\}"#).unwrap();
    result = inline_re.replace_all(&result, |caps: &regex::Captures| {
        let name = &caps[1];
        if let Some(rule) = config.shortcodes.get(name) {
            if rule.skip { return String::new(); }
            if let Some(ref replacement) = rule.replacement {
                return replacement.clone();
            }
        }
        String::new()
    }).to_string();

    // Apply text substitutions
    for (find, replace) in &config.substitutions {
        result = result.replace(find, replace);
    }

    result
}

fn apply_shortcode_rule(rule: &ShortcodeRule, inner: &str) -> String {
    if rule.skip {
        return String::new();
    }
    if rule.extract_content {
        return inner.trim().to_string();
    }
    if let Some(ref replacement) = rule.replacement {
        return format!("{} {}", replacement, inner.trim());
    }
    inner.trim().to_string()
}

/// Parse a file based on its extension
pub fn parse_file(path: &Path) -> Result<ParsedDocument> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "md" | "markdown" => parse_markdown(path),
        "pdf" => parse_pdf(path),
        "docx" => parse_docx(path),
        "txt" => parse_text(path),
        _ => anyhow::bail!("Unsupported file type: .{}", ext),
    }
}

/// Parse a markdown file using pulldown-cmark
fn parse_markdown(path: &Path) -> Result<ParsedDocument> {
    let content = std::fs::read_to_string(path)?;

    // Extract front matter if present
    let (front_matter, body) = extract_front_matter(&content);

    // Extract title from front matter or first heading
    let title = front_matter
        .as_ref()
        .and_then(|fm| fm.get("title"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| extract_first_heading(&body));

    // Extract headings from markdown
    let headings = extract_headings(&body);

    Ok(ParsedDocument {
        title,
        content: body,
        headings,
        front_matter,
    })
}

/// Parse a PDF file using liteparse
fn parse_pdf(path: &Path) -> Result<ParsedDocument> {
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let config = LiteParseConfig {
        ocr_enabled: false,
        quiet: true,
        ..Default::default()
    };
    let parser = LiteParse::new(config);
    let path_str = path.to_str().unwrap().to_string();

    // Use block_in_place to allow blocking within a tokio context
    let result = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(parser.parse(&path_str))
    })?;

    let content = result.text;
    if content.trim().is_empty() {
        anyhow::bail!("PDF produced no text content: {}", path.display());
    }

    let headings = extract_headings_from_text(&content);

    Ok(ParsedDocument {
        title,
        content,
        headings,
        front_matter: None,
    })
}

/// Parse a DOCX file using liteparse
fn parse_docx(path: &Path) -> Result<ParsedDocument> {
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let config = LiteParseConfig {
        ocr_enabled: false,
        quiet: true,
        ..Default::default()
    };
    let parser = LiteParse::new(config);
    let path_str = path.to_str().unwrap().to_string();

    let result = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(parser.parse(&path_str))
    })?;

    let content = result.text;
    let headings = extract_headings_from_text(&content);

    Ok(ParsedDocument {
        title,
        content,
        headings,
        front_matter: None,
    })
}

/// Extract headings from plain text (lines that look like titles: short, no punctuation at end)
fn extract_headings_from_text(content: &str) -> Vec<String> {
    content
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty()
                && trimmed.len() < 100
                && trimmed.len() > 2
                && (trimmed.chars().next().map(|c| c.is_uppercase()).unwrap_or(false))
                && !trimmed.ends_with('.')
                && !trimmed.ends_with(',')
                && trimmed.chars().filter(|c| c.is_whitespace()).count() < 10
        })
        .take(20) // cap at 20 headings
        .map(|s| s.trim().to_string())
        .collect()
}

/// Parse a plain text file
fn parse_text(path: &Path) -> Result<ParsedDocument> {
    let content = std::fs::read_to_string(path)?;
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    Ok(ParsedDocument {
        title,
        content,
        headings: vec![],
        front_matter: None,
    })
}

/// Extract YAML front matter from markdown content
fn extract_front_matter(content: &str) -> (Option<serde_json::Value>, String) {
    if !content.starts_with("---") {
        return (None, content.to_string());
    }

    if let Some(end) = content[3..].find("---") {
        let yaml_str = &content[3..3 + end];
        let body = &content[3 + end + 3..];

        // Try parsing as YAML (convert to JSON value)
        let fm: Option<serde_json::Value> = serde_yaml_to_json(yaml_str);
        (fm, body.trim().to_string())
    } else {
        (None, content.to_string())
    }
}

/// Simple YAML-like front matter to JSON (basic key: value pairs)
fn serde_yaml_to_json(yaml: &str) -> Option<serde_json::Value> {
    let mut map = serde_json::Map::new();
    for line in yaml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim().to_string();
            let value = line[colon_pos + 1..].trim().to_string();
            // Remove quotes if present
            let value = value.trim_matches('"').trim_matches('\'').to_string();
            map.insert(key, serde_json::Value::String(value));
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(map))
    }
}

/// Extract the first heading from markdown
fn extract_first_heading(content: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            return trimmed[2..].trim().to_string();
        }
    }
    "Untitled".to_string()
}

/// Extract all headings from markdown
fn extract_headings(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                let heading = trimmed.trim_start_matches('#').trim().to_string();
                if !heading.is_empty() {
                    return Some(heading);
                }
            }
            None
        })
        .collect()
}
