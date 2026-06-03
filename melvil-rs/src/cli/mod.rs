pub mod ask;
pub mod mcp;

use std::collections::HashMap;

/// Parse filter arguments like "brand=eh" into a HashMap
pub fn parse_filters(filters: &[String]) -> HashMap<String, String> {
    filters
        .iter()
        .filter_map(|f| {
            let parts: Vec<&str> = f.splitn(2, '=').collect();
            if parts.len() == 2 {
                Some((parts[0].to_string(), parts[1].to_string()))
            } else {
                None
            }
        })
        .collect()
}
