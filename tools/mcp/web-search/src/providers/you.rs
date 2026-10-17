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

mod mcp;

use std::collections::HashSet;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::Instant;

use super::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResponse,
  SearchResult, SearchResultMetadata,
};
use crate::daily_quota::{DailyQuota, DailyQuotaSnapshot};

const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESULTS: usize = 100;
const MAX_SNIPPET_CHARS: usize = 1000;

/// Keyless You.com MCP free profile only. No API keys, account credits, wallet
/// payments, discovery tools, extraction or research requests are dispatched.
pub struct You {
  client: Client,
  quota: Arc<DailyQuota>,
  requests_per_minute: NonZeroU32,
}

impl You {
  pub fn new(directory: &Path, allowance: u32, requests_per_minute: NonZeroU32) -> ProviderResult<Self> {
    let client = Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .user_agent(concat!("infumap-web-search/", env!("CARGO_PKG_VERSION")))
      .connect_timeout(Duration::from_secs(10))
      .timeout(SEARCH_TIMEOUT)
      .build()
      .map_err(|_| ProviderError::new(ProviderErrorKind::Internal, "Could not build You.com MCP HTTP client."))?;
    Ok(Self { client, quota: DailyQuota::open(directory, allowance)?, requests_per_minute })
  }

  async fn search_until(&self, request: SearchRequest<'_>, deadline: Instant) -> ProviderResult<SearchResponse> {
    let max_results = result_limit(&request)?;
    let mut session = mcp::Session::new(self.client.clone());
    session.initialize().await?;
    // Initialization does not consume a search allowance. Durably charge just
    // before tools/call; late persistence must never dispatch a search.
    self.quota.charge(deadline).await?;
    let result = session
      .call(json!({
        "query": request.query.trim(),
        "count": max_results,
        "extraction": "none"
      }))
      .await?;
    if result.get("isError").is_some_and(|value| value != &Value::Bool(false)) {
      return Err(mcp::tool_error(&result));
    }
    let payload = match result.get("structuredContent").filter(|value| !value.is_null()) {
      Some(payload) => payload.clone(),
      None => {
        // The current server mirrors structured JSON in text for MCP clients
        // without structured output support. Do not scrape prose for results.
        let content = result.get("content").and_then(Value::as_array).ok_or_else(invalid_response)?;
        let texts: Vec<&str> = content
          .iter()
          .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
          .filter_map(|item| item.get("text").and_then(Value::as_str))
          .collect();
        serde_json::from_str(&texts.join("\n")).map_err(|_| invalid_response())?
      }
    };
    let payload: SearchPayload = serde_json::from_value(payload).map_err(|_| invalid_response())?;
    let results = normalize_results(payload.results.web.into_iter().chain(payload.results.news), max_results);
    Ok(SearchResponse { results, reported_cost_usd_micros: None })
  }
}

impl SearchProvider for You {
  fn name(&self) -> &'static str {
    "you"
  }

  fn requests_per_minute(&self) -> Option<NonZeroU32> {
    Some(self.requests_per_minute)
  }

  fn daily_quota(&self) -> BoxFuture<'_, ProviderResult<Option<DailyQuotaSnapshot>>> {
    Box::pin(async { self.quota.snapshot().await.map(Some) })
  }

  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost> {
    result_limit(request)?;
    // No monetary cost. The finite request allowance is inspected separately
    // by the router and enforced durably inside this adapter before dispatch.
    Ok(RequestCost::Unmetered)
  }

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<SearchResponse>> {
    Box::pin(async move {
      let deadline = Instant::now() + SEARCH_TIMEOUT;
      let operation = async {
        let result = self.search_until(request, deadline).await;
        if let Err(mut error) = result {
          if error.kind == ProviderErrorKind::QuotaExhausted {
            let delay = error.retry_after.unwrap_or_default().max(Duration::from_secs(24 * 60 * 60));
            self.quota.exhaust(delay).await?;
            // This provider has no monthly period. Its own durable rolling
            // suspension controls recovery; don't disable it until restart.
            error.kind = ProviderErrorKind::RateLimited;
            error.retry_after = Some(delay);
          }
          return Err(error);
        }
        result
      };
      tokio::time::timeout_at(deadline, operation).await.unwrap_or_else(|_| {
        Err(ProviderError::new(ProviderErrorKind::Transient, "You.com search exceeded its 20-second deadline."))
      })
    })
  }
}

fn result_limit(request: &SearchRequest<'_>) -> ProviderResult<usize> {
  let query = request.query.trim();
  if query.is_empty() || request.max_results == 0 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "You.com search requires a query and a positive result limit.",
    ));
  }
  // The hosted tool documents short, single-intent queries. Reject instead of
  // silently changing a query or dispatching multiple searches against quota.
  if query.encode_utf16().count() > 400 || query.split_whitespace().count() > 50 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "You.com queries must fit 400 UTF-16 code units and 50 words.",
    ));
  }
  Ok(request.max_results.min(MAX_RESULTS))
}

#[derive(Deserialize)]
struct SearchPayload {
  results: SearchResults,
}

#[derive(Deserialize)]
struct SearchResults {
  web: Vec<YouResult>,
  #[serde(default)]
  news: Vec<YouResult>,
}

#[derive(Deserialize)]
struct YouResult {
  url: String,
  title: Option<String>,
  description: Option<String>,
  snippets: Option<Vec<String>>,
  page_age: Option<String>,
}

fn normalize_results(results: impl Iterator<Item = YouResult>, limit: usize) -> Vec<SearchResult> {
  let mut seen_urls = HashSet::new();
  results
    .filter_map(|result| {
      let url = Url::parse(result.url.trim()).ok()?;
      if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
      }
      let url = url.to_string();
      if !seen_urls.insert(url.clone()) {
        return None;
      }
      let title = result.title.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
      let title = if title.is_empty() { url.clone() } else { title };
      let excerpts: Vec<String> =
        result.snippets.unwrap_or_default().into_iter().filter(|snippet| !snippet.trim().is_empty()).collect();
      let text = if excerpts.is_empty() { result.description.unwrap_or_default() } else { excerpts.join(" ") };
      let snippet = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_SNIPPET_CHARS).collect();
      Some(SearchResult {
        title,
        url,
        snippet,
        metadata: Some(SearchResultMetadata { published_date: result.page_age, author: None, excerpts }),
      })
    })
    .take(limit)
    .collect()
}

fn invalid_response() -> ProviderError {
  ProviderError::new(ProviderErrorKind::UnexpectedResponse, "You.com search returned an invalid result payload.")
}
