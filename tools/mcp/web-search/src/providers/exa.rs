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
use reqwest::header::{ACCEPT, HeaderValue, RETRY_AFTER};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::json;

use super::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResponse,
  SearchResult, SearchResultMetadata,
};

const SEARCH_URL: &str = "https://api.exa.ai/search";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
// Keep requests within the non-enterprise limit documented on the pricing page.
const MAX_RESULTS: usize = 25;
const HIGHLIGHT_MAX_CHARS: usize = 1000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

// Instant search with bundled highlights: $0.004 through ten results, then
// $0.001 per additional result. Verified 2026-10-14:
// https://exa.ai/docs/admin/pricing
const BASE_COST_USD_MICROS: u64 = 4000;
const INCLUDED_RESULTS: usize = 10;
const EXTRA_RESULT_COST_USD_MICROS: u64 = 1000;

/// Construction validates credentials locally and builds a reusable client.
/// This adapter performs no retries. The search layer must enforce budgets
/// before selecting it. Regular search keys cannot query the admin usage API.
pub struct Exa {
  client: Client,
  api_key: HeaderValue,
}

impl Exa {
  pub fn new(api_key: &str) -> ProviderResult<Self> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
      return Err(ProviderError::new(ProviderErrorKind::InvalidCredentials, "EXA_API_KEY must not be empty."));
    }
    let mut api_key = HeaderValue::from_str(api_key).map_err(|_| {
      ProviderError::new(ProviderErrorKind::InvalidCredentials, "EXA_API_KEY is not a valid HTTP header value.")
    })?;
    api_key.set_sensitive(true);
    let client = Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .timeout(SEARCH_TIMEOUT)
      .build()
      .map_err(|_| ProviderError::new(ProviderErrorKind::Internal, "Could not build Exa HTTP client."))?;
    Ok(Self { client, api_key })
  }
}

impl SearchProvider for Exa {
  fn name(&self) -> &'static str {
    "exa"
  }

  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost> {
    let num_results = result_limit(request)?;
    let extra_results = num_results.saturating_sub(INCLUDED_RESULTS) as u64;
    Ok(RequestCost::UsdMicros(BASE_COST_USD_MICROS + extra_results * EXTRA_RESULT_COST_USD_MICROS))
  }

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<SearchResponse>> {
    Box::pin(async move {
      let num_results = result_limit(&request)?;
      let mut response = self
        .client
        .post(SEARCH_URL)
        .header("x-api-key", self.api_key.clone())
        .header(ACCEPT, "application/json")
        .json(&json!({
          "query": request.query.trim(),
          "type": "instant",
          "numResults": num_results,
          "contents": {
            "text": false,
            "highlights": { "maxCharacters": HIGHLIGHT_MAX_CHARS },
            "summary": null,
            "extras": null,
            "subpages": 0,
            "maxAgeHours": -1
          }
        }))
        .send()
        .await
        .map_err(|error| {
          let message = if error.is_timeout() { "Exa search request timed out." } else { "Exa search request failed." };
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
          402 => ProviderErrorKind::QuotaExhausted,
          403 => ProviderErrorKind::Blocked,
          429 => ProviderErrorKind::RateLimited,
          408 | 500..=599 => ProviderErrorKind::Transient,
          _ => ProviderErrorKind::UnexpectedResponse,
        };
        let error =
          ProviderError::new(kind, format!("Exa search returned HTTP {status}.")).with_retry_after(retry_after);
        // Exa explicitly documents HTTP 503 as not processed and not billed:
        // https://exa.ai/docs/admin/error-codes
        return Err(if status.as_u16() == 503 { error.without_charge() } else { error });
      }

      let mut body = Vec::new();
      while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProviderError::new(ProviderErrorKind::Transient, "Could not read Exa search response."))?
      {
        if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
          return Err(ProviderError::new(
            ProviderErrorKind::UnexpectedResponse,
            "Exa search response exceeded the size limit.",
          ));
        }
        body.extend_from_slice(&chunk);
      }
      let response: ExaSearchResponse = serde_json::from_slice(&body).map_err(|_| {
        ProviderError::new(ProviderErrorKind::UnexpectedResponse, "Exa search returned an invalid response.")
      })?;
      Ok(SearchResponse {
        reported_cost_usd_micros: reported_cost(&response.cost_dollars),
        results: normalize_results(response.results, num_results),
      })
    })
  }
}

fn result_limit(request: &SearchRequest<'_>) -> ProviderResult<usize> {
  if request.query.trim().is_empty() || request.max_results == 0 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "Exa search requires a query and a positive result limit.",
    ));
  }
  Ok(request.max_results.min(MAX_RESULTS))
}

#[derive(Deserialize)]
struct ExaSearchResponse {
  results: Vec<ExaSearchResult>,
  // Invalid optional cost metadata must not discard otherwise usable results.
  #[serde(default, rename = "costDollars")]
  cost_dollars: serde_json::Value,
}

fn reported_cost(cost_dollars: &serde_json::Value) -> Option<u64> {
  let dollars = cost_dollars.get("total")?.as_f64()?;
  let micros = (dollars * 1_000_000.0).round();
  // Reject negative, non-finite and out-of-range values before the integer cast.
  // u64::MAX rounds up to 2^64 as f64, so the upper bound is exclusive.
  if dollars < 0.0 || !micros.is_finite() || micros >= u64::MAX as f64 {
    return None;
  }
  Some(micros as u64)
}

#[derive(Deserialize)]
struct ExaSearchResult {
  title: Option<String>,
  url: String,
  highlights: Option<Vec<String>>,
  #[serde(rename = "publishedDate")]
  published_date: Option<String>,
  author: Option<String>,
}

fn normalize_results(results: Vec<ExaSearchResult>, max_results: usize) -> Vec<SearchResult> {
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
      let excerpts = result.highlights.unwrap_or_default();
      let snippet = excerpts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
      let snippet = snippet.chars().take(HIGHLIGHT_MAX_CHARS).collect();
      Some(SearchResult {
        title,
        url,
        snippet,
        metadata: Some(SearchResultMetadata { published_date: result.published_date, author: result.author, excerpts }),
      })
    })
    .take(max_results)
    .collect()
}
