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

use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderValue, RETRY_AFTER};
use reqwest::{Client, RequestBuilder, Response};
use serde_json::{Value, json};

use crate::providers::{ProviderError, ProviderErrorKind, ProviderResult};

const ENDPOINT: &str = "https://api.you.com/mcp?profile=free&tools=you-search";
const PROTOCOL: &str = "2025-06-18";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Disposable session for one search. An interrupted call is never replayed.
/// Cleanup is independent of the caller's timeout and cannot launch a search.
pub(super) struct Session {
  client: Client,
  id: Option<HeaderValue>,
  protocol: &'static str,
  pending: Option<u64>,
}

impl Session {
  pub fn new(client: Client) -> Self {
    Self { client, id: None, protocol: PROTOCOL, pending: None }
  }

  pub async fn initialize(&mut self) -> ProviderResult<()> {
    let result = self
      .rpc(
        1,
        "initialize",
        json!({
          "protocolVersion": PROTOCOL,
          "capabilities": {},
          "clientInfo": { "name": "infumap-web-search", "version": env!("CARGO_PKG_VERSION") }
        }),
      )
      .await?;
    self.protocol = match result.get("protocolVersion").and_then(Value::as_str) {
      Some("2025-03-26") => "2025-03-26",
      Some("2025-06-18") => "2025-06-18",
      Some("2025-11-25") => "2025-11-25",
      Some("2026-07-28") => "2026-07-28",
      _ => return Err(unexpected("You.com MCP negotiated an unsupported protocol version.")),
    };
    if !result.pointer("/capabilities/tools").is_some_and(Value::is_object) {
      return Err(unexpected("You.com MCP did not advertise tool support."));
    }
    let response = self
      .request("notifications/initialized")
      .json(&json!({
        "jsonrpc": "2.0", "method": "notifications/initialized", "params": {}
      }))
      .send()
      .await
      .map_err(request_error)?;
    check_status(&response)?;
    Ok(())
  }

  pub async fn call(&mut self, arguments: Value) -> ProviderResult<Value> {
    self.pending = Some(2);
    let result = self.rpc(2, "tools/call", json!({
      "name": "you-search", "arguments": arguments,
      "_meta": {
        "io.modelcontextprotocol/protocolVersion": self.protocol,
        "io.modelcontextprotocol/clientInfo": { "name": "infumap-web-search", "version": env!("CARGO_PKG_VERSION") },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    })).await;
    // Errors can be uncertain about execution. Drop sends cancellation when a
    // valid reply was not obtained; the persistent local charge still remains.
    if result.is_ok() {
      self.pending = None;
    }
    result
  }

  fn request(&self, method: &'static str) -> RequestBuilder {
    let mut request = self
      .client
      .post(ENDPOINT)
      .header(ACCEPT, "application/json, text/event-stream")
      .header("mcp-protocol-version", self.protocol)
      .header("mcp-method", method)
      .header("x-allowed-tools", "you-search");
    if method == "tools/call" {
      request = request.header("mcp-name", "you-search");
    }
    if let Some(id) = &self.id {
      request = request.header("mcp-session-id", id.clone());
    }
    request
  }

  async fn rpc(&mut self, id: u64, method: &'static str, params: Value) -> ProviderResult<Value> {
    let response = self
      .request(method)
      .json(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
      .send()
      .await
      .map_err(request_error)?;
    check_status(&response)?;
    if method == "initialize"
      && let Some(value) = response.headers().get("mcp-session-id")
    {
      if value.as_bytes().is_empty()
        || value.as_bytes().len() > 1024
        || !value.as_bytes().iter().all(|&byte| (0x21..=0x7e).contains(&byte))
      {
        return Err(unexpected("You.com MCP returned an invalid session identifier."));
      }
      let mut value = value.clone();
      value.set_sensitive(true);
      self.id = Some(value);
    }
    read_reply(response, id).await
  }
}

impl Drop for Session {
  fn drop(&mut self) {
    if self.id.is_none() && self.pending.is_none() {
      return;
    }
    let client = self.client.clone();
    let id = self.id.clone();
    let protocol = self.protocol;
    let pending = self.pending;
    tokio::spawn(async move {
      let headers = |request: RequestBuilder| {
        let request =
          request.header("mcp-protocol-version", protocol).header(ACCEPT, "application/json, text/event-stream");
        if let Some(id) = &id { request.header("mcp-session-id", id.clone()) } else { request }
      };
      if let Some(request_id) = pending {
        let _ = headers(client.post(ENDPOINT))
          .timeout(Duration::from_secs(2))
          .json(&json!({
            "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": request_id }
          }))
          .send()
          .await;
      }
      if id.is_some() {
        let _ = headers(client.delete(ENDPOINT)).timeout(Duration::from_secs(2)).send().await;
      }
    });
  }
}

async fn read_reply(mut response: Response, id: u64) -> ProviderResult<Value> {
  let content_type = response
    .headers()
    .get(CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .unwrap_or("")
    .split(';')
    .next()
    .unwrap_or("")
    .trim()
    .to_ascii_lowercase();
  let streaming = content_type == "text/event-stream";
  if !streaming && content_type != "application/json" {
    return Err(unexpected("You.com MCP returned an unsupported response type."));
  }
  let mut buffer = Vec::new();
  let mut received = 0usize;
  while let Some(chunk) = response.chunk().await.map_err(request_error)? {
    received = received
      .checked_add(chunk.len())
      .filter(|&total| total <= MAX_RESPONSE_BYTES)
      .ok_or_else(|| unexpected("You.com MCP response exceeded the size limit."))?;
    buffer.extend_from_slice(&chunk);
    if streaming {
      while let Some(event) = take_event(&mut buffer) {
        let event = std::str::from_utf8(&event).map_err(|_| unexpected("You.com MCP returned invalid UTF-8."))?;
        let normalized = event.replace("\r\n", "\n").replace('\r', "\n");
        let data = normalized
          .lines()
          .filter_map(|line| line.strip_prefix("data:"))
          .map(|line| line.strip_prefix(' ').unwrap_or(line))
          .collect::<Vec<_>>()
          .join("\n");
        if data.is_empty() {
          continue;
        }
        let message: Value =
          serde_json::from_str(&data).map_err(|_| unexpected("You.com MCP returned invalid event JSON."))?;
        if let Some(result) = matching_reply(message, id)? {
          return Ok(result);
        }
      }
    }
  }
  if !streaming {
    let message: Value =
      serde_json::from_slice(&buffer).map_err(|_| unexpected("You.com MCP returned invalid JSON."))?;
    if let Some(result) = matching_reply(message, id)? {
      return Ok(result);
    }
  }
  Err(unexpected("You.com MCP response ended without a matching JSON-RPC reply."))
}

fn take_event(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
  let (index, size) = [b"\n\n".as_slice(), b"\r\n\r\n".as_slice(), b"\r\r".as_slice()]
    .into_iter()
    .filter_map(|delimiter| {
      buffer.windows(delimiter.len()).position(|window| window == delimiter).map(|index| (index, delimiter.len()))
    })
    .min_by_key(|&(index, _)| index)?;
  let event = buffer[..index].to_vec();
  buffer.drain(..index + size);
  Some(event)
}

fn matching_reply(message: Value, id: u64) -> ProviderResult<Option<Value>> {
  if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
    return Err(unexpected("You.com MCP returned an invalid JSON-RPC envelope."));
  }
  if message.get("id").and_then(Value::as_u64) != Some(id) {
    return Ok(None);
  }
  if let Some(error) = message.get("error") {
    if matches!(error.get("code").and_then(Value::as_i64), Some(-32602..=-32600)) {
      return Err(ProviderError::new(
        ProviderErrorKind::InvalidRequest,
        "You.com MCP rejected the request parameters.",
      ));
    }
    return Err(tool_error(error));
  }
  message
    .get("result")
    .filter(|result| result.is_object())
    .cloned()
    .map(Some)
    .ok_or_else(|| unexpected("You.com MCP reply omitted its result."))
}

pub(super) fn tool_error(value: &Value) -> ProviderError {
  // Inspect error envelopes only. Never include raw messages, queries or bodies
  // in diagnostics. Unknown failures stay transiently unavailable, not empty.
  let mut messages = Vec::new();
  if let Some(message) = value.get("message").and_then(Value::as_str) {
    messages.push(message);
  }
  if let Some(message) = value.get("error").and_then(Value::as_str) {
    messages.push(message);
  }
  if let Some(content) = value.get("content").and_then(Value::as_array) {
    messages.extend(
      content
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str)),
    );
  }
  let text = messages.join("\n").to_ascii_lowercase();
  if (text.contains("daily") && (text.contains("limit") || text.contains("quota"))) || text.contains("quota exceeded") {
    ProviderError::new(ProviderErrorKind::QuotaExhausted, "You.com free daily quota was exhausted.")
  } else if text.contains("rate limit") || text.contains("too many requests") {
    ProviderError::new(ProviderErrorKind::RateLimited, "You.com MCP search was rate limited.")
  } else {
    unexpected("You.com MCP search reported a tool or protocol error.")
  }
}

fn check_status(response: &Response) -> ProviderResult<()> {
  let status = response.status();
  if status.is_success() {
    return Ok(());
  }
  let retry_after = response
    .headers()
    .get(RETRY_AFTER)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.trim().parse::<u64>().ok())
    .map(Duration::from_secs);
  let kind = match status.as_u16() {
    400 | 413 | 414 | 422 => ProviderErrorKind::InvalidRequest,
    401 => ProviderErrorKind::InvalidCredentials,
    402 => ProviderErrorKind::QuotaExhausted,
    403 => ProviderErrorKind::Blocked,
    404 | 408 | 500..=599 => ProviderErrorKind::Transient,
    429 => ProviderErrorKind::RateLimited,
    _ => ProviderErrorKind::UnexpectedResponse,
  };
  Err(ProviderError::new(kind, format!("You.com MCP returned HTTP {status}.")).with_retry_after(retry_after))
}

fn request_error(error: reqwest::Error) -> ProviderError {
  ProviderError::new(
    ProviderErrorKind::Transient,
    if error.is_timeout() { "You.com MCP request timed out." } else { "You.com MCP request failed." },
  )
}

fn unexpected(message: &'static str) -> ProviderError {
  ProviderError::new(ProviderErrorKind::UnexpectedResponse, message)
}
