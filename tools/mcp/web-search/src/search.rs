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

use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::budget::{BudgetStore, BudgetedProvider};
use crate::config;
use crate::error::InfuResult;
pub use crate::providers::SearchResult;
use crate::providers::diffbot::Diffbot;
use crate::providers::duckduckgo::DuckDuckGo;
use crate::providers::exa::Exa;
use crate::providers::tavily::Tavily;
use crate::providers::{SearchProvider, SearchRequest};
use crate::router::{Backend, ProviderStatus, SearchRouter};

#[cfg(test)]
use crate::providers::duckduckgo::{parse_results, unwrap_ddg_href};

pub const DEFAULT_MAX_RESULTS: usize = 5;
pub const MAX_RESULTS_CAP: usize = 30;

static ROUTER: Lazy<InfuResult<SearchRouter>> = Lazy::new(|| {
  let config = config::search_config().map_err(|message| format!("Invalid web-search configuration: {message}"))?;
  // One store owns the directory lock; metered providers share it while keeping
  // independent provider/account entries in the existing ledger.
  let store = if config.exa.is_some() || config.tavily.is_some() || config.diffbot.is_some() {
    let directory = config.state_dir.as_ref().ok_or("Budget state directory is not configured.")?;
    Some(BudgetStore::open(directory).map_err(|error| format!("Could not initialize search budgets: {error}"))?)
  } else {
    None
  };
  let mut providers = Vec::new();
  if let Some(requests_per_minute) = NonZeroU32::new(config.duckduckgo_requests_per_minute) {
    providers.push(Backend::Unmetered { provider: Box::new(DuckDuckGo), requests_per_minute });
  }
  if let Some(exa) = &config.exa {
    let provider = Exa::new(&exa.api_key)
      .and_then(|adapter| budgeted_provider(adapter, exa, store.as_ref()))
      .map_err(|error| format!("Could not initialize Exa: {error}"))?;
    providers.push(Backend::Metered(provider));
  }
  if let Some(tavily) = &config.tavily {
    let provider = Tavily::new(&tavily.api_key)
      .and_then(|adapter| budgeted_provider(adapter, tavily, store.as_ref()))
      .map_err(|error| format!("Could not initialize Tavily: {error}"))?;
    providers.push(Backend::Metered(provider));
  }
  if let Some(diffbot) = &config.diffbot {
    let provider = Diffbot::new(&diffbot.api_key, config.diffbot_requests_per_minute)
      .and_then(|adapter| budgeted_provider(adapter, diffbot, store.as_ref()))
      .map_err(|error| format!("Could not initialize Diffbot: {error}"))?;
    providers.push(Backend::Metered(provider));
  }
  Ok(SearchRouter::new(providers))
});

fn budgeted_provider(
  adapter: impl SearchProvider + 'static,
  settings: &config::MeteredConfig,
  store: Option<&Arc<BudgetStore>>,
) -> crate::providers::ProviderResult<BudgetedProvider> {
  let store = store.ok_or_else(|| {
    crate::providers::ProviderError::new(
      crate::providers::ProviderErrorKind::Internal,
      "Budget state directory is not configured.",
    )
  })?;
  let account = store.account(adapter.name(), settings.monthly_free_credits_cents, settings.monthly_reset_day)?;
  BudgetedProvider::new(adapter, account)
}

/// Prepare configured clients and validate credentials locally, without issuing
/// any provider requests.
pub fn initialize_providers() -> InfuResult<()> {
  configured_router().map(|_| ())
}

pub async fn provider_status() -> InfuResult<Vec<ProviderStatus>> {
  let config = config::search_config().map_err(str::to_owned)?;
  let request = SearchRequest { query: "status", max_results: DEFAULT_MAX_RESULTS };
  let mut providers = configured_router()?.status(&request).await;
  if config.exa.is_none() {
    providers.push(ProviderStatus::unconfigured("exa", "EXA_API_KEY is not configured."));
  }
  if config.tavily.is_none() {
    providers.push(ProviderStatus::unconfigured("tavily", "TAVILY_API_KEY is not configured."));
  }
  if config.diffbot.is_none() {
    providers.push(ProviderStatus::unconfigured("diffbot", "DIFFBOT_API_KEY is not configured."));
  }
  if config.duckduckgo_requests_per_minute == 0 {
    providers.push(ProviderStatus::unconfigured(
      "duckduckgo",
      "DuckDuckGo is disabled; set WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE to a positive integer to enable.",
    ));
  }
  Ok(providers)
}

/// Poll optional usage reporting without adding another request to every search.
/// Current adapters report None, so this makes no provider HTTP requests.
pub async fn refresh_provider_usage() {
  let Ok(router) = configured_router() else { return };
  let mut interval = tokio::time::interval(Duration::from_secs(300));
  interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
  loop {
    interval.tick().await;
    router.refresh_usage().await;
  }
}

fn configured_router() -> InfuResult<&'static SearchRouter> {
  ROUTER.as_ref().map_err(|error| error.to_string().into())
}

#[derive(Serialize)]
struct CompactWebSearchResponse<'a> {
  query: &'a str,
  results: Vec<CompactSearchResult<'a>>,
}

/// Explicit model-facing fields: adding internal provider metadata must not
/// implicitly expand the tool response.
#[derive(Serialize)]
struct CompactSearchResult<'a> {
  title: &'a str,
  url: &'a str,
  snippet: &'a str,
}

/// Search with the configured provider and return compact JSON for the model.
pub async fn search_web_json(query: &str, max_results: usize) -> InfuResult<String> {
  let query = query.trim();
  if query.is_empty() {
    return Err("search query cannot be empty".into());
  }
  let results = search(query, max_results).await?;
  compact_web_search_json(query, &results)
}

pub fn compact_web_search_json(query: &str, results: &[SearchResult]) -> InfuResult<String> {
  let results = results
    .iter()
    .map(|result| CompactSearchResult { title: &result.title, url: &result.url, snippet: &result.snippet })
    .collect();
  serde_json::to_string(&CompactWebSearchResponse { query, results })
    .map_err(|e| format!("Could not serialize web search response: {}", e).into())
}

/// Search using budget-aware provider selection and bounded fallback.
pub async fn search(query: &str, max_results: usize) -> InfuResult<Vec<SearchResult>> {
  let query = query.trim();
  if query.is_empty() {
    return Err("search query cannot be empty".into());
  }
  let request = SearchRequest { query, max_results: max_results.clamp(1, MAX_RESULTS_CAP) };
  configured_router()?.search(request).await.map_err(|error| error.to_string().into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn unwraps_ddg_redirect_href() {
    let html = r#"<html><body>
      <div class="web-result">
        <h2><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Title</a></h2>
        <a class="result__snippet">A snippet.</a>
      </div>
    </body></html>"#;
    let results = parse_results(html, 5).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "Example Title");
    assert_eq!(results[0].url, "https://example.com/page");
    assert_eq!(results[0].snippet, "A snippet.");
  }

  #[test]
  fn skips_ad_results() {
    let html = r#"<html><body>
      <div class="web-result result--ad">
        <h2><a class="result__a" href="https://ads.example/">Ad</a></h2>
      </div>
      <div class="web-result">
        <h2><a class="result__a" href="https://example.com/real">Real</a></h2>
      </div>
    </body></html>"#;
    let results = parse_results(html, 5).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].url, "https://example.com/real");
  }

  #[test]
  fn drops_yjs_ad_redirects() {
    assert_eq!(unwrap_ddg_href("https://duckduckgo.com/y.js?ad=1"), None);
  }
}
