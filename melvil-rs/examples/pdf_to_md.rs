//! Test script: parse all PDFs in content/ via liteparse and write markdown output
//! Usage: cargo run --example pdf_to_md

use liteparse::{LiteParse, LiteParseConfig};
use std::fs;
use std::path::Path;

#[tokio::main]
async fn main() {
    let content_dir = Path::new("../content");
    let out_dir = Path::new("../docs/pdf-parsed");
    fs::create_dir_all(out_dir).expect("Failed to create output dir");

    let entries: Vec<_> = fs::read_dir(content_dir)
        .expect("Cannot read content/ directory")
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "pdf")
                .unwrap_or(false)
        })
        .collect();

    if entries.is_empty() {
        println!("No PDFs found in {:?}", content_dir);
        return;
    }

    let config = LiteParseConfig {
        ocr_enabled: false,
        quiet: true,
        ..Default::default()
    };
    let parser = LiteParse::new(config);

    for entry in &entries {
        let path = entry.path();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let out_path = out_dir.join(format!("{}.md", stem));

        println!("Parsing: {}", path.display());

        match parser.parse(path.to_str().unwrap()).await {
            Ok(result) => {
                let text = &result.text;
                let line_count = text.lines().count();
                let heading_count = text.lines().filter(|l| l.starts_with('#')).count();

                let mut md = format!("# Parsed: {}\n\n", path.file_name().unwrap().to_str().unwrap());
                md.push_str(&format!(
                    "> {} lines, {} headings detected\n\n---\n\n",
                    line_count, heading_count
                ));
                md.push_str(text);

                fs::write(&out_path, &md).expect("Failed to write output");
                println!(
                    "  → {} ({} lines, {} headings)",
                    out_path.display(),
                    line_count,
                    heading_count
                );
            }
            Err(e) => {
                eprintln!("  ✗ Error: {:?}", e);
            }
        }
    }

    println!("\nDone. Output in {:?}", out_dir);
}
