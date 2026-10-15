// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Model discovery and capability metadata, cached independently for each provider configuration.

use infusdk::util::infu::InfuResult;
use log::warn;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::{ChatAdapter, ChatProvider};

#[derive(Clone, Serialize)]
pub struct ChatModelInfo {
  pub id: String,
  pub name: String,
  #[serde(rename = "contextLength", skip_serializing_if = "Option::is_none")]
  pub context_length: Option<i64>,
  #[serde(rename = "reasoningEfforts")]
  pub reasoning_efforts: Vec<String>,
  #[serde(rename = "defaultEffort", skip_serializing_if = "Option::is_none")]
  pub default_effort: Option<String>,
  #[serde(rename = "reasoningMandatory")]
  pub reasoning_mandatory: bool,
  #[serde(rename = "promptPrice", skip_serializing_if = "Option::is_none")]
  pub prompt_price: Option<String>,
  #[serde(rename = "completionPrice", skip_serializing_if = "Option::is_none")]
  pub completion_price: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResponse {
  data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
  id: String,
  name: Option<String>,
  context_length: Option<i64>,
  supported_parameters: Option<Vec<String>>,
  pricing: Option<Pricing>,
  reasoning: Option<Reasoning>,
}

#[derive(Deserialize)]
struct Pricing {
  prompt: Option<String>,
  completion: Option<String>,
}

#[derive(Deserialize)]
struct Reasoning {
  #[serde(default)]
  mandatory: bool,
  supported_efforts: Option<Vec<String>>,
  default_effort: Option<String>,
}

pub struct ModelCatalog {
  pub models: Arc<Vec<ChatModelInfo>>,
  /// A stale catalog is useful for browsing but cannot prove that a model disappeared.
  pub fresh: bool,
}

struct CachedCatalog {
  models: Arc<Vec<ChatModelInfo>>,
  fetched_at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CachedCatalog>> {
  static CACHE: OnceLock<Mutex<HashMap<String, CachedCatalog>>> = OnceLock::new();
  CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(provider: &ChatProvider) -> String {
  // Credentials affect discovery, but must never appear in a cache key that could be logged.
  let mut digest = Sha256::new();
  for part in [
    provider.id.as_str(),
    provider.base_url.as_str(),
    provider.adapter.name(),
    provider.api_key.as_deref().unwrap_or(""),
  ]
  .into_iter()
  .chain(provider.reasoning_efforts.iter().map(String::as_str))
  {
    digest.update((part.len() as u64).to_le_bytes());
    digest.update(part.as_bytes());
  }
  format!("{:x}", digest.finalize())
}

fn cached(key: &str, ttl: Duration) -> Option<ModelCatalog> {
  let cache = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let entry = cache.get(key)?;
  Some(ModelCatalog { models: entry.models.clone(), fresh: entry.fetched_at.elapsed() < ttl })
}

fn model_info(provider: &ChatProvider, model: Model) -> Option<ChatModelInfo> {
  // OpenRouter guarantees this metadata. A generic /models response need not report capabilities;
  // its administrator is responsible for offering models with tool calling support.
  let reports_tools = model
    .supported_parameters
    .as_ref()
    .is_some_and(|parameters| parameters.iter().any(|parameter| parameter == "tools"));
  if !reports_tools && (provider.adapter == ChatAdapter::Openrouter || model.supported_parameters.is_some()) {
    return None;
  }
  let id = model.id.trim().to_owned();
  if crate::query_configuration::validate_text(&id, "model ID", 512).is_err() {
    return None;
  }
  let name =
    model.name.map(|name| name.trim().to_owned()).filter(|name| !name.is_empty()).unwrap_or_else(|| id.clone());
  let (efforts, default_effort, reasoning_mandatory) = match model.reasoning {
    Some(reasoning) => (reasoning.supported_efforts.unwrap_or_default(), reasoning.default_effort, reasoning.mandatory),
    None => (Vec::new(), None, false),
  };
  let reasoning_efforts = if provider.reasoning_efforts.is_empty() {
    efforts.into_iter().filter(|effort| super::REASONING_EFFORTS.contains(&effort.as_str())).collect()
  } else {
    provider.reasoning_efforts.clone()
  };
  let (prompt_price, completion_price) =
    model.pricing.map(|pricing| (pricing.prompt, pricing.completion)).unwrap_or((None, None));
  Some(ChatModelInfo {
    id,
    name,
    context_length: model.context_length,
    reasoning_efforts,
    default_effort,
    reasoning_mandatory,
    prompt_price,
    completion_price,
  })
}

async fn fetch_models(provider: &ChatProvider) -> InfuResult<Vec<ChatModelInfo>> {
  let client = reqwest::ClientBuilder::new()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_secs(30))
    .build()
    .map_err(|_| format!("Could not build a model discovery client for '{}'.", provider.id))?;
  let mut request = client.get(provider.api_url("models")?).header(reqwest::header::ACCEPT, "application/json");
  // OpenRouter's catalog is public; other endpoints may require the same key as completions.
  if provider.adapter != ChatAdapter::Openrouter
    && let Some(key) = &provider.api_key
  {
    request = request.bearer_auth(key);
  }
  let response = request.send().await.map_err(|_| format!("Could not fetch models for '{}'.", provider.id))?;
  if !response.status().is_success() {
    return Err(format!("Model discovery for '{}' returned {}.", provider.id, response.status()).into());
  }
  let response: ModelsResponse =
    response.json().await.map_err(|_| format!("Invalid model discovery response for '{}'.", provider.id))?;
  let mut seen = HashSet::new();
  Ok(
    response
      .data
      .into_iter()
      .filter_map(|model| model_info(provider, model))
      .filter(|model| seen.insert(model.id.clone()))
      .collect(),
  )
}

/// Configured model IDs are authoritative and preserve their order. Otherwise discover /models.
pub async fn model_catalog(provider: &ChatProvider) -> InfuResult<ModelCatalog> {
  if !provider.models.is_empty() {
    let models = provider
      .models
      .iter()
      .map(|id| ChatModelInfo {
        id: id.clone(),
        name: id.clone(),
        context_length: None,
        reasoning_efforts: provider.reasoning_efforts.clone(),
        default_effort: None,
        reasoning_mandatory: false,
        prompt_price: None,
        completion_price: None,
      })
      .collect();
    return Ok(ModelCatalog { models: Arc::new(models), fresh: true });
  }
  let key = cache_key(provider);
  let ttl = Duration::from_secs(if provider.adapter == ChatAdapter::Openrouter { 6 * 60 * 60 } else { 5 * 60 });
  if let Some(catalog) = cached(&key, ttl)
    && catalog.fresh
  {
    return Ok(catalog);
  }
  match fetch_models(provider).await {
    Ok(models) => {
      let models = Arc::new(models);
      let mut cache = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      cache.insert(key, CachedCatalog { models: models.clone(), fetched_at: Instant::now() });
      Ok(ModelCatalog { models, fresh: true })
    }
    Err(error) => match cached(&key, ttl) {
      Some(catalog) => {
        warn!("Could not refresh models for '{}'; using the cached catalog: {}", provider.id, error);
        Ok(catalog)
      }
      None => Err(error),
    },
  }
}
