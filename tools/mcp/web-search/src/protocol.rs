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

use std::net::IpAddr;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Body;
use hyper::header::{
  ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
  ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_MAX_AGE, ALLOW, CONTENT_TYPE, HeaderValue, ORIGIN,
};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::tools::{call_tool, tools_list};

pub const PROTOCOL_VERSION_2025_06_18: &str = "2025-06-18";
pub const PROTOCOL_VERSION_2025_11_25: &str = "2025-11-25";
pub const SERVER_NAME: &str = "infumap-web-search";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const JSON_BODY_MAX_BYTES: usize = 1024 * 1024;
const HEADER_PROTOCOL_VERSION: &str = "mcp-protocol-version";
const CORS_ALLOW_HEADERS: &str = "content-type, accept, mcp-protocol-version, mcp-session-id";
const CORS_EXPOSE_HEADERS: &str = "mcp-protocol-version, mcp-session-id";

#[derive(Deserialize)]
struct IncomingMessage {
  jsonrpc: Option<String>,
  #[serde(default)]
  id: Option<Value>,
  method: Option<String>,
  #[serde(default)]
  params: Value,
  result: Option<Value>,
  error: Option<Value>,
}

/// True when the Origin header is absent (non-browser clients) or names a loopback host.
pub fn origin_is_allowed(origin: Option<&str>) -> bool {
  let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
    return true;
  };
  if origin.eq_ignore_ascii_case("null") {
    return false;
  }
  let Ok(url) = reqwest::Url::parse(origin) else {
    return false;
  };
  if url.scheme() != "http" && url.scheme() != "https" {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  let lowered = host.trim_end_matches('.').to_ascii_lowercase();
  let host = lowered.strip_prefix('[').and_then(|value| value.strip_suffix(']')).unwrap_or(&lowered);
  if host == "localhost" || host.ends_with(".localhost") {
    return true;
  }
  host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

fn protocol_version_supported(version: &str) -> bool {
  matches!(version.trim(), "2025-03-26" | PROTOCOL_VERSION_2025_06_18 | PROTOCOL_VERSION_2025_11_25)
}

fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
  match requested.map(str::trim) {
    Some(PROTOCOL_VERSION_2025_11_25) => PROTOCOL_VERSION_2025_11_25,
    _ => PROTOCOL_VERSION_2025_06_18,
  }
}

fn mcp_path(path: &str) -> bool {
  path.trim_end_matches('/') == "/mcp"
}

fn empty_body() -> Full<Bytes> {
  Full::new(Bytes::new())
}

fn json_body(value: &Value) -> Full<Bytes> {
  Full::new(Bytes::from(value.to_string()))
}

fn apply_cors(builder: hyper::http::response::Builder, origin: Option<&str>) -> hyper::http::response::Builder {
  let Some(origin) = origin.filter(|value| origin_is_allowed(Some(value))) else {
    return builder;
  };
  builder
    .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
    .header(ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS")
    .header(ACCESS_CONTROL_ALLOW_HEADERS, CORS_ALLOW_HEADERS)
    .header(ACCESS_CONTROL_EXPOSE_HEADERS, CORS_EXPOSE_HEADERS)
    .header(ACCESS_CONTROL_MAX_AGE, "86400")
}

fn apply_protocol_version(builder: hyper::http::response::Builder, version: &str) -> hyper::http::response::Builder {
  match HeaderValue::from_str(version) {
    Ok(value) => builder.header(HEADER_PROTOCOL_VERSION, value),
    Err(_) => builder,
  }
}

fn response(
  status: StatusCode,
  origin: Option<&str>,
  protocol_version: &str,
  body: Full<Bytes>,
  extra: impl FnOnce(hyper::http::response::Builder) -> hyper::http::response::Builder,
) -> Response<Full<Bytes>> {
  let builder = Response::builder().status(status);
  let builder = apply_cors(builder, origin);
  let builder = apply_protocol_version(builder, protocol_version);
  extra(builder).body(body).unwrap_or_else(|_| Response::builder().status(500).body(empty_body()).unwrap())
}

async fn read_body<B>(body: B) -> Result<Vec<u8>, String>
where
  B: Body + Unpin,
  B::Error: std::fmt::Display,
{
  let collected = body.collect().await.map_err(|e| format!("Could not read request body: {e}"))?;
  let bytes = collected.to_bytes();
  if bytes.len() > JSON_BODY_MAX_BYTES {
    return Err(format!("Request body exceeds max size (>{} bytes).", JSON_BODY_MAX_BYTES));
  }
  Ok(bytes.to_vec())
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
  json!({
    "jsonrpc": "2.0",
    "id": id,
    "error": { "code": code, "message": message }
  })
}

fn rpc_result(id: Value, result: Value) -> Value {
  json!({
    "jsonrpc": "2.0",
    "id": id,
    "result": result
  })
}

fn initialize_result(params: &Value) -> Value {
  let requested = params.get("protocolVersion").and_then(Value::as_str);
  json!({
    "protocolVersion": negotiate_protocol_version(requested),
    "capabilities": { "tools": {} },
    "serverInfo": {
      "name": SERVER_NAME,
      "version": SERVER_VERSION,
      "icons": [{
        "src": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='1.8'%3E%3Ccircle cx='10.5' cy='10.5' r='6.5'/%3E%3Cpath d='m15.4 15.4 5 5M4.5 10.5h12M10.5 4a10 10 0 0 1 0 13M10.5 4a10 10 0 0 0 0 13'/%3E%3C/svg%3E",
        "mimeType": "image/svg+xml",
        "sizes": ["any"]
      }]
    }
  })
}

async fn dispatch_method(method: &str, params: Value) -> Result<Value, (i64, String)> {
  match method {
    "initialize" => Ok(initialize_result(&params)),
    "notifications/initialized" => Ok(json!({})),
    "ping" => Ok(json!({})),
    "tools/list" => Ok(tools_list()),
    "tools/call" => {
      let name = params.get("name").and_then(Value::as_str).unwrap_or("").trim();
      if name.is_empty() {
        return Err((-32602, "Invalid params: missing tool name.".to_owned()));
      }
      let arguments = match params.get("arguments") {
        None | Some(Value::Null) => json!({}),
        Some(value) => value.clone(),
      };
      Ok(call_tool(name, arguments).await)
    }
    _ => Err((-32601, "Method not found".to_owned())),
  }
}

async fn handle_rpc(message: IncomingMessage) -> Option<Value> {
  if message.method.is_none() && (message.result.is_some() || message.error.is_some()) {
    return None;
  }
  let id = message.id.clone();
  let is_notification = id.is_none();
  if message.jsonrpc.as_deref() != Some("2.0") {
    if is_notification {
      return None;
    }
    return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Invalid Request"));
  }
  let Some(method) = message.method.as_deref() else {
    if is_notification {
      return None;
    }
    return Some(rpc_error(id.unwrap_or(Value::Null), -32600, "Invalid Request"));
  };
  if method == "notifications/initialized" && is_notification {
    return None;
  }
  match dispatch_method(method, message.params).await {
    Ok(result) => {
      if is_notification {
        None
      } else {
        Some(rpc_result(id.unwrap_or(Value::Null), result))
      }
    }
    Err((code, message)) => {
      if is_notification {
        None
      } else {
        Some(rpc_error(id.unwrap_or(Value::Null), code, &message))
      }
    }
  }
}

/// Handle a Streamable HTTP MCP request. JSON-RPC protocol errors stay HTTP 200.
pub async fn handle_http<B>(req: Request<B>) -> Response<Full<Bytes>>
where
  B: Body + Unpin,
  B::Error: std::fmt::Display,
{
  let origin = req.headers().get(ORIGIN).and_then(|value| value.to_str().ok()).map(str::to_owned);
  let origin_ref = origin.as_deref();
  let request_protocol_version = req.headers().get(HEADER_PROTOCOL_VERSION).and_then(|value| value.to_str().ok());
  let protocol_version = negotiate_protocol_version(request_protocol_version);

  if !origin_is_allowed(origin_ref) {
    return response(StatusCode::FORBIDDEN, None, protocol_version, empty_body(), |b| b);
  }

  if let Some(version) = request_protocol_version {
    if !protocol_version_supported(version) {
      return response(StatusCode::BAD_REQUEST, origin_ref, protocol_version, empty_body(), |b| b);
    }
  }

  if !mcp_path(req.uri().path()) {
    return response(StatusCode::NOT_FOUND, origin_ref, protocol_version, empty_body(), |b| b);
  }

  match *req.method() {
    Method::OPTIONS => response(StatusCode::NO_CONTENT, origin_ref, protocol_version, empty_body(), |b| b),
    Method::GET => response(StatusCode::METHOD_NOT_ALLOWED, origin_ref, protocol_version, empty_body(), |b| {
      b.header(ALLOW, "POST, OPTIONS")
    }),
    Method::POST => {
      let body = match read_body(req.into_body()).await {
        Ok(body) => body,
        Err(_) => {
          let payload = rpc_error(Value::Null, -32700, "Parse error");
          return response(StatusCode::OK, origin_ref, protocol_version, json_body(&payload), |b| {
            b.header(CONTENT_TYPE, "application/json")
          });
        }
      };
      let text = match String::from_utf8(body) {
        Ok(text) => text,
        Err(_) => {
          let payload = rpc_error(Value::Null, -32700, "Parse error");
          return response(StatusCode::OK, origin_ref, protocol_version, json_body(&payload), |b| {
            b.header(CONTENT_TYPE, "application/json")
          });
        }
      };
      let message: IncomingMessage = match serde_json::from_str(&text) {
        Ok(message) => message,
        Err(_) => {
          let payload = rpc_error(Value::Null, -32700, "Parse error");
          return response(StatusCode::OK, origin_ref, protocol_version, json_body(&payload), |b| {
            b.header(CONTENT_TYPE, "application/json")
          });
        }
      };
      match handle_rpc(message).await {
        None => response(StatusCode::ACCEPTED, origin_ref, protocol_version, empty_body(), |b| b),
        Some(payload) => response(StatusCode::OK, origin_ref, protocol_version, json_body(&payload), |b| {
          b.header(CONTENT_TYPE, "application/json")
        }),
      }
    }
    _ => response(StatusCode::METHOD_NOT_ALLOWED, origin_ref, protocol_version, empty_body(), |b| {
      b.header(ALLOW, "POST, OPTIONS")
    }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use http_body_util::Full;

  fn post_rpc(body: Value) -> Request<Full<Bytes>> {
    Request::builder()
      .method("POST")
      .uri("http://127.0.0.1/mcp")
      .header(CONTENT_TYPE, "application/json")
      .body(Full::new(Bytes::from(body.to_string())))
      .unwrap()
  }

  fn post_rpc_with_origin(body: Value, origin: &str) -> Request<Full<Bytes>> {
    Request::builder()
      .method("POST")
      .uri("http://127.0.0.1/mcp")
      .header(CONTENT_TYPE, "application/json")
      .header(ORIGIN, origin)
      .body(Full::new(Bytes::from(body.to_string())))
      .unwrap()
  }

  async fn rpc_json(req: Request<Full<Bytes>>) -> (StatusCode, Value) {
    let response = handle_http(req).await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
      Value::Null
    } else {
      serde_json::from_slice(&bytes).unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, value)
  }

  #[test]
  fn allows_missing_and_loopback_origins() {
    assert!(origin_is_allowed(None));
    assert!(origin_is_allowed(Some("http://localhost:6274")));
    assert!(origin_is_allowed(Some("http://127.0.0.1:8791")));
    assert!(origin_is_allowed(Some("http://[::1]:6274")));
    assert!(!origin_is_allowed(Some("https://evil.example")));
    assert!(!origin_is_allowed(Some("null")));
    assert!(!origin_is_allowed(Some("http://192.168.1.1")));
  }

  #[tokio::test]
  async fn get_mcp_is_method_not_allowed() {
    let req = Request::builder().method("GET").uri("http://127.0.0.1/mcp").body(Full::new(Bytes::new())).unwrap();
    let response = handle_http(req).await;
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
  }

  #[tokio::test]
  async fn unknown_path_is_not_found() {
    let req = Request::builder().method("POST").uri("http://127.0.0.1/nope").body(Full::new(Bytes::new())).unwrap();
    let response = handle_http(req).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
  }

  #[tokio::test]
  async fn rejects_non_loopback_origin() {
    let req = post_rpc_with_origin(json!({"jsonrpc":"2.0","id":1,"method":"ping"}), "https://attacker.example");
    let (status, _) = rpc_json(req).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
  }

  #[tokio::test]
  async fn initialize_lists_server_info() {
    let req = post_rpc(json!({
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": PROTOCOL_VERSION_2025_06_18,
        "capabilities": {},
        "clientInfo": { "name": "test", "version": "0" }
      }
    }));
    let (status, body) = rpc_json(req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["result"]["serverInfo"]["name"], SERVER_NAME);
    assert_eq!(body["result"]["protocolVersion"], PROTOCOL_VERSION_2025_06_18);
    assert!(body["result"]["capabilities"]["tools"].is_object());
  }

  #[tokio::test]
  async fn initialized_notification_is_accepted() {
    let req = post_rpc(json!({
      "jsonrpc": "2.0",
      "method": "notifications/initialized"
    }));
    let (status, _) = rpc_json(req).await;
    assert_eq!(status, StatusCode::ACCEPTED);
  }

  #[tokio::test]
  async fn tools_list_includes_web_search_and_fetch_page() {
    let req = post_rpc(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}));
    let (status, body) = rpc_json(req).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> =
      body["result"]["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect();
    assert_eq!(names, ["web_search", "fetch_page"]);
    assert_eq!(body["result"]["tools"][0]["inputSchema"]["properties"]["query"]["type"], "string");
  }

  #[tokio::test]
  async fn unknown_method_is_jsonrpc_error() {
    let req = post_rpc(json!({"jsonrpc":"2.0","id":3,"method":"resources/list"}));
    let (status, body) = rpc_json(req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["error"]["code"], -32601);
  }

  #[tokio::test]
  async fn tools_call_empty_query_is_tool_error() {
    let req = post_rpc(json!({
      "jsonrpc": "2.0",
      "id": 4,
      "method": "tools/call",
      "params": { "name": "web_search", "arguments": {} }
    }));
    let (status, body) = rpc_json(req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.get("error").is_none());
    assert_eq!(body["result"]["isError"], true);
  }

  #[tokio::test]
  async fn invalid_json_is_parse_error() {
    let req = Request::builder()
      .method("POST")
      .uri("http://127.0.0.1/mcp")
      .header(CONTENT_TYPE, "application/json")
      .body(Full::new(Bytes::from("not-json")))
      .unwrap();
    let (status, body) = rpc_json(req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["error"]["code"], -32700);
  }

  #[tokio::test]
  async fn ping_ok() {
    let req = post_rpc(json!({"jsonrpc":"2.0","id":"ping-1","method":"ping"}));
    let (status, body) = rpc_json(req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["result"], json!({}));
  }

  #[tokio::test]
  async fn inspector_origin_gets_cors_headers() {
    let req = post_rpc_with_origin(json!({"jsonrpc":"2.0","id":1,"method":"ping"}), "http://localhost:6274");
    let response = handle_http(req).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
      response.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).and_then(|value| value.to_str().ok()),
      Some("http://localhost:6274")
    );
  }

  #[tokio::test]
  async fn unsupported_protocol_version_header_is_bad_request() {
    let req = Request::builder()
      .method("POST")
      .uri("http://127.0.0.1/mcp")
      .header(CONTENT_TYPE, "application/json")
      .header(HEADER_PROTOCOL_VERSION, "1999-01-01")
      .body(Full::new(Bytes::from(json!({"jsonrpc":"2.0","id":1,"method":"ping"}).to_string())))
      .unwrap();
    let response = handle_http(req).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
  }
}
