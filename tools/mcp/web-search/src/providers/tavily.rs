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

use std::collections::HashSet;
use std::time::Duration;

use futures_util::future::BoxFuture;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderValue, RETRY_AFTER};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::json;

use super::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResponse,
  SearchResult, SearchResultMetadata,
};

const SEARCH_URL: &str = "https://api.tavily.com/search";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
// https://docs.tavily.com/documentation/api-reference/endpoint/search
const MAX_RESULTS: usize = 20;
const MAX_SNIPPET_CHARS: usize = 1000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

// Basic search costs one API credit. Normalize credits at the pay-as-you-go
// rate of $0.008 per credit so the shared monetary ledger can track capacity.
// Verified 2026-10-17: https://docs.tavily.com/documentation/api-credits
const CREDIT_COST_USD_MICROS: u64 = 8000;

/// One basic search per call, without retries or automatic depth upgrades.
/// The budget wrapper must reserve capacity before dispatch. Account usage
/// polling is not implemented; request usage is read from search responses.
pub struct Tavily {
  client: Client,
  api_key: HeaderValue,
}

impl Tavily {
  pub fn new(api_key: &str) -> ProviderResult<Self> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
      return Err(ProviderError::new(ProviderErrorKind::InvalidCredentials, "TAVILY_API_KEY must not be empty."));
    }
    let mut api_key = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
      ProviderError::new(ProviderErrorKind::InvalidCredentials, "TAVILY_API_KEY is not a valid HTTP header value.")
    })?;
    api_key.set_sensitive(true);
    let client = Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .timeout(SEARCH_TIMEOUT)
      .build()
      .map_err(|_| ProviderError::new(ProviderErrorKind::Internal, "Could not build Tavily HTTP client."))?;
    Ok(Self { client, api_key })
  }
}

impl SearchProvider for Tavily {
  fn name(&self) -> &'static str {
    "tavily"
  }

  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost> {
    result_limit(request)?;
    Ok(RequestCost::UsdMicros(CREDIT_COST_USD_MICROS))
  }

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<SearchResponse>> {
    Box::pin(async move {
      let num_results = result_limit(&request)?;
      let mut response = self
        .client
        .post(SEARCH_URL)
        .header(AUTHORIZATION, self.api_key.clone())
        .header(ACCEPT, "application/json")
        .json(&json!({
          "query": request.query.trim(),
          "search_depth": "basic",
          "auto_parameters": false,
          "topic": "general",
          "max_results": num_results,
          "include_answer": false,
          "include_raw_content": false,
          "include_images": false,
          "include_usage": true
        }))
        .send()
        .await
        .map_err(|error| {
          let message =
            if error.is_timeout() { "Tavily search request timed out." } else { "Tavily search request failed." };
          // Do not expose request headers or provider response bodies in errors.
          ProviderError::new(ProviderErrorKind::Transient, message)
        })?;

      let status = response.status();
      if !status.is_success() {
        let retry_after = response
          .headers()
          .get(RETRY_AFTER)
          .and_then(|value| value.to_str().ok())
          .and_then(|value| value.trim().parse::<u64>().ok())
          .map(Duration::from_secs);
        let kind = match status.as_u16() {
          400 | 413 | 414 | 422 => ProviderErrorKind::InvalidRequest,
          401 => ProviderErrorKind::InvalidCredentials,
          402 | 432 | 433 => ProviderErrorKind::QuotaExhausted,
          403 => ProviderErrorKind::Blocked,
          429 => ProviderErrorKind::RateLimited,
          408 | 500..=599 => ProviderErrorKind::Transient,
          _ => ProviderErrorKind::UnexpectedResponse,
        };
        // Keep the reservation when billing is uncertain. Never expose response
        // bodies, which can contain query text or authentication diagnostics.
        return Err(
          ProviderError::new(kind, format!("Tavily search returned HTTP {status}.")).with_retry_after(retry_after),
        );
      }

      let mut body = Vec::new();
      while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProviderError::new(ProviderErrorKind::Transient, "Could not read Tavily search response."))?
      {
        if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
          return Err(ProviderError::new(
            ProviderErrorKind::UnexpectedResponse,
            "Tavily search response exceeded the size limit.",
          ));
        }
        body.extend_from_slice(&chunk);
      }
      let response: TavilySearchResponse = serde_json::from_slice(&body).map_err(|_| {
        ProviderError::new(ProviderErrorKind::UnexpectedResponse, "Tavily search returned an invalid response.")
      })?;
      Ok(SearchResponse {
        reported_cost_usd_micros: reported_cost(&response.usage),
        results: normalize_results(response.results, num_results),
      })
    })
  }
}

fn result_limit(request: &SearchRequest<'_>) -> ProviderResult<usize> {
  if request.query.trim().is_empty() || request.max_results == 0 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "Tavily search requires a query and a positive result limit.",
    ));
  }
  Ok(request.max_results.min(MAX_RESULTS))
}

#[derive(Deserialize)]
struct TavilySearchResponse {
  results: Vec<TavilySearchResult>,
  // Invalid optional cost metadata must not discard otherwise usable results.
  #[serde(default)]
  usage: serde_json::Value,
}

fn reported_cost(usage: &serde_json::Value) -> Option<u64> {
  usage.get("credits")?.as_u64()?.checked_mul(CREDIT_COST_USD_MICROS)
}

#[derive(Deserialize)]
struct TavilySearchResult {
  title: Option<String>,
  url: String,
  content: Option<String>,
  published_date: Option<String>,
}

fn normalize_results(results: Vec<TavilySearchResult>, max_results: usize) -> Vec<SearchResult> {
  let mut seen_urls = HashSet::new();
  results
    .into_iter()
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
      let snippet = result.content.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
      let snippet: String = snippet.chars().take(MAX_SNIPPET_CHARS).collect();
      Some(SearchResult {
        title,
        url,
        snippet,
        metadata: Some(SearchResultMetadata {
          published_date: result.published_date,
          author: None,
          excerpts: Vec::new(),
        }),
      })
    })
    .take(max_results)
    .collect()
}
