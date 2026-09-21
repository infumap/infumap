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

mod client;
mod config;
mod names;

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ::config::Config;
use futures_util::future::join_all;
use infusdk::util::infu::InfuResult;
use log::warn;
use serde::Serialize;
use serde_json::Value;

pub use config::{ChatToolServer, chat_tool_servers_from_config};
use names::openai_tool_name;

const CATALOG_TTL_OK: Duration = Duration::from_secs(60);
const CATALOG_TTL_ERR: Duration = Duration::from_secs(15);

#[derive(Clone, Serialize)]
pub struct ChatToolServerInfo {
  pub id: String,
  pub label: String,
  #[serde(skip_serializing_if = "Vec::is_empty")]
  pub icons: Vec<client::McpIcon>,
  pub available: bool,
  #[serde(rename = "unavailableReason", skip_serializing_if = "Option::is_none")]
  pub unavailable_reason: Option<String>,
  #[serde(rename = "enabledByDefault")]
  pub enabled_by_default: bool,
  pub tools: Vec<client::McpTool>,
}

pub struct MappedMcpTool {
  pub openai_name: String,
  pub description: String,
  pub parameters: Value,
  pub read_only: bool,
}

pub struct MappedMcpToolTarget {
  pub server_id: String,
  pub mcp_name: String,
  pub read_only: bool,
}

#[derive(Clone)]
struct CachedServer {
  fetched_at: Instant,
  ttl: Duration,
  available: bool,
  unavailable_reason: Option<String>,
  session: Option<client::McpSession>,
}

fn cache() -> &'static Mutex<HashMap<String, CachedServer>> {
  static CACHE: OnceLock<Mutex<HashMap<String, CachedServer>>> = OnceLock::new();
  CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_cache() -> std::sync::MutexGuard<'static, HashMap<String, CachedServer>> {
  cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cached_fresh(id: &str) -> Option<CachedServer> {
  let cache = lock_cache();
  let entry = cache.get(id)?;
  if entry.fetched_at.elapsed() >= entry.ttl {
    return None;
  }
  Some(entry.clone())
}

fn store_cache(id: String, entry: CachedServer) {
  lock_cache().insert(id, entry);
}

async fn refresh_server(server: &ChatToolServer) -> CachedServer {
  match client::initialize_and_list_tools(server).await {
    Ok(session) => CachedServer {
      fetched_at: Instant::now(),
      ttl: CATALOG_TTL_OK,
      available: true,
      unavailable_reason: None,
      session: Some(session),
    },
    Err(e) => {
      warn!("MCP tool server '{}': {}", server.id, e);
      CachedServer {
        fetched_at: Instant::now(),
        ttl: CATALOG_TTL_ERR,
        available: false,
        unavailable_reason: Some("Could not reach the tool server".to_owned()),
        session: None,
      }
    }
  }
}

async fn server_snapshot(server: &ChatToolServer) -> CachedServer {
  if let Some(cached) = cached_fresh(&server.id) {
    return cached;
  }
  let snapshot = refresh_server(server).await;
  store_cache(server.id.clone(), snapshot.clone());
  snapshot
}

fn servers_by_id(config: &Config) -> InfuResult<HashMap<String, ChatToolServer>> {
  Ok(chat_tool_servers_from_config(config)?.into_iter().map(|server| (server.id.clone(), server)).collect())
}

/// Discovery payload for `/chat/models`. A down server is listed as unavailable rather than omitted.
pub async fn tool_server_catalog(config: &Config) -> Vec<ChatToolServerInfo> {
  let servers = match chat_tool_servers_from_config(config) {
    Ok(servers) => servers,
    Err(e) => {
      warn!("Could not load chat tool server config: {e}");
      return Vec::new();
    }
  };
  join_all(servers.into_iter().map(|server| async move {
    let snapshot = server_snapshot(&server).await;
    let (icons, tools) =
      snapshot.session.as_ref().map(|session| (session.icons.clone(), session.tools.clone())).unwrap_or_default();
    ChatToolServerInfo {
      id: server.id,
      label: server.label,
      icons,
      available: snapshot.available,
      unavailable_reason: snapshot.unavailable_reason,
      enabled_by_default: server.enabled_by_default,
      tools,
    }
  }))
  .await
}

fn default_input_schema() -> Value {
  serde_json::json!({
    "type": "object",
    "properties": {},
    "additionalProperties": true
  })
}

/// Tool specs for the plugin ids enabled on this chat, plus execution metadata keyed by OpenAI name.
pub async fn mapped_tools_for_capabilities(
  config: &Config,
  plugin_ids: &[String],
  reserved_openai_names: &[&str],
) -> (Vec<MappedMcpTool>, HashMap<String, MappedMcpToolTarget>) {
  let Ok(by_id) = servers_by_id(config) else {
    return (Vec::new(), HashMap::new());
  };
  let mut used: HashSet<String> = reserved_openai_names.iter().map(|name| (*name).to_owned()).collect();
  let mut mapped = Vec::new();
  let mut name_map = HashMap::new();
  for plugin_id in plugin_ids {
    let Some(server) = by_id.get(plugin_id) else {
      continue;
    };
    let snapshot = server_snapshot(server).await;
    if !snapshot.available {
      continue;
    }
    let Some(session) = snapshot.session else {
      continue;
    };
    for tool in session.tools {
      let mcp_name = tool.name.trim();
      if mcp_name.is_empty() {
        continue;
      }
      let openai_name = openai_tool_name(&server.id, mcp_name, &mut used);
      let description = tool
        .description
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| tool.title.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()))
        .unwrap_or_else(|| mcp_name.to_owned());
      let parameters = if tool.input_schema.is_object() { tool.input_schema } else { default_input_schema() };
      let read_only = tool.annotations.as_ref().is_some_and(|annotations| annotations.read_only_hint);
      name_map.insert(
        openai_name.clone(),
        MappedMcpToolTarget { server_id: server.id.clone(), mcp_name: mcp_name.to_owned(), read_only },
      );
      mapped.push(MappedMcpTool { openai_name, description, parameters, read_only });
    }
  }
  (mapped, name_map)
}

pub fn reserved_openai_names(uses_infumap_data: bool) -> Vec<&'static str> {
  if uses_infumap_data { vec!["lexical_search", "read_container", "get_fragment"] } else { Vec::new() }
}

pub fn server_requires_approval(config: &Config, server_id: &str) -> bool {
  match servers_by_id(config) {
    Ok(by_id) => by_id.get(server_id).map(|server| server.require_approval).unwrap_or(true),
    Err(_) => true,
  }
}

pub async fn call_mapped_tool(
  config: &Config,
  server_id: &str,
  mcp_name: &str,
  arguments: Value,
) -> InfuResult<String> {
  let by_id = servers_by_id(config)?;
  let Some(server) = by_id.get(server_id) else {
    return Ok(serde_json::json!({ "error": format!("Unknown tool server '{server_id}'.") }).to_string());
  };
  let snapshot = server_snapshot(server).await;
  let Some(session) = snapshot.session else {
    return Ok(
      serde_json::json!({
        "error": snapshot.unavailable_reason.unwrap_or_else(|| "Tool server is unavailable.".to_owned())
      })
      .to_string(),
    );
  };
  match client::call_tool(server, &session, mcp_name, arguments).await {
    Ok(text) => Ok(if text.is_empty() { "{}".to_owned() } else { text }),
    Err(e) => Ok(serde_json::json!({ "error": e.to_string() }).to_string()),
  }
}
