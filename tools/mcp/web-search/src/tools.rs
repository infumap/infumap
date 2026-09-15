// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::fetch::{self, DEFAULT_MAX_CHARS, MAX_CHARS_CAP};
use crate::search::{self, DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP};

#[derive(Deserialize)]
struct WebSearchArguments {
  query: Option<String>,
  text: Option<String>,
  #[serde(rename = "numResults")]
  num_results: Option<i64>,
}

#[derive(Deserialize)]
struct FetchPageArguments {
  url: Option<String>,
  #[serde(rename = "maxChars")]
  max_chars: Option<i64>,
}

pub fn tools_list() -> Value {
  json!({
    "tools": [
      {
        "name": "web_search",
        "title": "Search the web",
        "description": "Search the public web.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Web search query."
            },
            "numResults": {
              "type": "integer",
              "minimum": 1,
              "maximum": MAX_RESULTS_CAP,
              "description": "Maximum number of search results to return."
            }
          },
          "required": ["query"],
          "additionalProperties": false
        },
        "annotations": { "readOnlyHint": true }
      },
      {
        "name": "fetch_page",
        "title": "Fetch page",
        "description": "Read an HTTP or HTTPS URL.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "description": "HTTP or HTTPS URL to fetch."
            },
            "maxChars": {
              "type": "integer",
              "minimum": 1,
              "maximum": MAX_CHARS_CAP,
              "description": "Maximum number of characters of page text to return."
            }
          },
          "required": ["url"],
          "additionalProperties": false
        },
        "annotations": { "readOnlyHint": true }
      }
    ]
  })
}

fn tool_error_json(message: &str) -> String {
  json!({ "error": message }).to_string()
}

fn tool_result(text: String, is_error: bool) -> Value {
  json!({
    "content": [{ "type": "text", "text": text }],
    "isError": is_error
  })
}

/// Execute a named tool. Failures are returned as MCP `isError` results, not JSON-RPC errors.
pub async fn call_tool(name: &str, arguments: Value) -> Value {
  match name {
    "web_search" => call_web_search(arguments).await,
    "fetch_page" => call_fetch_page(arguments).await,
    other => tool_result(tool_error_json(&format!("Unknown tool '{other}'.")), true),
  }
}

async fn call_web_search(arguments: Value) -> Value {
  let arguments: WebSearchArguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(e) => {
      return tool_result(tool_error_json(&format!("Could not parse web_search tool arguments: {}", e)), true);
    }
  };
  let query = arguments.query.or(arguments.text).unwrap_or_default();
  if query.trim().is_empty() {
    return tool_result(tool_error_json("web_search tool argument 'query' is required."), true);
  }
  let num_results =
    arguments.num_results.unwrap_or(DEFAULT_MAX_RESULTS as i64).clamp(1, MAX_RESULTS_CAP as i64) as usize;
  match search::search_web_json(&query, num_results).await {
    Ok(response) => tool_result(response, false),
    Err(e) => tool_result(tool_error_json(&e.to_string()), true),
  }
}

async fn call_fetch_page(arguments: Value) -> Value {
  let arguments: FetchPageArguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(e) => {
      return tool_result(tool_error_json(&format!("Could not parse fetch_page tool arguments: {}", e)), true);
    }
  };
  let url = arguments.url.unwrap_or_default();
  if url.trim().is_empty() {
    return tool_result(tool_error_json("fetch_page tool argument 'url' is required."), true);
  }
  let max_chars = arguments.max_chars.unwrap_or(DEFAULT_MAX_CHARS as i64).clamp(1, MAX_CHARS_CAP as i64) as usize;
  match fetch::fetch_page_json(&url, max_chars).await {
    Ok(response) => tool_result(response, false),
    Err(e) => tool_result(tool_error_json(&e.to_string()), true),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn web_search_requires_query() {
    let result = call_tool("web_search", json!({})).await;
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("query"), "{text}");
  }

  #[tokio::test]
  async fn fetch_page_requires_url() {
    let result = call_tool("fetch_page", json!({})).await;
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("url"), "{text}");
  }

  #[tokio::test]
  async fn unknown_tool_is_error() {
    let result = call_tool("not_a_tool", json!({})).await;
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Unknown tool"), "{text}");
  }

  #[tokio::test]
  async fn fetch_page_blocks_loopback() {
    let result = call_tool("fetch_page", json!({ "url": "http://127.0.0.1/" })).await;
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Blocked"), "{text}");
  }
}
