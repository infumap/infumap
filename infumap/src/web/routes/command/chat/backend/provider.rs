// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Configured providers speaking the OpenAI Chat Completions protocol.

use config::{Config, ConfigError};
use infusdk::util::infu::InfuResult;
use serde::Deserialize;

use crate::config::{CONFIG_CHAT_PROVIDER, CONFIG_CHAT_PROVIDERS};

/// Protocol extensions and message formatting, independent of a provider's identity.
#[derive(Clone, Copy, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChatAdapter {
  #[default]
  Openai,
  Openrouter,
  LlamaCpp,
}

impl ChatAdapter {
  pub fn name(self) -> &'static str {
    match self {
      Self::Openai => "openai",
      Self::Openrouter => "openrouter",
      Self::LlamaCpp => "llama_cpp",
    }
  }
}

/// Credentials stay on the server and are deliberately excluded from Debug and serialization.
#[derive(Clone)]
pub struct ChatProvider {
  pub id: String,
  pub base_url: reqwest::Url,
  pub api_key: Option<String>,
  pub adapter: ChatAdapter,
  pub models: Vec<String>,
  pub reasoning_efforts: Vec<String>,
}

impl ChatProvider {
  pub fn api_url(&self, path: &str) -> InfuResult<reqwest::Url> {
    self.base_url.join(path).map_err(|_| format!("Could not build an endpoint for provider '{}'.", self.id).into())
  }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatProviderFile {
  id: String,
  url: String,
  #[serde(default)]
  api_key: Option<String>,
  #[serde(default)]
  adapter: ChatAdapter,
  #[serde(default)]
  models: Option<Vec<String>>,
  #[serde(default)]
  reasoning_efforts: Vec<String>,
}

fn parse_provider(entry: ChatProviderFile) -> InfuResult<ChatProvider> {
  let id = entry.id.trim().to_owned();
  if id.is_empty()
    || id.len() > 64
    || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
  {
    return Err("Chat provider id must contain 1 to 64 ASCII letters, digits, dots, underscores or hyphens.".into());
  }
  let mut base_url =
    reqwest::Url::parse(entry.url.trim()).map_err(|_| format!("Invalid URL for chat provider '{id}'."))?;
  if !matches!(base_url.scheme(), "http" | "https")
    || base_url.host_str().is_none()
    || !base_url.username().is_empty()
    || base_url.password().is_some()
    || base_url.query().is_some()
    || base_url.fragment().is_some()
  {
    return Err(
      format!("Chat provider '{id}' needs an HTTP(S) API base URL without credentials, query or fragment.").into(),
    );
  }
  // Accept a full completion endpoint too; all API paths resolve relative to the same base.
  let path = base_url.path().trim_end_matches('/');
  let path = path.strip_suffix("/chat/completions").unwrap_or(path);
  let path = format!("{}/", path.trim_end_matches('/'));
  base_url.set_path(&path);
  let api_key = entry.api_key.map(|key| key.trim().to_owned()).filter(|key| !key.is_empty());
  if let Some(key) = &api_key {
    reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
      .map_err(|_| format!("Invalid API key header for chat provider '{id}'."))?;
  }
  let mut models = Vec::new();
  if entry.models.as_ref().is_some_and(Vec::is_empty) {
    return Err(
      format!("Chat provider '{id}' models must contain at least one ID, or be omitted for discovery.").into(),
    );
  }
  for model in entry.models.unwrap_or_default() {
    let model = model.trim().to_owned();
    crate::query_configuration::validate_text(&model, "chat provider model ID", 512)?;
    if models.contains(&model) {
      return Err(format!("Duplicate model ID for chat provider '{id}'.").into());
    }
    models.push(model);
  }
  let mut reasoning_efforts = Vec::new();
  for effort in entry.reasoning_efforts {
    let effort = effort.trim().to_lowercase();
    if !super::REASONING_EFFORTS.contains(&effort.as_str()) {
      return Err(format!("Invalid reasoning effort for chat provider '{id}'.").into());
    }
    if !reasoning_efforts.contains(&effort) {
      reasoning_efforts.push(effort);
    }
  }
  Ok(ChatProvider { id, base_url, api_key, adapter: entry.adapter, models, reasoning_efforts })
}

fn file_entries(config: &Config) -> InfuResult<Vec<ChatProviderFile>> {
  let values = match config.get_array(CONFIG_CHAT_PROVIDER) {
    Ok(values) => values,
    Err(ConfigError::NotFound(_)) => return Ok(Vec::new()),
    Err(_) => return Err(format!("{CONFIG_CHAT_PROVIDER} must be an array of provider entries.").into()),
  };
  values
    .into_iter()
    .enumerate()
    .map(|(index, value)| {
      value.try_deserialize().map_err(|_| {
        format!("Invalid {CONFIG_CHAT_PROVIDER} entry at index {index}; check its fields and value types.").into()
      })
    })
    .collect()
}

fn json_entries(config: &Config) -> InfuResult<Vec<ChatProviderFile>> {
  let raw = match config.get_string(CONFIG_CHAT_PROVIDERS) {
    Ok(raw) => raw,
    Err(ConfigError::NotFound(_)) => return Ok(Vec::new()),
    Err(_) => return Err(format!("{CONFIG_CHAT_PROVIDERS} must be a JSON string containing provider entries.").into()),
  };
  if raw.trim().is_empty() {
    return Ok(Vec::new());
  }
  serde_json::from_str(&raw).map_err(|error| {
    format!(
      "Invalid {CONFIG_CHAT_PROVIDERS} JSON at line {}, column {}; check its fields and value types.",
      error.line(),
      error.column()
    )
    .into()
  })
}

/// TOML entries followed by JSON entries. A later matching ID replaces the entry in its original position.
pub fn chat_providers_from_config(config: &Config) -> InfuResult<Vec<ChatProvider>> {
  let entries = file_entries(config)?.into_iter().chain(json_entries(config)?);
  let mut providers: Vec<ChatProvider> = Vec::new();
  for entry in entries {
    let provider = parse_provider(entry)?;
    if let Some(existing) = providers.iter_mut().find(|existing| existing.id == provider.id) {
      *existing = provider;
    } else {
      providers.push(provider);
    }
  }
  Ok(providers)
}
