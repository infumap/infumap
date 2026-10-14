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

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::config;
use crate::error::InfuResult;
pub use crate::providers::SearchResult;
use crate::providers::duckduckgo::DuckDuckGo;
use crate::providers::exa::Exa;
use crate::providers::{SearchProvider, SearchRequest};

#[cfg(test)]
use crate::providers::duckduckgo::{parse_results, unwrap_ddg_href};

pub const DEFAULT_MAX_RESULTS: usize = 5;
pub const MAX_RESULTS_CAP: usize = 30;

struct ConfiguredProviders {
  duckduckgo: Option<DuckDuckGo>,
  exa: Option<Exa>,
}

static PROVIDERS: Lazy<InfuResult<ConfiguredProviders>> = Lazy::new(|| {
  let config = config::search_config().map_err(|message| format!("Invalid web-search configuration: {message}"))?;
  let exa = config
    .exa
    .as_ref()
    .map(|config| Exa::new(&config.api_key))
    .transpose()
    .map_err(|error| format!("Could not initialize Exa: {error}"))?;
  Ok(ConfiguredProviders { duckduckgo: config.duckduckgo_enabled.then_some(DuckDuckGo), exa })
});

/// Prepare configured clients and validate credentials locally, without issuing
/// any provider requests. Exa execution remains gated on budget accounting.
pub fn initialize_providers() -> InfuResult<()> {
  configured_providers().map(|_| ())
}

fn configured_providers() -> InfuResult<&'static ConfiguredProviders> {
  PROVIDERS.as_ref().map_err(|error| error.to_string().into())
}

#[derive(Serialize)]
struct CompactWebSearchResponse<'a> {
  query: &'a str,
  results: &'a [SearchResult],
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
  serde_json::to_string(&CompactWebSearchResponse { query, results })
    .map_err(|e| format!("Could not serialize web search response: {}", e).into())
}

/// Dispatch to an available adapter. Budget-aware routing is added separately.
pub async fn search(query: &str, max_results: usize) -> InfuResult<Vec<SearchResult>> {
  let query = query.trim();
  if query.is_empty() {
    return Err("search query cannot be empty".into());
  }
  let request = SearchRequest { query, max_results: max_results.clamp(1, MAX_RESULTS_CAP) };
  configured_provider()?.search(request).await.map_err(|error| error.to_string().into())
}

fn configured_provider() -> InfuResult<&'static dyn SearchProvider> {
  let providers = configured_providers()?;
  if let Some(duckduckgo) = &providers.duckduckgo {
    return Ok(duckduckgo);
  }
  Err(if providers.exa.is_some() {
    "Exa is configured, but searches remain disabled until persistent budget accounting is implemented. Set WEB_SEARCH_DUCKDUCKGO_ENABLED=true to enable DuckDuckGo search."
  } else {
    "No search providers enabled. Set WEB_SEARCH_DUCKDUCKGO_ENABLED=true to enable DuckDuckGo search."
  }
  .into())
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
