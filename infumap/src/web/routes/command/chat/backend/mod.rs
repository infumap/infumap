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
use crate::ai::gpu_tools::{GPU_TOOL_CHAT, resolve_configured_gpu_tool_url};
use catalog::model_catalog;
pub use provider::{ChatAdapter, ChatProvider, chat_providers_from_config};

const REASONING_EFFORT_NONE: &str = "none";
const REASONING_EFFORTS: &[&str] = &[REASONING_EFFORT_NONE, "minimal", "low", "medium", "high", "xhigh", "max"];
pub const OPENROUTER_APP_TITLE: &str = "Infumap";
const GPU_TOOLS_PROVIDER_ID: &str = "gpu_tools";
const GPU_TOOLS_PROVIDER_LABEL: &str = "GPU tools";

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

/// The model the GPU tools service runs for image extraction is offered for chat whenever
/// `gpu_tools_url` is set, so an installation without a configured provider can still chat.
enum GpuToolsChat {
  /// No GPU tools URL, a service without chat, or a configured provider with the same ID.
  Absent,
  Available(ChatProvider),
  Unavailable(String),
}

async fn gpu_tools_chat(config: &Config, configured: &[ChatProvider]) -> GpuToolsChat {
  // A configured provider with this ID is an explicit choice, and replaces the built-in one.
  if configured.iter().any(|provider| provider.id == GPU_TOOLS_PROVIDER_ID) {
    return GpuToolsChat::Absent;
  }
  match resolve_configured_gpu_tool_url(config, GPU_TOOL_CHAT).await {
    Ok(None) => GpuToolsChat::Absent,
    Ok(Some(mut base_url)) => {
      // Endpoint paths resolve relative to the base, which therefore needs a trailing slash.
      let path = format!("{}/", base_url.path().trim_end_matches('/'));
      base_url.set_path(&path);
      GpuToolsChat::Available(ChatProvider {
        id: GPU_TOOLS_PROVIDER_ID.to_owned(),
        base_url,
        api_key: None,
        adapter: ChatAdapter::LlamaCpp,
        model_name: None,
        // llama-server runs with reasoning off for image extraction.
        reasoning_efforts: Vec::new(),
      })
    }
    Err(error) => {
      warn!("Could not discover GPU tools chat: {}", error);
      GpuToolsChat::Unavailable("Could not reach the GPU tools service.".to_owned())
    }
  }
}

async fn selected_provider(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatProvider> {
  let configured = chat_providers_from_config(config)?;
  if let Some(provider) = configured.iter().find(|provider| provider.id == selection.backend) {
    return Ok(provider.clone());
  }
  if selection.backend == GPU_TOOLS_PROVIDER_ID {
    match gpu_tools_chat(config, &configured).await {
      GpuToolsChat::Available(provider) => return Ok(provider),
      GpuToolsChat::Unavailable(reason) => {
        return Err(format!("{GPU_TOOLS_PROVIDER_LABEL} is unavailable. {reason} Choose another provider.").into());
      }
      GpuToolsChat::Absent => {}
    }
  }
  Err(format!("Provider '{}' is not configured on this server. Choose another provider.", selection.backend).into())
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
    // On the modest GPUs GPU tools targets, the first token of a long prompt can take minutes.
    read_timeout: Duration::from_secs(
      if provider.adapter == ChatAdapter::Openrouter || provider.id == GPU_TOOLS_PROVIDER_ID { 300 } else { 120 },
    ),
  })
}

pub async fn resolve_chat_endpoint(config: &Config, selection: &ChatModelSelection) -> InfuResult<ChatEndpoint> {
  provider_endpoint(&selected_provider(config, selection).await?, selection)
}

/// Fresh metadata validates the exact selection. Failed discovery or a stale catalog cannot
/// establish that a model disappeared, and leaves the explicitly selected request intact.
pub async fn resolve_validated_chat_endpoint(
  config: &Config,
  selection: &ChatModelSelection,
) -> InfuResult<ChatEndpoint> {
  let provider = selected_provider(config, selection).await?;
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
  #[serde(rename = "unavailableReason", skip_serializing_if = "Option::is_none")]
  unavailable_reason: Option<String>,
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
  #[serde(rename = "defaultConfiguration")]
  default_configuration: crate::query_configuration::QueryConfiguration,
}

async fn backend_info(provider: &ChatProvider, label: &str) -> ChatBackendInfo {
  let (models, models_error) = match model_catalog(provider).await {
    Ok(catalog) => (
      (*catalog.models).clone(),
      if catalog.fresh { None } else { Some("Could not refresh the model list; showing a saved catalog.".to_owned()) },
    ),
    Err(error) => {
      warn!("Could not load models for '{}': {}", provider.id, error);
      (Vec::new(), Some("Could not load the model list.".to_owned()))
    }
  };
  ChatBackendInfo {
    id: provider.id.clone(),
    label: label.to_owned(),
    available: true,
    unavailable_reason: None,
    models,
    models_error,
  }
}

pub async fn chat_backends(config: &Config) -> ChatBackendsResponse {
  let providers = chat_providers_from_config(config).unwrap_or_else(|error| {
    warn!("Could not read chat providers: {}", error);
    Vec::new()
  });
  let catalogs = futures_util::future::join_all(providers.iter().map(|provider| backend_info(provider, &provider.id)));
  let gpu_tools = async {
    match gpu_tools_chat(config, &providers).await {
      GpuToolsChat::Absent => None,
      GpuToolsChat::Available(provider) => Some(backend_info(&provider, GPU_TOOLS_PROVIDER_LABEL).await),
      GpuToolsChat::Unavailable(reason) => Some(ChatBackendInfo {
        id: GPU_TOOLS_PROVIDER_ID.to_owned(),
        label: GPU_TOOLS_PROVIDER_LABEL.to_owned(),
        available: false,
        unavailable_reason: Some(reason),
        models: Vec::new(),
        models_error: None,
      }),
    }
  };
  let (mut backends, gpu_tools, tool_servers) = tokio::join!(catalogs, gpu_tools, mcp::tool_server_catalog(config));
  backends.extend(gpu_tools);
  let default_configuration = initial_query_configuration(&backends, &tool_servers);
  ChatBackendsResponse { backends, infumap_tools: super::infumap_tool_specs(), tool_servers, default_configuration }
}

/// What a new query starts with when the account has no default profile: the first model of the first available
/// provider, and the tool sources enabled by default, in configuration/catalog order. It is derived from the catalog on
/// every request and never saved. Saving it as a profile when an account was created froze whatever was discoverable
/// then, which on a new server is usually no provider at all, and later configuration never reached it.
fn initial_query_configuration(
  backends: &[ChatBackendInfo],
  tool_servers: &[ChatToolServerInfo],
) -> crate::query_configuration::QueryConfiguration {
  let model = backends.iter().filter(|backend| backend.available).find_map(|backend| {
    backend.models.first().map(|first| ChatModelSelection {
      backend: backend.id.clone(),
      model: Some(first.id.clone()),
      reasoning_effort: None,
    })
  });
  let mut capabilities = vec!["infumap_data".to_owned()];
  capabilities.extend(tool_servers.iter().filter(|server| server.enabled_by_default).map(|server| server.id.clone()));
  capabilities.sort();
  capabilities.dedup();
  crate::query_configuration::QueryConfiguration {
    scope: crate::query_configuration::ScopeRef::Everything,
    model,
    capabilities,
    tool_approval: crate::query_configuration::ToolApproval::Automatic,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use config::{File, FileFormat};

  fn config(toml: &str) -> Config {
    Config::builder().add_source(File::from_str(toml, FileFormat::Toml)).build().unwrap()
  }

  const TWO_PROVIDERS: &str = r#"
[[chat_providers]]
id = "a"
url = "http://127.0.0.1:8080/v1"
discover_models = false

[[chat_providers]]
id = "b"
url = "http://127.0.0.1:8081/v1/chat/completions"
discover_models = false
model_name = "qwen"
"#;

  fn selection(backend: &str, model: Option<&str>) -> ChatModelSelection {
    ChatModelSelection { backend: backend.to_owned(), model: model.map(str::to_owned), reasoning_effort: None }
  }

  #[tokio::test]
  async fn the_default_configuration_uses_the_first_provider_and_model() {
    let configuration = chat_backends(&config(TWO_PROVIDERS)).await.default_configuration;
    assert_eq!(configuration.model, Some(selection("a", Some("default"))));
    assert_eq!(configuration.capabilities, ["infumap_data"]);
    assert_eq!(chat_backends(&config("")).await.default_configuration.model, None);
  }

  #[test]
  fn the_default_configuration_skips_unavailable_and_empty_providers() {
    let backend = |id: &str, available: bool, models: &[&str]| ChatBackendInfo {
      id: id.to_owned(),
      label: id.to_owned(),
      available,
      unavailable_reason: None,
      models: models
        .iter()
        .map(|id| catalog::ChatModelInfo {
          id: (*id).to_owned(),
          name: (*id).to_owned(),
          context_length: None,
          reasoning_efforts: vec![],
          default_effort: None,
          reasoning_mandatory: false,
          prompt_price: None,
          completion_price: None,
        })
        .collect(),
      models_error: None,
    };
    let backends = [backend("down", false, &["x"]), backend("empty", true, &[]), backend("up", true, &["m1", "m2"])];
    assert_eq!(initial_query_configuration(&backends, &[]).model, Some(selection("up", Some("m1"))));
  }

  #[tokio::test]
  async fn an_explicit_request_is_never_substituted() {
    let config = config(TWO_PROVIDERS);
    let endpoint = resolve_chat_endpoint(&config, &selection("b", Some("qwen"))).await.unwrap();
    assert_eq!((endpoint.label.as_str(), endpoint.model.as_str()), ("b", "qwen"));
    assert_eq!(endpoint.url.as_str(), "http://127.0.0.1:8081/v1/chat/completions");
    assert!(resolve_chat_endpoint(&config, &selection("c", Some("qwen"))).await.is_err());
    // The provider's configured model is not used in place of another or a missing one.
    assert!(resolve_chat_endpoint(&config, &selection("b", Some("default"))).await.is_err());
    assert!(resolve_chat_endpoint(&config, &selection("b", None)).await.is_err());
    // Without a GPU tools URL there is no built-in GPU tools provider.
    assert!(resolve_chat_endpoint(&config, &selection(GPU_TOOLS_PROVIDER_ID, Some("m"))).await.is_err());
  }

  #[test]
  fn validation_rejects_invalid_providers() {
    assert!(validate_chat_backend_config(&config(TWO_PROVIDERS)).is_ok());
    assert!(validate_chat_backend_config(&config("[[chat_providers]]\nid = \"a b\"\nurl = \"http://x/v1\"")).is_err());
    assert!(validate_chat_backend_config(&config("[[chat_providers]]\nid = \"a\"\nurl = \"ftp://x/v1\"")).is_err());
    assert!(
      validate_chat_backend_config(&config(
        "[[chat_providers]]\nid = \"or\"\nurl = \"https://x/v1\"\nadapter = \"openrouter\"\nmodel_name = \"m\""
      ))
      .is_err()
    );
  }
}
