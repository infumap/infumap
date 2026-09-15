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

//! The list of models offered by OpenRouter, as shown in the Chat model picker.
//!
//! OpenRouter publishes this without authentication, so the catalog is fetched anonymously - an
//! expired or mistyped key should not be able to empty the picker. The list changes rarely and is
//! the same for every user of an instance, so one process-wide cache serves everybody.

use infusdk::util::infu::InfuResult;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::openrouter_api_url;

const CATALOG_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const CATALOG_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);

/// Infumap's chat always defines tools, and a model that cannot call them cannot answer from
/// workspace data or the web. Such models are left out of the catalog entirely.
const REQUIRED_PARAMETER: &str = "tools";

/// One model, as offered to the web client.
#[derive(Clone, Serialize)]
pub struct ChatModelInfo {
  pub id: String,
  pub name: String,
  #[serde(rename = "contextLength", skip_serializing_if = "Option::is_none")]
  pub context_length: Option<i64>,
  /// Effort levels this model accepts. Empty for a model that does not reason.
  #[serde(rename = "reasoningEfforts")]
  pub reasoning_efforts: Vec<String>,
  #[serde(rename = "defaultEffort", skip_serializing_if = "Option::is_none")]
  pub default_effort: Option<String>,
  /// True when the model always reasons, and reasoning cannot be turned off.
  #[serde(rename = "reasoningMandatory")]
  pub reasoning_mandatory: bool,
  /// Price in US dollars per token, as OpenRouter reports it.
  #[serde(rename = "promptPrice", skip_serializing_if = "Option::is_none")]
  pub prompt_price: Option<String>,
  #[serde(rename = "completionPrice", skip_serializing_if = "Option::is_none")]
  pub completion_price: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResponse {
  #[serde(default)]
  data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
  id: String,
  #[serde(default)]
  name: Option<String>,
  #[serde(default)]
  context_length: Option<i64>,
  #[serde(default)]
  supported_parameters: Vec<String>,
  #[serde(default)]
  pricing: Option<Pricing>,
  #[serde(default)]
  reasoning: Option<Reasoning>,
}

#[derive(Deserialize)]
struct Pricing {
  #[serde(default)]
  prompt: Option<String>,
  #[serde(default)]
  completion: Option<String>,
}

#[derive(Deserialize)]
struct Reasoning {
  #[serde(default)]
  mandatory: bool,
  #[serde(default)]
  supported_efforts: Option<Vec<String>>,
  #[serde(default)]
  default_effort: Option<String>,
}

struct CachedCatalog {
  models: Arc<Vec<ChatModelInfo>>,
  fetched_at: Instant,
}

fn cache() -> &'static Mutex<Option<CachedCatalog>> {
  static CACHE: OnceLock<Mutex<Option<CachedCatalog>>> = OnceLock::new();
  CACHE.get_or_init(|| Mutex::new(None))
}

fn lock_cache() -> std::sync::MutexGuard<'static, Option<CachedCatalog>> {
  cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cached(require_fresh: bool) -> Option<Arc<Vec<ChatModelInfo>>> {
  let cache = lock_cache();
  let entry = cache.as_ref()?;
  if require_fresh && entry.fetched_at.elapsed() >= CATALOG_TTL {
    return None;
  }
  Some(entry.models.clone())
}

fn model_info(model: Model) -> Option<ChatModelInfo> {
  if !model.supported_parameters.iter().any(|parameter| parameter == REQUIRED_PARAMETER) {
    return None;
  }
  let id = model.id.trim().to_owned();
  if id.is_empty() {
    return None;
  }
  let name =
    model.name.map(|name| name.trim().to_owned()).filter(|name| !name.is_empty()).unwrap_or_else(|| id.clone());
  let (reasoning_efforts, default_effort, reasoning_mandatory) = match model.reasoning {
    Some(reasoning) => (
      reasoning.supported_efforts.unwrap_or_default(),
      reasoning.default_effort.filter(|effort| !effort.trim().is_empty()),
      reasoning.mandatory,
    ),
    None => (Vec::new(), None, false),
  };
  let (prompt_price, completion_price) = match model.pricing {
    Some(pricing) => (pricing.prompt, pricing.completion),
    None => (None, None),
  };
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

async fn fetch_models() -> InfuResult<Vec<ChatModelInfo>> {
  let url = openrouter_api_url("models")?;
  let client = reqwest::ClientBuilder::new()
    .connect_timeout(CATALOG_CONNECT_TIMEOUT)
    .timeout(CATALOG_TIMEOUT)
    .build()
    .map_err(|e| format!("Could not build OpenRouter HTTP client: {}", e))?;
  let response = client
    .get(url.clone())
    .header(reqwest::header::ACCEPT, "application/json")
    .send()
    .await
    .map_err(|e| format!("Could not fetch the OpenRouter model list from '{}': {}", url, e))?;

  let status = response.status();
  if !status.is_success() {
    return Err(format!("OpenRouter model list endpoint '{}' returned {}.", url, status).into());
  }
  let response: ModelsResponse =
    response.json().await.map_err(|e| format!("Could not parse the OpenRouter model list from '{}': {}", url, e))?;

  let total = response.data.len();
  let mut models: Vec<ChatModelInfo> = response.data.into_iter().filter_map(model_info).collect();
  models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
  info!("Fetched {} OpenRouter models, {} of which support tool calling.", total, models.len());
  Ok(models)
}

/// The catalog, refetched when the cached copy has expired. A refresh that fails falls back to the
/// last good copy: a stale model list is far more useful than none.
pub async fn model_catalog() -> InfuResult<Arc<Vec<ChatModelInfo>>> {
  if let Some(models) = cached(true) {
    return Ok(models);
  }

  match fetch_models().await {
    Ok(models) => {
      let models = Arc::new(models);
      *lock_cache() = Some(CachedCatalog { models: models.clone(), fetched_at: Instant::now() });
      Ok(models)
    }
    Err(e) => match cached(false) {
      Some(models) => {
        warn!("Could not refresh the OpenRouter model list, serving the cached copy: {}", e);
        Ok(models)
      }
      None => Err(e),
    },
  }
}
