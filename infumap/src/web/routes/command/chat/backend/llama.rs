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

//! The configured llama.cpp llama-server instances.

use config::Config;
use infusdk::util::infu::InfuResult;
use serde::Deserialize;

use crate::config::{CONFIG_LLAMA_SERVER, CONFIG_LLAMA_SERVER_URL, CONFIG_LLAMA_SERVERS};

/// Path appended to a llama-server base URL.
const LLAMA_CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";

/// Name given to the server configured by the single `llama_server_url` setting.
pub const LEGACY_LLAMA_SERVER_NAME: &str = "llama-server";

const LLAMA_SERVER_NAME_MAX_LEN: usize = 64;

#[derive(Clone, Debug)]
pub struct LlamaServer {
  /// Identifies the server in chat requests, and is what the user sees.
  pub name: String,
  /// The chat completions endpoint.
  pub url: reqwest::Url,
}

#[derive(Clone, Debug, Deserialize)]
struct LlamaServerFile {
  name: String,
  url: String,
}

/// The configured value is either the server base URL or the full chat completions endpoint URL.
fn chat_completions_url(name: &str, configured_url: &str) -> InfuResult<reqwest::Url> {
  let parse_error =
    |e: &dyn std::fmt::Display| format!("llama server '{}' has an invalid url '{}': {}", name, configured_url, e);
  let parsed = reqwest::Url::parse(configured_url).map_err(|e| parse_error(&e))?;
  match parsed.scheme() {
    "http" | "https" => {}
    other => return Err(format!("llama server '{}' url must be http or https, got '{}'.", name, other).into()),
  }
  if parsed.path().trim_end_matches('/').ends_with(LLAMA_CHAT_COMPLETIONS_PATH) {
    return Ok(parsed);
  }

  let base_url =
    reqwest::Url::parse(&format!("{}/", configured_url.trim_end_matches('/'))).map_err(|e| parse_error(&e))?;
  base_url
    .join(LLAMA_CHAT_COMPLETIONS_PATH.trim_start_matches('/'))
    .map_err(|e| format!("Could not build chat completions endpoint from '{}': {}", configured_url, e).into())
}

fn parse_server(entry: LlamaServerFile) -> InfuResult<LlamaServer> {
  let name = entry.name.trim().to_owned();
  if name.is_empty() || name.chars().count() > LLAMA_SERVER_NAME_MAX_LEN || name.chars().any(char::is_control) {
    return Err(
      format!(
        "llama server name '{}' is invalid; expected 1 to {} printable characters.",
        entry.name, LLAMA_SERVER_NAME_MAX_LEN
      )
      .into(),
    );
  }
  let url = chat_completions_url(&name, entry.url.trim())?;
  Ok(LlamaServer { name, url })
}

fn legacy_entry_from_config(config: &Config) -> Option<LlamaServerFile> {
  match config.get_string(CONFIG_LLAMA_SERVER_URL) {
    Ok(url) if !url.trim().is_empty() => Some(LlamaServerFile { name: LEGACY_LLAMA_SERVER_NAME.to_owned(), url }),
    _ => None,
  }
}

fn file_entries_from_config(config: &Config) -> InfuResult<Vec<LlamaServerFile>> {
  match config.get::<Vec<LlamaServerFile>>(CONFIG_LLAMA_SERVER) {
    Ok(entries) => Ok(entries),
    Err(_) => match config.get_array(CONFIG_LLAMA_SERVER) {
      Ok(values) => {
        let mut entries = Vec::new();
        for value in values {
          entries.push(value.try_deserialize().map_err(|e| format!("Could not parse [[{CONFIG_LLAMA_SERVER}]]: {e}"))?);
        }
        Ok(entries)
      }
      Err(_) => Ok(Vec::new()),
    },
  }
}

fn json_entries_from_config(config: &Config) -> InfuResult<Vec<LlamaServerFile>> {
  let Ok(raw) = config.get_string(CONFIG_LLAMA_SERVERS) else {
    return Ok(Vec::new());
  };
  let raw = raw.trim();
  if raw.is_empty() {
    return Ok(Vec::new());
  }
  serde_json::from_str(raw).map_err(|e| format!("Could not parse {CONFIG_LLAMA_SERVERS} JSON: {e}").into())
}

/// Configured llama servers, in order: `llama_server_url` (named "llama-server"), then TOML
/// `[[llama_server]]`, then optional JSON in `llama_servers` (`INFUMAP_LLAMA_SERVERS`). A later entry
/// replaces an earlier one with the same name.
pub fn llama_servers_from_config(config: &Config) -> InfuResult<Vec<LlamaServer>> {
  let entries = legacy_entry_from_config(config)
    .into_iter()
    .chain(file_entries_from_config(config)?)
    .chain(json_entries_from_config(config)?);
  let mut servers: Vec<LlamaServer> = Vec::new();
  for entry in entries {
    let server = parse_server(entry)?;
    match servers.iter_mut().find(|existing| existing.name == server.name) {
      Some(existing) => *existing = server,
      None => servers.push(server),
    }
  }
  Ok(servers)
}

#[cfg(test)]
mod tests {
  use super::*;
  use config::{File, FileFormat};

  fn from_toml(toml: &str) -> InfuResult<Vec<LlamaServer>> {
    let config = Config::builder().add_source(File::from_str(toml, FileFormat::Toml)).build().unwrap();
    llama_servers_from_config(&config)
  }

  #[test]
  fn parses_named_servers_in_order() {
    let servers = from_toml(
      r#"
[[llama_server]]
name = "Qwen on the GPU box"
url = "http://10.0.0.5:8080"

[[llama_server]]
name = "local"
url = "http://127.0.0.1:8080/v1/chat/completions"
"#,
    )
    .unwrap();
    assert_eq!(servers.len(), 2);
    assert_eq!(servers[0].name, "Qwen on the GPU box");
    assert_eq!(servers[0].url.as_str(), "http://10.0.0.5:8080/v1/chat/completions");
    assert_eq!(servers[1].name, "local");
    assert_eq!(servers[1].url.as_str(), "http://127.0.0.1:8080/v1/chat/completions");
  }

  #[test]
  fn legacy_url_comes_first() {
    let servers = from_toml(
      r#"
llama_server_url = "http://127.0.0.1:8080/"

[[llama_server]]
name = "other"
url = "http://127.0.0.1:8081"
"#,
    )
    .unwrap();
    assert_eq!(servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec![LEGACY_LLAMA_SERVER_NAME, "other"]);
    assert_eq!(servers[0].url.as_str(), "http://127.0.0.1:8080/v1/chat/completions");
  }

  #[test]
  fn json_overrides_toml_by_name() {
    let config = Config::builder()
      .add_source(File::from_str(
        r#"
[[llama_server]]
name = "local"
url = "http://127.0.0.1:8080"
"#,
        FileFormat::Toml,
      ))
      .set_override(CONFIG_LLAMA_SERVERS, r#"[{"name":"local","url":"http://127.0.0.1:9090"}]"#)
      .unwrap()
      .build()
      .unwrap();
    let servers = llama_servers_from_config(&config).unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].url.as_str(), "http://127.0.0.1:9090/v1/chat/completions");
  }

  #[test]
  fn rejects_bad_entries() {
    assert!(from_toml("[[llama_server]]\nname = \" \"\nurl = \"http://127.0.0.1:8080\"\n").is_err());
    assert!(from_toml("[[llama_server]]\nname = \"a\"\nurl = \"not a url\"\n").is_err());
    assert!(from_toml("[[llama_server]]\nname = \"a\"\nurl = \"ftp://127.0.0.1\"\n").is_err());
  }
}
