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

//! Provider resolution for the shared OpenAI Chat Completions transport.

use config::Config;
use infusdk::util::infu::InfuResult;
use log::warn;
use serde::Serialize;
use std::time::Duration;

mod catalog;
mod provider;
use super::mcp::{self, ChatToolServerInfo};
use catalog::model_catalog;
pub use provider::{ChatAdapter, ChatProvider, chat_providers_from_config};

const REASONING_EFFORT_NONE: &str = "none";
const REASONING_EFFORTS: &[&str] = &[REASONING_EFFORT_NONE, "minimal", "low", "medium", "high", "xhigh", "max"];
pub const OPENROUTER_APP_TITLE: &str = "Infumap";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatReasoning {
  ModelDefault,
  Disabled,
  Effort(&'static str),
}

pub use crate::query_configuration::ChatModelSelection;

impl ChatModelSelection {
  fn requested_reasoning(&self) -> InfuResult<ChatReasoning> {
    let Some(effort) = self.reasoning_effort.as_deref() else {
      return Ok(ChatReasoning::ModelDefault);
    };
    let effort = REASONING_EFFORTS
      .iter()
      .copied()
      .find(|known| known.eq_ignore_ascii_case(effort.trim()))
      .ok_or("Reasoning effort is not recognized. Choose Default or a supported effort.")?;
    Ok(if effort == REASONING_EFFORT_NONE { ChatReasoning::Disabled } else { ChatReasoning::Effort(effort) })
  }
}

/// Credentials and adapter details never leave the server.
pub struct ChatEndpoint {
  pub adapter: ChatAdapter,
  pub label: String,
  pub url: reqwest::Url,
  pub api_key: Option<String>,
  pub model: String,
  pub reasoning: ChatReasoning,
  pub connect_timeout: Duration,
  pub read_timeout: Duration,
}

fn selected_provider(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatProvider> {
  chat_providers_from_config(config)?.into_iter().find(|provider| provider.id == selection.backend).ok_or_else(|| {
    format!("Provider '{}' is not configured on this server. Choose another provider.", selection.backend).into()
  })
}

fn provider_endpoint(provider: &ChatProvider, selection: &ChatModelSelection) -> InfuResult<ChatEndpoint> {
  let model = selection
    .model
    .as_deref()
    .map(str::trim)
    .filter(|model| !model.is_empty())
    .ok_or("Selected model is missing. Choose an explicit model.")?;
  if provider.adapter == ChatAdapter::Openrouter && model == "default" {
    return Err("OpenRouter requires an explicit catalog model ID; 'default' is not supported.".into());
  }
  if provider.model_name.as_deref().is_some_and(|name| name != model) {
    return Err(
      format!("Selected model '{}' is not configured for '{}'. Choose another model.", model, provider.id).into(),
    );
  }
  Ok(ChatEndpoint {
    adapter: provider.adapter,
    label: provider.id.clone(),
    url: provider.api_url("chat/completions")?,
    api_key: provider.api_key.clone(),
    model: model.to_owned(),
    reasoning: selection.requested_reasoning()?,
    connect_timeout: Duration::from_secs(30),
    read_timeout: Duration::from_secs(if provider.adapter == ChatAdapter::Openrouter { 300 } else { 120 }),
  })
}

pub fn resolve_chat_endpoint(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatEndpoint> {
  provider_endpoint(&selected_provider(config, selection)?, selection)
}

/// Fresh metadata validates the exact selection. Failed discovery or a stale catalog cannot
/// establish that a model disappeared, and leaves the explicitly selected request intact.
pub async fn resolve_validated_chat_endpoint(
  config: &Config,
  selection: &ChatModelSelection,
) -> InfuResult<ChatEndpoint> {
  let provider = selected_provider(config, selection)?;
  let endpoint = provider_endpoint(&provider, selection)?;
  let Ok(catalog) = model_catalog(&provider).await else {
    return Ok(endpoint);
  };
  if !catalog.fresh {
    return Ok(endpoint);
  }
  let model = catalog.models.iter().find(|model| model.id == endpoint.model).ok_or_else(|| {
    format!("Selected model '{}' is not in the '{}' catalog. Choose another model.", endpoint.model, provider.id)
  })?;
  if let Some(effort) = selection.reasoning_effort.as_deref()
    && !model.reasoning_efforts.iter().any(|supported| supported.eq_ignore_ascii_case(effort.trim()))
  {
    return Err(
      format!("Selected reasoning effort is not supported by '{}'. Choose Default or a supported effort.", model.name)
        .into(),
    );
  }
  Ok(endpoint)
}

pub fn validate_chat_backend_config(config: &Config) -> InfuResult<()> {
  chat_providers_from_config(config)?;
  Ok(())
}

#[derive(Serialize)]
struct ChatBackendInfo {
  id: String,
  label: String,
  available: bool,
  models: Vec<catalog::ChatModelInfo>,
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

pub async fn chat_backends(config: &Config) -> ChatBackendsResponse {
  let providers = chat_providers_from_config(config).unwrap_or_else(|error| {
    warn!("Could not read chat providers: {}", error);
    Vec::new()
  });
  let catalogs = futures_util::future::join_all(providers.iter().map(|provider| async move {
    let (models, models_error) = match model_catalog(provider).await {
      Ok(catalog) => (
        (*catalog.models).clone(),
        if catalog.fresh {
          None
        } else {
          Some("Could not refresh the model list; showing a saved catalog.".to_owned())
        },
      ),
      Err(error) => {
        warn!("Could not load models for '{}': {}", provider.id, error);
        (Vec::new(), Some("Could not load the model list.".to_owned()))
      }
    };
    ChatBackendInfo { id: provider.id.clone(), label: provider.id.clone(), available: true, models, models_error }
  }));
  let (backends, tool_servers) = tokio::join!(catalogs, mcp::tool_server_catalog(config));
  ChatBackendsResponse { backends, infumap_tools: super::infumap_tool_specs(), tool_servers }
}

/// Initial profiles use the first provider with an available model, in configuration/catalog order.
/// Network discovery happens before the caller acquires the database lock.
pub(crate) async fn default_query_configuration(
  config: &Config,
) -> InfuResult<crate::query_configuration::QueryConfiguration> {
  let mut model = None;
  for provider in chat_providers_from_config(config)? {
    match model_catalog(&provider).await {
      Ok(catalog) => {
        if let Some(first) = catalog.models.first() {
          model =
            Some(ChatModelSelection { backend: provider.id, model: Some(first.id.clone()), reasoning_effort: None });
          break;
        }
      }
      Err(error) => warn!("Could not discover an initial model for '{}': {}", provider.id, error),
    }
  }
  let mut capabilities = vec!["infumap_data".to_owned()];
  capabilities.extend(
    super::mcp::chat_tool_servers_from_config(config)?
      .into_iter()
      .filter(|server| server.enabled_by_default)
      .map(|server| server.id),
  );
  capabilities.sort();
  capabilities.dedup();
  Ok(crate::query_configuration::QueryConfiguration {
    scope_id: None,
    model,
    capabilities,
    tool_approval: crate::query_configuration::ToolApproval::Automatic,
  })
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
