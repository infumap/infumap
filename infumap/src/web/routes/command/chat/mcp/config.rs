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

use config::Config;
use infusdk::util::infu::InfuResult;
use serde::Deserialize;
use std::time::Duration;

use crate::config::{CONFIG_CHAT_TOOL_SERVER, CONFIG_CHAT_TOOL_SERVERS};

const SERVER_ID_MAX_LEN: usize = 32;
/// How long a tool call may take before the client gives up. Most MCP tools
/// answer in under a second, and a server that has stopped answering should not
/// hang a chat, so the default is short.
const DEFAULT_TIMEOUT_SECS: u64 = 60;
/// A server doing real work behind one call - converting a document, running a
/// model over it - legitimately takes minutes, which is what `timeout_secs`
/// raises. The ceiling is there so a typo cannot hang a chat for a day.
const MAX_TIMEOUT_SECS: u64 = 60 * 60;
const RESERVED_CAPABILITY_IDS: &[&str] = &["infumap_data"];

#[derive(Clone, Debug)]
pub struct ChatToolServer {
  pub id: String,
  pub url: reqwest::Url,
  pub label: String,
  pub bearer_token: Option<String>,
  pub enabled_by_default: bool,
  pub require_approval: bool,
  /// How long to wait for one call to this server to complete.
  pub timeout: Duration,
}

#[derive(Clone, Debug, Deserialize)]
struct ChatToolServerFile {
  id: String,
  url: String,
  #[serde(default)]
  label: Option<String>,
  #[serde(default)]
  bearer_token: Option<String>,
  #[serde(default)]
  enabled_by_default: Option<bool>,
  #[serde(default)]
  require_approval: Option<bool>,
  #[serde(default)]
  timeout_secs: Option<u64>,
}

fn default_require_approval() -> bool {
  true
}

fn is_valid_server_id(id: &str) -> bool {
  let len = id.len();
  (1..=SERVER_ID_MAX_LEN).contains(&len) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn parse_server(entry: ChatToolServerFile) -> InfuResult<ChatToolServer> {
  let id = entry.id.trim().to_owned();
  if !is_valid_server_id(&id) {
    return Err(
      format!("chat_tool_server id '{}' is invalid; expected [A-Za-z0-9_]{{1,{}}}.", entry.id, SERVER_ID_MAX_LEN)
        .into(),
    );
  }
  if RESERVED_CAPABILITY_IDS.contains(&id.as_str()) {
    return Err(format!("chat_tool_server id '{id}' is reserved.").into());
  }
  let url = reqwest::Url::parse(entry.url.trim())
    .map_err(|e| format!("chat_tool_server '{id}' has an invalid url '{}': {e}", entry.url))?;
  match url.scheme() {
    "http" | "https" => {}
    other => return Err(format!("chat_tool_server '{id}' url must be http or https, got '{other}'.").into()),
  }
  if url.host_str().is_none() {
    return Err(format!("chat_tool_server '{id}' url has no host.").into());
  }
  let label =
    entry.label.map(|label| label.trim().to_owned()).filter(|label| !label.is_empty()).unwrap_or_else(|| id.clone());
  let bearer_token = entry.bearer_token.map(|token| token.trim().to_owned()).filter(|token| !token.is_empty());
  let timeout_secs = entry.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
  if timeout_secs == 0 || timeout_secs > MAX_TIMEOUT_SECS {
    return Err(
      format!("chat_tool_server '{id}' timeout_secs must be between 1 and {MAX_TIMEOUT_SECS}, got {timeout_secs}.")
        .into(),
    );
  }
  Ok(ChatToolServer {
    id,
    url,
    label,
    bearer_token,
    enabled_by_default: entry.enabled_by_default.unwrap_or(false),
    require_approval: entry.require_approval.unwrap_or_else(default_require_approval),
    timeout: Duration::from_secs(timeout_secs),
  })
}

fn file_entries_from_config(config: &Config) -> InfuResult<Vec<ChatToolServerFile>> {
  match config.get::<Vec<ChatToolServerFile>>(CONFIG_CHAT_TOOL_SERVER) {
    Ok(entries) => Ok(entries),
    Err(_) => match config.get_array(CONFIG_CHAT_TOOL_SERVER) {
      Ok(values) => {
        let mut entries = Vec::new();
        for value in values {
          entries
            .push(value.try_deserialize().map_err(|e| format!("Could not parse [[{CONFIG_CHAT_TOOL_SERVER}]]: {e}"))?);
        }
        Ok(entries)
      }
      Err(_) => Ok(Vec::new()),
    },
  }
}

fn json_entries_from_config(config: &Config) -> InfuResult<Vec<ChatToolServerFile>> {
  let Ok(raw) = config.get_string(CONFIG_CHAT_TOOL_SERVERS) else {
    return Ok(Vec::new());
  };
  let raw = raw.trim();
  if raw.is_empty() {
    return Ok(Vec::new());
  }
  serde_json::from_str(raw).map_err(|e| format!("Could not parse {CONFIG_CHAT_TOOL_SERVERS} JSON: {e}").into())
}

/// Configured MCP tool servers. TOML `[[chat_tool_server]]` plus optional JSON in `chat_tool_servers`
/// (`INFUMAP_CHAT_TOOL_SERVERS`). JSON entries override TOML entries with the same id.
pub fn chat_tool_servers_from_config(config: &Config) -> InfuResult<Vec<ChatToolServer>> {
  let mut ordered_ids = Vec::new();
  let mut by_id = std::collections::HashMap::new();
  for entry in file_entries_from_config(config)? {
    let server = parse_server(entry)?;
    if !by_id.contains_key(&server.id) {
      ordered_ids.push(server.id.clone());
    }
    by_id.insert(server.id.clone(), server);
  }
  for entry in json_entries_from_config(config)? {
    let server = parse_server(entry)?;
    if !by_id.contains_key(&server.id) {
      ordered_ids.push(server.id.clone());
    }
    by_id.insert(server.id.clone(), server);
  }
  Ok(ordered_ids.into_iter().filter_map(|id| by_id.remove(&id)).collect())
}

#[cfg(test)]
mod tests {
  use super::*;
  use config::{File, FileFormat};

  fn from_toml(toml: &str) -> Vec<ChatToolServer> {
    let config = Config::builder().add_source(File::from_str(toml, FileFormat::Toml)).build().unwrap();
    chat_tool_servers_from_config(&config).unwrap()
  }

  #[test]
  fn parses_toml_array_of_tables() {
    let servers = from_toml(
      r#"
[[chat_tool_server]]
id = "web_search"
url = "http://127.0.0.1:8791/mcp"
label = "Web search"
"#,
    );
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].id, "web_search");
    assert_eq!(servers[0].label, "Web search");
    assert!(!servers[0].enabled_by_default);
    assert!(servers[0].require_approval);
    assert!(servers[0].bearer_token.is_none());
    assert_eq!(servers[0].timeout, Duration::from_secs(DEFAULT_TIMEOUT_SECS));
  }

  #[test]
  fn timeout_secs_is_per_server() {
    // A server that reads documents behind one call takes minutes, where the
    // default would cut it off and report it as a transport failure.
    let servers = from_toml(
      r#"
[[chat_tool_server]]
id = "reader"
url = "http://127.0.0.1:8792/mcp"
timeout_secs = 300

[[chat_tool_server]]
id = "quick"
url = "http://127.0.0.1:8793/mcp"
"#,
    );
    assert_eq!(servers[0].timeout, Duration::from_secs(300));
    // Raising one server's timeout leaves the others where they were.
    assert_eq!(servers[1].timeout, Duration::from_secs(DEFAULT_TIMEOUT_SECS));
  }

  #[test]
  fn an_unusable_timeout_is_refused_rather_than_clamped() {
    for secs in [0, MAX_TIMEOUT_SECS + 1] {
      let config = Config::builder()
        .add_source(File::from_str(
          &format!(
            r#"
[[chat_tool_server]]
id = "reader"
url = "http://127.0.0.1:8792/mcp"
timeout_secs = {secs}
"#
          ),
          FileFormat::Toml,
        ))
        .build()
        .unwrap();
      let error = chat_tool_servers_from_config(&config).unwrap_err().to_string();
      assert!(error.contains("timeout_secs"), "{error}");
    }
  }

  #[test]
  fn json_overrides_toml_by_id() {
    let config = Config::builder()
      .add_source(File::from_str(
        r#"
[[chat_tool_server]]
id = "web_search"
url = "http://127.0.0.1:8791/mcp"
label = "From TOML"
"#,
        FileFormat::Toml,
      ))
      .set_override(
        CONFIG_CHAT_TOOL_SERVERS,
        r#"[{"id":"web_search","url":"http://127.0.0.1:8792/mcp","label":"From JSON","require_approval":false}]"#,
      )
      .unwrap()
      .build()
      .unwrap();
    let servers = chat_tool_servers_from_config(&config).unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].label, "From JSON");
    assert!(!servers[0].require_approval);
    assert_eq!(servers[0].url.as_str(), "http://127.0.0.1:8792/mcp");
  }

  #[test]
  fn rejects_reserved_ids() {
    let config = Config::builder()
      .add_source(File::from_str(
        r#"
[[chat_tool_server]]
id = "infumap_data"
url = "http://127.0.0.1:8791/mcp"
"#,
        FileFormat::Toml,
      ))
      .build()
      .unwrap();
    assert!(chat_tool_servers_from_config(&config).is_err());
  }

  #[test]
  fn accepts_web_search_id() {
    let servers = from_toml(
      r#"
[[chat_tool_server]]
id = "web_search"
url = "http://127.0.0.1:8791/mcp"
"#,
    );
    assert_eq!(servers[0].id, "web_search");
    assert_eq!(servers[0].label, "web_search");
  }

  #[test]
  fn rejects_invalid_ids() {
    let config = Config::builder()
      .add_source(File::from_str(
        r#"
[[chat_tool_server]]
id = "has-hyphen"
url = "http://127.0.0.1:8791/mcp"
"#,
        FileFormat::Toml,
      ))
      .build()
      .unwrap();
    assert!(chat_tool_servers_from_config(&config).is_err());
  }
}
