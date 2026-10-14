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

//! Resolution of the upstream service a chat request is sent to.
//!
//! Both supported backends speak the OpenAI chat completions wire format, so they differ only in
//! the values collected here - endpoint URL, credentials, model name and timeouts.

use config::Config;
use infusdk::util::infu::InfuResult;
use log::warn;
use serde::Serialize;
use std::time::Duration;

mod llama;
mod openrouter;
use llama::LlamaServer;
pub use llama::llama_servers_from_config;
pub use openrouter::ChatModelInfo;

use super::mcp::{self, ChatToolServerInfo};
use crate::config::{
  CHAT_BACKEND_LLAMA, CHAT_BACKEND_LLAMA_PREFIX, CHAT_BACKEND_OPENROUTER, CONFIG_CHAT_DEFAULT_BACKEND,
  CONFIG_CHAT_DEFAULT_OPENROUTER_MODEL, CONFIG_OPENROUTER_API_KEY,
};

/// The OpenRouter API. Trailing slash so that paths resolve relative to the version segment.
const OPENROUTER_API_BASE: &str = "https://openrouter.ai/api/v1/";

const LLAMA_CONNECT_TIMEOUT_SECS: u64 = 30;
const LLAMA_READ_TIMEOUT_SECS: u64 = 120;

/// llama-server ignores the model name, but the field is required by the wire format.
const LLAMA_MODEL_NAME: &str = "default";

/// Reasoning effort levels OpenRouter accepts. Which of them a given model actually supports is
/// reported per model in the catalog, and the client offers only those.
const REASONING_EFFORT_NONE: &str = "none";
const REASONING_EFFORTS: &[&str] = &[REASONING_EFFORT_NONE, "minimal", "low", "medium", "high", "xhigh", "max"];

/// Identifies Infumap to OpenRouter. Deliberately not accompanied by an HTTP-Referer, which would
/// disclose the instance's address.
pub const OPENROUTER_APP_TITLE: &str = "Infumap";

const OPENROUTER_CONNECT_TIMEOUT_SECS: u64 = 30;
/// Reasoning models can pause for a long time between tokens. OpenRouter sends SSE keepalive
/// comments while a request is queued, so this only has to cover gaps in a live stream.
const OPENROUTER_READ_TIMEOUT_SECS: u64 = 300;

/// Which kind of upstream service a chat request is sent to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatBackend {
  LlamaServer,
  OpenRouter,
}

const OPENROUTER_LABEL: &str = "OpenRouter";

/// A backend as named by a chat request or by chat_default_backend.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendId<'a> {
  /// Plain "llama": whichever llama server is configured first.
  FirstLlama,
  Llama(&'a str),
  OpenRouter,
}

impl<'a> BackendId<'a> {
  fn parse(id: &'a str) -> Option<Self> {
    match id.trim() {
      CHAT_BACKEND_LLAMA => Some(Self::FirstLlama),
      CHAT_BACKEND_OPENROUTER => Some(Self::OpenRouter),
      id => id.strip_prefix(CHAT_BACKEND_LLAMA_PREFIX).map(|name| Self::Llama(name.trim())),
    }
  }
}

fn llama_backend_id(server: &LlamaServer) -> String {
  format!("{}{}", CHAT_BACKEND_LLAMA_PREFIX, server.name)
}

/// The concrete upstream a chat request resolves to.
enum ChatTarget {
  Llama(LlamaServer),
  OpenRouter,
}

impl ChatTarget {
  fn id(&self) -> String {
    match self {
      Self::Llama(server) => llama_backend_id(server),
      Self::OpenRouter => CHAT_BACKEND_OPENROUTER.to_owned(),
    }
  }
}

/// How much the model should reason before answering.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatReasoning {
  /// Send nothing, and let the model do whatever it does by default.
  ModelDefault,
  Disabled,
  Effort(&'static str),
}

pub use crate::query_configuration::ChatModelSelection;

impl ChatModelSelection {
  fn requested_backend_id(&self) -> &str {
    self.backend.trim()
  }

  fn requested_model(&self) -> Option<&str> {
    self.model.as_deref().map(str::trim).filter(|model| !model.is_empty())
  }

  fn requested_reasoning(&self) -> InfuResult<ChatReasoning> {
    let Some(effort) = self.reasoning_effort.as_deref().map(str::trim).filter(|effort| !effort.is_empty()) else {
      return Ok(ChatReasoning::ModelDefault);
    };
    let effort =
      REASONING_EFFORTS.iter().copied().find(|known| known.eq_ignore_ascii_case(effort)).ok_or_else(|| {
        format!("Reasoning effort '{}' is not recognized. Choose Default or a supported effort.", effort)
      })?;
    Ok(if effort == REASONING_EFFORT_NONE { ChatReasoning::Disabled } else { ChatReasoning::Effort(effort) })
  }
}

/// Everything needed to issue one chat completion request.
pub struct ChatEndpoint {
  pub backend: ChatBackend,
  /// Name for this backend in messages logged or shown to the user.
  pub label: String,
  pub url: reqwest::Url,
  pub api_key: Option<String>,
  pub model: String,
  pub reasoning: ChatReasoning,
  pub connect_timeout: Duration,
  pub read_timeout: Duration,
}

fn configured_string(config: &Config, key: &str) -> Option<String> {
  match config.get_string(key) {
    Ok(value) if !value.trim().is_empty() => Some(value.trim().to_owned()),
    _ => None,
  }
}

/// An OpenRouter endpoint, resolved relative to its API base.
fn openrouter_api_url(path: &str) -> InfuResult<reqwest::Url> {
  reqwest::Url::parse(OPENROUTER_API_BASE)
    .and_then(|base| base.join(path))
    .map_err(|e| format!("Could not build the OpenRouter '{}' endpoint: {}", path, e).into())
}

fn llama_endpoint(server: LlamaServer) -> ChatEndpoint {
  ChatEndpoint {
    backend: ChatBackend::LlamaServer,
    label: format!("llama-server '{}'", server.name),
    url: server.url,
    api_key: None,
    model: LLAMA_MODEL_NAME.to_owned(),
    // llama.cpp only honours a reasoning effort if the loaded model's chat template happens to use
    // it, so Infumap does not offer the choice and never sends one.
    reasoning: ChatReasoning::ModelDefault,
    connect_timeout: Duration::from_secs(LLAMA_CONNECT_TIMEOUT_SECS),
    read_timeout: Duration::from_secs(LLAMA_READ_TIMEOUT_SECS),
  }
}

fn openrouter_endpoint(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatEndpoint> {
  let api_key = configured_string(config, CONFIG_OPENROUTER_API_KEY)
    .ok_or("OpenRouter is not configured on this server. Choose another provider.")?;
  let model = selection
    .requested_model()
    .map(str::to_owned)
    .ok_or("Selected model is missing. Choose an explicit OpenRouter model.")?;
  Ok(ChatEndpoint {
    backend: ChatBackend::OpenRouter,
    label: OPENROUTER_LABEL.to_owned(),
    url: openrouter_api_url("chat/completions")?,
    api_key: Some(api_key),
    model,
    reasoning: selection.requested_reasoning()?,
    connect_timeout: Duration::from_secs(OPENROUTER_CONNECT_TIMEOUT_SECS),
    read_timeout: Duration::from_secs(OPENROUTER_READ_TIMEOUT_SECS),
  })
}

fn openrouter_is_configured(config: &Config) -> bool {
  configured_string(config, CONFIG_OPENROUTER_API_KEY).is_some()
}

fn find_llama<'a>(llama_servers: &'a [LlamaServer], name: &str) -> Option<&'a LlamaServer> {
  llama_servers.iter().find(|server| server.name == name)
}

/// The backend to use when the client did not ask for one: the configured default, falling back
/// to another configured backend when the default is not configured. None when nothing is.
fn default_target(config: &Config, llama_servers: &[LlamaServer]) -> Option<ChatTarget> {
  let configured_default = configured_string(config, CONFIG_CHAT_DEFAULT_BACKEND);
  let configured_default = configured_default.as_deref().and_then(BackendId::parse).unwrap_or(BackendId::FirstLlama);
  let first_llama = || llama_servers.first().cloned().map(ChatTarget::Llama);
  let openrouter = || openrouter_is_configured(config).then_some(ChatTarget::OpenRouter);
  match configured_default {
    BackendId::OpenRouter => openrouter().or_else(first_llama),
    BackendId::FirstLlama => first_llama().or_else(openrouter),
    BackendId::Llama(name) => {
      find_llama(llama_servers, name).cloned().map(ChatTarget::Llama).or_else(first_llama).or_else(openrouter)
    }
  }
}

/// A backend the client named explicitly is never silently swapped for another - that is an error
/// the user should see.
fn requested_target(llama_servers: &[LlamaServer], id: &str) -> InfuResult<ChatTarget> {
  let unknown = || format!("Provider '{}' is not configured on this server. Choose another provider.", id);
  match BackendId::parse(id).ok_or_else(unknown)? {
    BackendId::OpenRouter => Ok(ChatTarget::OpenRouter),
    BackendId::FirstLlama => Err(unknown().into()),
    BackendId::Llama(name) => {
      find_llama(llama_servers, name).cloned().map(ChatTarget::Llama).ok_or_else(|| unknown().into())
    }
  }
}

/// Resolve the endpoint for one chat request. Errors about the selection are worded for the user.
pub fn resolve_chat_endpoint(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatEndpoint> {
  let llama_servers = llama_servers_from_config(config)?;
  let target = requested_target(&llama_servers, selection.requested_backend_id())?;
  match target {
    ChatTarget::Llama(server) => {
      if selection.model.is_some() {
        return Err("Selected model is unsupported by this provider. Choose Server-selected.".into());
      }
      if selection.reasoning_effort.is_some() {
        return Err("Selected reasoning effort is unsupported by this provider. Choose Default.".into());
      }
      Ok(llama_endpoint(server))
    }
    ChatTarget::OpenRouter => openrouter_endpoint(config, selection),
  }
}

/// Resolve the endpoint and check the model and effort against a fresh catalog. A failed or stale
/// catalog leaves the explicit request intact. Errors about the selection are worded for the user.
pub async fn resolve_validated_chat_endpoint(
  config: &Config,
  selection: &ChatModelSelection,
) -> InfuResult<ChatEndpoint> {
  let endpoint = resolve_chat_endpoint(config, selection)?;
  if endpoint.backend != ChatBackend::OpenRouter {
    return Ok(endpoint);
  }
  let Ok(models) = openrouter::model_catalog().await else {
    return Ok(endpoint);
  };
  if !openrouter::model_catalog_is_fresh() {
    return Ok(endpoint);
  }
  let model = models.iter().find(|model| model.id == endpoint.model).ok_or_else(|| {
    format!("Selected model '{}' is not in the OpenRouter catalog. Choose another model.", endpoint.model)
  })?;
  if let Some(effort) = selection.reasoning_effort.as_deref()
    && !model.reasoning_efforts.iter().any(|supported| supported.eq_ignore_ascii_case(effort))
  {
    return Err(
      format!(
        "Selected reasoning effort '{effort}' is not supported by '{}'. Choose Default or a supported effort.",
        model.name
      )
      .into(),
    );
  }
  Ok(endpoint)
}

/// Checked at startup, so that a bad llama server entry or a default naming a server that does not
/// exist is reported then rather than on the first chat.
pub fn validate_chat_backend_config(config: &Config) -> InfuResult<()> {
  let llama_servers = llama_servers_from_config(config)?;
  let Some(configured_default) = configured_string(config, CONFIG_CHAT_DEFAULT_BACKEND) else {
    return Ok(());
  };
  match BackendId::parse(&configured_default) {
    Some(BackendId::Llama(name)) if find_llama(&llama_servers, name).is_none() => Err(
      format!("{} '{}' names a llama server that is not configured.", CONFIG_CHAT_DEFAULT_BACKEND, configured_default)
        .into(),
    ),
    Some(_) => Ok(()),
    None => Err(
      format!(
        "{} '{}' is not one of: {}, {}, {}<name>.",
        CONFIG_CHAT_DEFAULT_BACKEND,
        configured_default,
        CHAT_BACKEND_LLAMA,
        CHAT_BACKEND_OPENROUTER,
        CHAT_BACKEND_LLAMA_PREFIX
      )
      .into(),
    ),
  }
}

/// What one backend offers, as reported to the web client.
#[derive(Serialize)]
struct ChatBackendInfo {
  id: String,
  label: String,
  /// False when the instance has not configured this backend. The client offers it as disabled.
  available: bool,
  /// Why it cannot be used, when it cannot. Deliberately says nothing about which setting is
  /// missing: only whoever administers the instance can act on that.
  #[serde(rename = "unavailableReason", skip_serializing_if = "Option::is_none")]
  unavailable_reason: Option<&'static str>,
  #[serde(rename = "supportsModelSelection")]
  supports_model_selection: bool,
  #[serde(rename = "supportsReasoningEffort")]
  supports_reasoning_effort: bool,
  models: Vec<ChatModelInfo>,
  /// Why the model list is empty, when it should not have been.
  #[serde(rename = "modelsError", skip_serializing_if = "Option::is_none")]
  models_error: Option<String>,
}

#[derive(Serialize)]
pub struct ChatBackendsResponse {
  backends: Vec<ChatBackendInfo>,
  #[serde(rename = "infumapTools")]
  infumap_tools: Vec<super::OpenAiToolSpec>,
  #[serde(rename = "toolServers")]
  tool_servers: Vec<ChatToolServerInfo>,
}

/// The backends this instance can use, and the models each offers.
pub async fn chat_backends(config: &Config) -> ChatBackendsResponse {
  let openrouter_available = openrouter_is_configured(config);
  let (openrouter_models, models_error) = if openrouter_available {
    match openrouter::model_catalog().await {
      Ok(models) => (
        (*models).clone(),
        if openrouter::model_catalog_is_fresh() {
          None
        } else {
          Some("Could not refresh the model list; showing a saved catalog.".to_owned())
        },
      ),
      Err(e) => {
        warn!("Could not load the OpenRouter model list: {}", e);
        (Vec::new(), Some("Could not load the OpenRouter model list.".to_owned()))
      }
    }
  } else {
    (Vec::new(), None)
  };

  let llama_servers = llama_servers_from_config(config).unwrap_or_else(|e| {
    warn!("Could not read the configured llama servers: {}", e);
    Vec::new()
  });
  let unavailable_reason = |available: bool| if available { None } else { Some("Not configured on this server") };
  // llama-server serves whatever model it was started with, and llama.cpp only honours a reasoning
  // effort if the model's chat template happens to use it.
  let llama_backend = |id: String, label: String, available: bool| ChatBackendInfo {
    id,
    label,
    available,
    unavailable_reason: unavailable_reason(available),
    supports_model_selection: false,
    supports_reasoning_effort: false,
    models: Vec::new(),
    models_error: None,
  };
  let mut backends: Vec<ChatBackendInfo> = if llama_servers.is_empty() {
    // Listed anyway, disabled, so that its absence is never a mystery.
    vec![llama_backend(CHAT_BACKEND_LLAMA.to_owned(), llama::LEGACY_LLAMA_SERVER_NAME.to_owned(), false)]
  } else {
    llama_servers.iter().map(|server| llama_backend(llama_backend_id(server), server.name.clone(), true)).collect()
  };
  backends.push(ChatBackendInfo {
    id: CHAT_BACKEND_OPENROUTER.to_owned(),
    label: OPENROUTER_LABEL.to_owned(),
    available: openrouter_available,
    unavailable_reason: unavailable_reason(openrouter_available),
    supports_model_selection: true,
    supports_reasoning_effort: true,
    models: openrouter_models,
    models_error,
  });
  ChatBackendsResponse {
    backends,
    infumap_tools: super::infumap_tool_specs(),
    tool_servers: mcp::tool_server_catalog(config).await,
  }
}

/// Initial profile resources from server configuration; no provider or MCP network probing is needed.
pub(crate) fn default_query_configuration(
  config: &Config,
) -> InfuResult<crate::query_configuration::QueryConfiguration> {
  let servers = llama_servers_from_config(config)?;
  let target = default_target(config, &servers);
  let model = target.as_ref().map(|target| ChatModelSelection {
    backend: target.id(),
    model: match target {
      ChatTarget::OpenRouter => configured_string(config, CONFIG_CHAT_DEFAULT_OPENROUTER_MODEL),
      _ => None,
    },
    reasoning_effort: None,
  });
  let mut capabilities = vec!["infumap_data".to_owned()];
  capabilities.extend(
    super::mcp::chat_tool_servers_from_config(config)?
      .into_iter()
      .filter(|server| server.enabled_by_default)
      .map(|server| server.id),
  );
  capabilities.sort();
  capabilities.dedup();
  Ok(crate::query_configuration::QueryConfiguration { scope_id: None, model, capabilities })
}

#[cfg(test)]
mod tests {
  use super::*;
  use config::{File, FileFormat};

  fn config(toml: &str) -> Config {
    Config::builder().add_source(File::from_str(toml, FileFormat::Toml)).build().unwrap()
  }

  const TWO_SERVERS: &str = r#"
[[llama_server]]
name = "a"
url = "http://127.0.0.1:8080"

[[llama_server]]
name = "b"
url = "http://127.0.0.1:8081"
"#;

  fn default_id(toml: &str) -> Option<String> {
    let config = config(toml);
    default_target(&config, &llama_servers_from_config(&config).unwrap()).map(|target| target.id())
  }

  #[test]
  fn default_follows_chat_default_backend() {
    assert_eq!(default_id(TWO_SERVERS).as_deref(), Some("llama:a"));
    assert_eq!(default_id(&format!("chat_default_backend = \"llama:b\"\n{TWO_SERVERS}")).as_deref(), Some("llama:b"));
    // OpenRouter is not configured, so a llama server stands in.
    assert_eq!(
      default_id(&format!("chat_default_backend = \"openrouter\"\n{TWO_SERVERS}")).as_deref(),
      Some("llama:a")
    );
    assert_eq!(default_id("openrouter_api_key = \"k\"").as_deref(), Some("openrouter"));
    assert_eq!(default_id(""), None);
  }

  #[test]
  fn an_explicit_request_is_never_substituted() {
    let config = config(TWO_SERVERS);
    let servers = llama_servers_from_config(&config).unwrap();
    assert_eq!(requested_target(&servers, "llama:b").unwrap().id(), "llama:b");
    // The first-server alias would change meaning if the configured servers were reordered.
    assert!(requested_target(&servers, "llama").is_err());
    assert!(requested_target(&servers, "llama:c").is_err());
    assert!(requested_target(&servers, "other").is_err());
  }

  #[test]
  fn validation_rejects_a_default_naming_a_missing_server() {
    assert!(
      validate_chat_backend_config(&config(&format!("chat_default_backend = \"llama:b\"\n{TWO_SERVERS}"))).is_ok()
    );
    assert!(
      validate_chat_backend_config(&config(&format!("chat_default_backend = \"llama:c\"\n{TWO_SERVERS}"))).is_err()
    );
    assert!(validate_chat_backend_config(&config("chat_default_backend = \"other\"")).is_err());
  }
}
