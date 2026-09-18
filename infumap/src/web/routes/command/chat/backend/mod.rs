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
use serde::{Deserialize, Serialize};
use std::time::Duration;

mod openrouter;
pub use openrouter::ChatModelInfo;

use super::mcp::{self, ChatToolServerInfo};
use crate::config::{
  CHAT_BACKEND_LLAMA, CHAT_BACKEND_OPENROUTER, CONFIG_CHAT_DEFAULT_BACKEND, CONFIG_CHAT_DEFAULT_OPENROUTER_MODEL,
  CONFIG_LLAMA_SERVER_URL, CONFIG_OPENROUTER_API_KEY,
};

/// Path appended to a llama-server base URL. OpenRouter URLs are built relative to its API base
/// instead, which already carries its own version segment.
const LLAMA_CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";

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

/// Which upstream service a chat request is sent to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatBackend {
  LlamaServer,
  OpenRouter,
}

impl ChatBackend {
  fn from_id(id: &str) -> Option<Self> {
    match id.trim() {
      CHAT_BACKEND_LLAMA => Some(Self::LlamaServer),
      CHAT_BACKEND_OPENROUTER => Some(Self::OpenRouter),
      _ => None,
    }
  }

  /// Name for this backend in messages logged or shown to the user.
  pub fn label(&self) -> &'static str {
    match self {
      Self::LlamaServer => "llama-server",
      Self::OpenRouter => "OpenRouter",
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

/// The backend, model and reasoning effort the client asked for. Every field is optional - an
/// absent field falls back to what the instance is configured to use.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ChatModelSelection {
  #[serde(default)]
  pub backend: Option<String>,
  #[serde(default)]
  pub model: Option<String>,
  #[serde(rename = "reasoningEffort", default)]
  pub reasoning_effort: Option<String>,
}

impl ChatModelSelection {
  fn requested_backend(&self) -> InfuResult<Option<ChatBackend>> {
    let Some(backend) = self.backend.as_deref().map(str::trim).filter(|backend| !backend.is_empty()) else {
      return Ok(None);
    };
    ChatBackend::from_id(backend)
      .map(Some)
      .ok_or_else(|| format!("Chat request named unknown backend '{}'.", backend).into())
  }

  fn requested_model(&self) -> Option<&str> {
    self.model.as_deref().map(str::trim).filter(|model| !model.is_empty())
  }

  fn requested_reasoning(&self) -> InfuResult<ChatReasoning> {
    let Some(effort) = self.reasoning_effort.as_deref().map(str::trim).filter(|effort| !effort.is_empty()) else {
      return Ok(ChatReasoning::ModelDefault);
    };
    let effort = REASONING_EFFORTS
      .iter()
      .copied()
      .find(|known| known.eq_ignore_ascii_case(effort))
      .ok_or_else(|| format!("Chat request named unknown reasoning effort '{}'.", effort))?;
    Ok(if effort == REASONING_EFFORT_NONE { ChatReasoning::Disabled } else { ChatReasoning::Effort(effort) })
  }
}

/// Everything needed to issue one chat completion request.
pub struct ChatEndpoint {
  pub backend: ChatBackend,
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

/// llama-server: the configured value is either the server base URL or the full chat completions
/// endpoint URL.
fn llama_chat_completions_url(configured_url: &str) -> InfuResult<reqwest::Url> {
  let parsed = reqwest::Url::parse(configured_url)
    .map_err(|e| format!("Could not parse {} '{}': {}", CONFIG_LLAMA_SERVER_URL, configured_url, e))?;
  if parsed.path().trim_end_matches('/').ends_with(LLAMA_CHAT_COMPLETIONS_PATH) {
    return Ok(parsed);
  }

  let base_url = reqwest::Url::parse(&format!("{}/", configured_url.trim_end_matches('/')))
    .map_err(|e| format!("Could not parse {} '{}': {}", CONFIG_LLAMA_SERVER_URL, configured_url, e))?;
  base_url
    .join(LLAMA_CHAT_COMPLETIONS_PATH.trim_start_matches('/'))
    .map_err(|e| format!("Could not build chat completions endpoint from '{}': {}", configured_url, e).into())
}

/// An OpenRouter endpoint, resolved relative to its API base.
fn openrouter_api_url(path: &str) -> InfuResult<reqwest::Url> {
  reqwest::Url::parse(OPENROUTER_API_BASE)
    .and_then(|base| base.join(path))
    .map_err(|e| format!("Could not build the OpenRouter '{}' endpoint: {}", path, e).into())
}

fn llama_endpoint(config: &Config) -> InfuResult<ChatEndpoint> {
  let configured_url = configured_string(config, CONFIG_LLAMA_SERVER_URL)
    .ok_or_else(|| format!("{} must be configured to use Chat.", CONFIG_LLAMA_SERVER_URL))?;
  Ok(ChatEndpoint {
    backend: ChatBackend::LlamaServer,
    url: llama_chat_completions_url(&configured_url)?,
    api_key: None,
    model: LLAMA_MODEL_NAME.to_owned(),
    // llama.cpp only honours a reasoning effort if the loaded model's chat template happens to use
    // it, so Infumap does not offer the choice and never sends one.
    reasoning: ChatReasoning::ModelDefault,
    connect_timeout: Duration::from_secs(LLAMA_CONNECT_TIMEOUT_SECS),
    read_timeout: Duration::from_secs(LLAMA_READ_TIMEOUT_SECS),
  })
}

fn openrouter_endpoint(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatEndpoint> {
  let api_key = configured_string(config, CONFIG_OPENROUTER_API_KEY)
    .ok_or_else(|| format!("{} must be configured to use Chat.", CONFIG_OPENROUTER_API_KEY))?;
  let model = selection
    .requested_model()
    .map(str::to_owned)
    .or_else(|| configured_string(config, CONFIG_CHAT_DEFAULT_OPENROUTER_MODEL))
    .ok_or_else(|| {
      format!("Chat request did not name an OpenRouter model, and {} is not set.", CONFIG_CHAT_DEFAULT_OPENROUTER_MODEL)
    })?;
  Ok(ChatEndpoint {
    backend: ChatBackend::OpenRouter,
    url: openrouter_api_url("chat/completions")?,
    api_key: Some(api_key),
    model,
    reasoning: selection.requested_reasoning()?,
    connect_timeout: Duration::from_secs(OPENROUTER_CONNECT_TIMEOUT_SECS),
    read_timeout: Duration::from_secs(OPENROUTER_READ_TIMEOUT_SECS),
  })
}

fn llama_is_configured(config: &Config) -> bool {
  configured_string(config, CONFIG_LLAMA_SERVER_URL).is_some()
}

fn openrouter_is_configured(config: &Config) -> bool {
  configured_string(config, CONFIG_OPENROUTER_API_KEY).is_some()
}

/// The backend to use when the client did not ask for one: the configured default, falling back
/// to the other backend when the default is not configured.
fn default_backend(config: &Config) -> ChatBackend {
  let configured_default = configured_string(config, CONFIG_CHAT_DEFAULT_BACKEND)
    .and_then(|backend| ChatBackend::from_id(&backend))
    .unwrap_or(ChatBackend::LlamaServer);
  match configured_default {
    ChatBackend::LlamaServer if !llama_is_configured(config) && openrouter_is_configured(config) => {
      ChatBackend::OpenRouter
    }
    ChatBackend::OpenRouter if !openrouter_is_configured(config) && llama_is_configured(config) => {
      ChatBackend::LlamaServer
    }
    backend => backend,
  }
}

/// Resolve the endpoint for one chat request. A backend the client named explicitly is never
/// silently swapped for another - that is an error the user should see.
pub fn resolve_chat_endpoint(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatEndpoint> {
  let backend = match selection.requested_backend()? {
    Some(backend) => backend,
    None => default_backend(config),
  };
  match backend {
    ChatBackend::LlamaServer => llama_endpoint(config),
    ChatBackend::OpenRouter => openrouter_endpoint(config, selection),
  }
}

/// What one backend offers, as reported to the web client.
#[derive(Serialize)]
struct ChatBackendInfo {
  id: &'static str,
  label: &'static str,
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

/// What a chat request with no explicit selection will use.
#[derive(Serialize)]
struct ChatDefaultSelection {
  backend: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  model: Option<String>,
}

#[derive(Serialize)]
pub struct ChatBackendsResponse {
  backends: Vec<ChatBackendInfo>,
  default: ChatDefaultSelection,
  #[serde(rename = "infumapTools")]
  infumap_tools: Vec<super::OpenAiToolSpec>,
  #[serde(rename = "toolServers")]
  tool_servers: Vec<ChatToolServerInfo>,
}

fn backend_id(backend: ChatBackend) -> &'static str {
  match backend {
    ChatBackend::LlamaServer => CHAT_BACKEND_LLAMA,
    ChatBackend::OpenRouter => CHAT_BACKEND_OPENROUTER,
  }
}

/// The backends this instance can use, and the models each offers.
pub async fn chat_backends(config: &Config) -> ChatBackendsResponse {
  let openrouter_available = openrouter_is_configured(config);
  let (openrouter_models, models_error) = if openrouter_available {
    match openrouter::model_catalog().await {
      Ok(models) => ((*models).clone(), None),
      Err(e) => {
        warn!("Could not load the OpenRouter model list: {}", e);
        (Vec::new(), Some("Could not load the OpenRouter model list.".to_owned()))
      }
    }
  } else {
    (Vec::new(), None)
  };

  let llama_available = llama_is_configured(config);
  let unavailable_reason = |available: bool| if available { None } else { Some("Not configured on this server") };
  let default_backend = default_backend(config);
  ChatBackendsResponse {
    backends: vec![
      ChatBackendInfo {
        id: CHAT_BACKEND_LLAMA,
        label: ChatBackend::LlamaServer.label(),
        available: llama_available,
        unavailable_reason: unavailable_reason(llama_available),
        // llama-server serves whatever model it was started with, and llama.cpp only honours a
        // reasoning effort if the model's chat template happens to use it.
        supports_model_selection: false,
        supports_reasoning_effort: false,
        models: Vec::new(),
        models_error: None,
      },
      ChatBackendInfo {
        id: CHAT_BACKEND_OPENROUTER,
        label: ChatBackend::OpenRouter.label(),
        available: openrouter_available,
        unavailable_reason: unavailable_reason(openrouter_available),
        supports_model_selection: true,
        supports_reasoning_effort: true,
        models: openrouter_models,
        models_error,
      },
    ],
    default: ChatDefaultSelection {
      backend: backend_id(default_backend),
      model: match default_backend {
        ChatBackend::OpenRouter => configured_string(config, CONFIG_CHAT_DEFAULT_OPENROUTER_MODEL),
        ChatBackend::LlamaServer => None,
      },
    },
    infumap_tools: super::infumap_tool_specs(),
    tool_servers: mcp::tool_server_catalog(config).await,
  }
}
