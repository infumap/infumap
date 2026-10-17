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
use std::num::NonZeroU32;
use std::time::Duration;

use futures_util::future::BoxFuture;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderValue, RETRY_AFTER};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::json;

use super::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResponse,
  SearchResult,
};

const SEARCH_URL: &str = "https://api.firecrawl.dev/v2/search";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
// https://docs.firecrawl.dev/api-reference/endpoint/search
const MAX_RESULTS: usize = 100;
const MAX_QUERY_LENGTH: usize = 500;
const MAX_SNIPPET_CHARS: usize = 1000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

// Search without scraping costs two credits per ten results, rounded up.
// Normalize credits at the Hobby top-up rate of $5/1,000 credits. This is a
// fixed ledger conversion, not this account's actual billed rate.
// Verified 2026-10-17: https://docs.firecrawl.dev/billing
const CREDIT_COST_USD_MICROS: u64 = 5000;

/// One authenticated web search per call. No scraping, retries, keyless access,
/// enterprise options or extra sources. The router and budget wrapper enforce
/// pacing and durable monthly reservations before dispatch.
pub struct Firecrawl {
  client: Client,
  api_key: HeaderValue,
  requests_per_minute: NonZeroU32,
}

impl Firecrawl {
  pub fn new(api_key: &str, requests_per_minute: NonZeroU32) -> ProviderResult<Self> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
      return Err(ProviderError::new(ProviderErrorKind::InvalidCredentials, "FIRECRAWL_API_KEY must not be empty."));
    }
    let mut api_key = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
      ProviderError::new(ProviderErrorKind::InvalidCredentials, "FIRECRAWL_API_KEY is not a valid HTTP header value.")
    })?;
    api_key.set_sensitive(true);
    let client = Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .timeout(SEARCH_TIMEOUT)
      .build()
      .map_err(|_| ProviderError::new(ProviderErrorKind::Internal, "Could not build Firecrawl HTTP client."))?;
    Ok(Self { client, api_key, requests_per_minute })
  }
}

impl SearchProvider for Firecrawl {
  fn name(&self) -> &'static str {
    "firecrawl"
  }

  fn requests_per_minute(&self) -> Option<NonZeroU32> {
    Some(self.requests_per_minute)
  }

  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost> {
    let credits = result_limit(request)?.div_ceil(10) as u64 * 2;
    Ok(RequestCost::UsdMicros(credits * CREDIT_COST_USD_MICROS))
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
          "limit": num_results,
          "sources": ["web"],
          "domainTools": false,
          "highlights": false,
          "enterprise": [],
          "timeout": 20000
        }))
        .send()
        .await
        .map_err(|error| {
          let message =
            if error.is_timeout() { "Firecrawl search request timed out." } else { "Firecrawl search request failed." };
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
        // Keep the estimate when billing is uncertain. Error bodies can contain
        // query text or authentication diagnostics and must never be exposed.
        return Err(
          ProviderError::new(kind, format!("Firecrawl search returned HTTP {status}.")).with_retry_after(retry_after),
        );
      }

      let mut body = Vec::new();
      while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProviderError::new(ProviderErrorKind::Transient, "Could not read Firecrawl search response."))?
      {
        if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
          return Err(ProviderError::new(
            ProviderErrorKind::UnexpectedResponse,
            "Firecrawl search response exceeded the size limit.",
          ));
        }
        body.extend_from_slice(&chunk);
      }
      let response: FirecrawlSearchResponse = serde_json::from_slice(&body).map_err(|_| {
        ProviderError::new(ProviderErrorKind::UnexpectedResponse, "Firecrawl search returned an invalid response.")
      })?;
      if !response.success {
        return Err(ProviderError::new(
          ProviderErrorKind::UnexpectedResponse,
          "Firecrawl search reported an unsuccessful response.",
        ));
      }
      let data = response.data.ok_or_else(|| {
        ProviderError::new(ProviderErrorKind::UnexpectedResponse, "Firecrawl search response omitted web results.")
      })?;
      Ok(SearchResponse {
        reported_cost_usd_micros: response
          .credits_used
          .as_u64()
          .and_then(|credits| credits.checked_mul(CREDIT_COST_USD_MICROS)),
        results: normalize_results(data.web, num_results),
      })
    })
  }
}

fn result_limit(request: &SearchRequest<'_>) -> ProviderResult<usize> {
  let query = request.query.trim();
  if query.is_empty() || request.max_results == 0 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "Firecrawl search requires a query and a positive result limit.",
    ));
  }
  // Match the string-length limit of the JavaScript API, including surrogate
  // pairs, without truncating or changing the caller's query.
  if query.encode_utf16().count() > MAX_QUERY_LENGTH {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "Firecrawl search queries must not exceed 500 UTF-16 code units.",
    ));
  }
  Ok(request.max_results.min(MAX_RESULTS))
}

#[derive(Deserialize)]
struct FirecrawlSearchResponse {
  success: bool,
  data: Option<FirecrawlSearchData>,
  // Invalid optional cost metadata must not discard otherwise usable results.
  #[serde(default, rename = "creditsUsed")]
  credits_used: serde_json::Value,
}

#[derive(Deserialize)]
struct FirecrawlSearchData {
  web: Vec<FirecrawlSearchResult>,
}

#[derive(Deserialize)]
struct FirecrawlSearchResult {
  title: Option<String>,
  url: String,
  description: Option<String>,
}

fn normalize_results(results: Vec<FirecrawlSearchResult>, max_results: usize) -> Vec<SearchResult> {
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
      let snippet = result.description.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
      let snippet: String = snippet.chars().take(MAX_SNIPPET_CHARS).collect();
      Some(SearchResult { title, url, snippet, metadata: None })
    })
    .take(max_results)
    .collect()
}
