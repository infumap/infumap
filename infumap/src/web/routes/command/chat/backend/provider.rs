// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Configured providers speaking the OpenAI Chat Completions protocol.

use config::Config;
use infusdk::util::infu::InfuResult;
use serde::Deserialize;

use crate::config::CONFIG_CHAT_PROVIDERS;

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

/// Configured Chat providers, read from a TOML array or a JSON string.
pub fn chat_providers_from_config(config: &Config) -> InfuResult<Vec<ChatProvider>> {
  match config.get::<Vec<ChatProviderFile>>(CONFIG_CHAT_PROVIDERS) {
    Ok(entries) => entries.into_iter().map(parse_provider).collect(),
    Err(_) => match config.get_string(CONFIG_CHAT_PROVIDERS) {
      Ok(raw) if raw.trim().is_empty() => Ok(Vec::new()),
      Ok(raw) => serde_json::from_str::<Vec<ChatProviderFile>>(&raw)
        .map_err(|error| format!("Invalid {CONFIG_CHAT_PROVIDERS} JSON: {error}").into())?
        .into_iter()
        .map(parse_provider)
        .collect(),
      Err(config::ConfigError::NotFound(_)) => Ok(Vec::new()),
      Err(_) => Err(format!("{CONFIG_CHAT_PROVIDERS} must be a provider array or JSON string.").into()),
    },
  }
}
