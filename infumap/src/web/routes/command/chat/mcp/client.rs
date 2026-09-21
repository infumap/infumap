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

use infusdk::util::infu::InfuResult;
use reqwest::Url;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

use super::config::ChatToolServer;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
const HEADER_PROTOCOL_VERSION: &str = "mcp-protocol-version";
const HEADER_SESSION_ID: &str = "mcp-session-id";
/// Kept short whatever a server's own timeout is: a host that cannot be
/// reached at all should say so quickly, rather than spending the call's whole
/// budget failing to connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 5;
const MAX_TOOLS_LIST_PAGES: usize = 20;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpTool {
  pub name: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(rename = "inputSchema")]
  pub input_schema: Value,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub annotations: Option<McpToolAnnotations>,
  #[serde(flatten)]
  pub extra: HashMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpToolAnnotations {
  #[serde(rename = "readOnlyHint", default)]
  pub read_only_hint: bool,
  #[serde(flatten)]
  pub extra: HashMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct McpIcon {
  pub src: String,
  #[serde(rename = "mimeType", default, skip_serializing_if = "Option::is_none")]
  pub mime_type: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub sizes: Option<Vec<String>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub theme: Option<String>,
}

#[derive(Deserialize)]
struct McpServerInfo {
  #[serde(default)]
  icons: Vec<McpIcon>,
}

#[derive(Clone, Debug)]
pub struct McpSession {
  pub protocol_version: String,
  pub session_id: Option<String>,
  pub icons: Vec<McpIcon>,
  pub tools: Vec<McpTool>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
  #[serde(default)]
  result: Option<Value>,
  #[serde(default)]
  error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
  #[serde(default)]
  message: Option<String>,
}

#[derive(Deserialize)]
struct InitializeResult {
  #[serde(rename = "protocolVersion", default)]
  protocol_version: Option<String>,
  #[serde(rename = "serverInfo", default)]
  server_info: Option<McpServerInfo>,
}

#[derive(Deserialize)]
struct ToolsListResult {
  #[serde(default)]
  tools: Vec<McpTool>,
  #[serde(rename = "nextCursor", default)]
  next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct ToolsCallResult {
  #[serde(default)]
  content: Vec<McpContent>,
  #[serde(rename = "isError", default)]
  is_error: bool,
  #[serde(rename = "structuredContent", default)]
  structured_content: Option<Value>,
}

#[derive(Deserialize)]
struct McpContent {
  #[serde(rename = "type", default)]
  content_type: String,
  #[serde(default)]
  text: Option<String>,
}

pub fn host_key(url: &Url) -> Option<(String, u16)> {
  Some((url.host_str()?.trim_end_matches('.').to_ascii_lowercase(), url.port_or_known_default()?))
}

fn same_host_redirects(origin: Url) -> reqwest::redirect::Policy {
  reqwest::redirect::Policy::custom(move |attempt| {
    if host_key(attempt.url()) != host_key(&origin) {
      return attempt.error("redirect to a different host");
    }
    if attempt.previous().len() >= MAX_REDIRECTS {
      return attempt.error("too many redirects");
    }
    attempt.follow()
  })
}

fn http_client(server: &ChatToolServer) -> InfuResult<reqwest::Client> {
  reqwest::Client::builder()
    .redirect(same_host_redirects(server.url.clone()))
    .connect_timeout(CONNECT_TIMEOUT)
    .timeout(server.timeout)
    .build()
    .map_err(|e| format!("Could not build MCP HTTP client for '{}': {e}", server.id).into())
}

fn request_headers(server: &ChatToolServer, protocol_version: &str, session_id: Option<&str>) -> InfuResult<HeaderMap> {
  let mut headers = HeaderMap::new();
  headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/event-stream"));
  headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
  headers.insert(
    HEADER_PROTOCOL_VERSION,
    HeaderValue::from_str(protocol_version)
      .map_err(|e| format!("Invalid MCP protocol version '{protocol_version}': {e}"))?,
  );
  if let Some(token) = &server.bearer_token {
    let value = format!("Bearer {token}");
    headers.insert(AUTHORIZATION, HeaderValue::from_str(&value).map_err(|e| format!("Invalid MCP bearer token: {e}"))?);
  }
  if let Some(session_id) = session_id {
    headers.insert(
      HEADER_SESSION_ID,
      HeaderValue::from_str(session_id).map_err(|e| format!("Invalid MCP session id: {e}"))?,
    );
  }
  Ok(headers)
}

fn content_type_is_json(headers: &HeaderMap) -> bool {
  headers
    .get(CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .map(|value| {
      let lowered = value.to_ascii_lowercase();
      lowered.starts_with("application/json") || lowered.starts_with("text/javascript")
    })
    .unwrap_or(false)
}

async fn post_rpc(
  client: &reqwest::Client,
  server: &ChatToolServer,
  protocol_version: &str,
  session_id: Option<&str>,
  body: Value,
) -> InfuResult<(Option<String>, Value)> {
  let response = client
    .post(server.url.clone())
    .headers(request_headers(server, protocol_version, session_id)?)
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("MCP server '{}': request failed: {e}", server.id))?;
  let status = response.status();
  let next_session = response.headers().get(HEADER_SESSION_ID).and_then(|value| value.to_str().ok()).map(str::to_owned);
  if !content_type_is_json(response.headers()) {
    let content_type = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("unknown");
    if content_type.to_ascii_lowercase().starts_with("text/event-stream") {
      return Err(format!("MCP server '{}' returned an event stream; JSON responses are required.", server.id).into());
    }
  }
  let text = response.text().await.map_err(|e| format!("MCP server '{}': could not read body: {e}", server.id))?;
  if !status.is_success() {
    return Err(format!("MCP server '{}' returned HTTP {status}: {text}", server.id).into());
  }
  if text.trim().is_empty() {
    return Ok((next_session, json!({})));
  }
  let parsed: Value =
    serde_json::from_str(&text).map_err(|e| format!("MCP server '{}': invalid JSON-RPC response: {e}", server.id))?;
  Ok((next_session, parsed))
}

async fn rpc(
  client: &reqwest::Client,
  server: &ChatToolServer,
  protocol_version: &str,
  session_id: Option<&str>,
  id: u64,
  method: &str,
  params: Value,
) -> InfuResult<(Option<String>, Value)> {
  let (next_session, parsed) = post_rpc(
    client,
    server,
    protocol_version,
    session_id,
    json!({
      "jsonrpc": "2.0",
      "id": id,
      "method": method,
      "params": params
    }),
  )
  .await?;
  let response: JsonRpcResponse = serde_json::from_value(parsed)
    .map_err(|e| format!("MCP server '{}': could not parse JSON-RPC envelope: {e}", server.id))?;
  if let Some(error) = response.error {
    return Err(
      format!("MCP server '{}': {method} failed: {}", server.id, error.message.unwrap_or_else(|| "error".to_owned()))
        .into(),
    );
  }
  Ok((next_session, response.result.unwrap_or(Value::Null)))
}

async fn notify(
  client: &reqwest::Client,
  server: &ChatToolServer,
  protocol_version: &str,
  session_id: Option<&str>,
  method: &str,
  params: Value,
) -> InfuResult<Option<String>> {
  let (next_session, _) = post_rpc(
    client,
    server,
    protocol_version,
    session_id,
    json!({
      "jsonrpc": "2.0",
      "method": method,
      "params": params
    }),
  )
  .await?;
  Ok(next_session)
}

/// Map a tools/call result onto the string Infumap already sends back as a tool message.
pub fn tool_result_text(result: &Value) -> InfuResult<String> {
  let parsed: ToolsCallResult =
    serde_json::from_value(result.clone()).map_err(|e| format!("Could not parse MCP tools/call result: {e}"))?;
  if let Some(structured) = parsed.structured_content {
    return serde_json::to_string(&structured)
      .map_err(|e| format!("Could not serialize MCP structuredContent: {e}").into());
  }
  let mut texts = Vec::new();
  for item in parsed.content {
    if item.content_type.is_empty() || item.content_type == "text" {
      if let Some(text) = item.text {
        texts.push(text);
      }
    }
  }
  let joined = texts.join("\n");
  if parsed.is_error && joined.is_empty() {
    return Ok(json!({ "error": "Tool call failed." }).to_string());
  }
  Ok(joined)
}

pub async fn initialize_and_list_tools(server: &ChatToolServer) -> InfuResult<McpSession> {
  let client = http_client(server)?;
  let (session_id, result) = rpc(
    &client,
    server,
    PROTOCOL_VERSION,
    None,
    1,
    "initialize",
    json!({
      "protocolVersion": PROTOCOL_VERSION,
      "capabilities": {},
      "clientInfo": { "name": "infumap", "version": env!("CARGO_PKG_VERSION") }
    }),
  )
  .await?;
  let initialize: InitializeResult = serde_json::from_value(result)
    .map_err(|e| format!("MCP server '{}': could not parse initialize result: {e}", server.id))?;
  let protocol_version = initialize
    .protocol_version
    .map(|version| version.trim().to_owned())
    .filter(|version| !version.is_empty())
    .unwrap_or_else(|| PROTOCOL_VERSION.to_owned());
  let session_id =
    notify(&client, server, &protocol_version, session_id.as_deref(), "notifications/initialized", json!({}))
      .await?
      .or(session_id);

  let mut tools = Vec::new();
  let mut cursor: Option<String> = None;
  for page in 0..MAX_TOOLS_LIST_PAGES {
    let params = match &cursor {
      Some(cursor) => json!({ "cursor": cursor }),
      None => json!({}),
    };
    let (listed_session, result) =
      rpc(&client, server, &protocol_version, session_id.as_deref(), 2 + page as u64, "tools/list", params).await?;
    let _ = listed_session;
    let page: ToolsListResult = serde_json::from_value(result)
      .map_err(|e| format!("MCP server '{}': could not parse tools/list result: {e}", server.id))?;
    tools.extend(page.tools);
    match page.next_cursor.map(|c| c.trim().to_owned()).filter(|c| !c.is_empty()) {
      Some(next) => cursor = Some(next),
      None => break,
    }
  }

  Ok(McpSession {
    protocol_version,
    session_id,
    icons: initialize.server_info.map(|info| info.icons).unwrap_or_default(),
    tools,
  })
}

pub async fn call_tool(
  server: &ChatToolServer,
  session: &McpSession,
  name: &str,
  arguments: Value,
) -> InfuResult<String> {
  let client = http_client(server)?;
  let (_next_session, result) = rpc(
    &client,
    server,
    &session.protocol_version,
    session.session_id.as_deref(),
    1,
    "tools/call",
    json!({ "name": name, "arguments": arguments }),
  )
  .await?;
  tool_result_text(&result)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn host_key_ignores_path() {
    let a = Url::parse("http://127.0.0.1:8791/mcp").unwrap();
    let b = Url::parse("http://127.0.0.1:8791/other").unwrap();
    let c = Url::parse("http://evil.example/mcp").unwrap();
    assert_eq!(host_key(&a), host_key(&b));
    assert_ne!(host_key(&a), host_key(&c));
  }

  #[test]
  fn tool_result_prefers_structured_content() {
    let value = json!({
      "content": [{ "type": "text", "text": "ignored" }],
      "structuredContent": { "ok": true }
    });
    assert_eq!(tool_result_text(&value).unwrap(), r#"{"ok":true}"#);
  }

  #[test]
  fn tool_result_joins_text_content() {
    let value = json!({
      "content": [
        { "type": "text", "text": "one" },
        { "type": "text", "text": "two" }
      ]
    });
    assert_eq!(tool_result_text(&value).unwrap(), "one\ntwo");
  }
}
