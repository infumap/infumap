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
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, RETRY_AFTER};
use reqwest::{Client, Url};
use serde::Deserialize;

use super::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResponse,
  SearchResult, SearchResultMetadata,
};

const SEARCH_URL: &str = "https://api.search.brave.com/res/v1/web/search";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RESULTS: usize = 20;
const MAX_SNIPPET_CHARS: usize = 1000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
// Web search: $5 per 1,000 requests, independent of result count. Verified
// 2026-10-17: https://api-dashboard.search.brave.com/documentation/pricing
// Free credits are configured per account, never assumed by the adapter.
const REQUEST_COST_USD_MICROS: u64 = 5000;

/// One API request per search, with no retries or pagination. The shared budget
/// wrapper must reserve credits before dispatch. Rate-limit headers describe
/// request windows, not a known monetary account balance.
pub struct Brave {
  client: Client,
  api_key: HeaderValue,
}

impl Brave {
  pub fn new(api_key: &str) -> ProviderResult<Self> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
      return Err(ProviderError::new(ProviderErrorKind::InvalidCredentials, "BRAVE_API_KEY must not be empty."));
    }
    let mut api_key = HeaderValue::from_str(api_key).map_err(|_| {
      ProviderError::new(ProviderErrorKind::InvalidCredentials, "BRAVE_API_KEY is not a valid HTTP header value.")
    })?;
    api_key.set_sensitive(true);
    let client = Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .timeout(SEARCH_TIMEOUT)
      .build()
      .map_err(|_| ProviderError::new(ProviderErrorKind::Internal, "Could not build Brave HTTP client."))?;
    Ok(Self { client, api_key })
  }
}

impl SearchProvider for Brave {
  fn name(&self) -> &'static str {
    "brave"
  }

  fn estimate_cost(&self, request: &SearchRequest<'_>) -> ProviderResult<RequestCost> {
    result_limit(request)?;
    Ok(RequestCost::UsdMicros(REQUEST_COST_USD_MICROS))
  }

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<SearchResponse>> {
    Box::pin(async move {
      let num_results = result_limit(&request)?;
      let mut response = self
        .client
        .get(SEARCH_URL)
        .header("x-subscription-token", self.api_key.clone())
        .header(ACCEPT, "application/json")
        .query(&[
          ("q", request.query.trim().to_owned()),
          ("count", num_results.to_string()),
          ("result_filter", "web".to_owned()),
          ("text_decorations", "false".to_owned()),
        ])
        .send()
        .await
        .map_err(|error| {
          let message =
            if error.is_timeout() { "Brave search request timed out." } else { "Brave search request failed." };
          // reqwest errors can include the query URL. Never expose it or keys.
          ProviderError::new(ProviderErrorKind::Transient, message)
        })?;

      let status = response.status();
      let retry_after = retry_after(response.headers());
      if !status.is_success() {
        let mut kind = match status.as_u16() {
          400 | 413 | 414 | 422 => ProviderErrorKind::InvalidRequest,
          401 => ProviderErrorKind::InvalidCredentials,
          402 => ProviderErrorKind::QuotaExhausted,
          403 => ProviderErrorKind::Blocked,
          429 => ProviderErrorKind::RateLimited,
          408 | 500..=599 => ProviderErrorKind::Transient,
          _ => ProviderErrorKind::UnexpectedResponse,
        };
        if status.as_u16() == 429 {
          // Brave uses HTTP 429 for both temporary throttling and exhausted
          // monthly quota. Only the documented machine code distinguishes them.
          // A missing/malformed body retains the conservative rate-limit path.
          if let Ok(body) = read_body(&mut response).await
            && let Ok(error) = serde_json::from_slice::<BraveErrorResponse>(&body)
            && error.error.code == "QUOTA_LIMITED"
          {
            kind = ProviderErrorKind::QuotaExhausted;
          }
        }
        // Brave documents non-error responses as the only billed requests:
        // https://api-dashboard.search.brave.com/documentation/guides/rate-limiting
        return Err(
          ProviderError::new(kind, format!("Brave search returned HTTP {status}."))
            .with_retry_after(retry_after)
            .without_charge(),
        );
      }

      let body = read_body(&mut response).await?;
      let response: BraveSearchResponse = serde_json::from_slice(&body).map_err(|_| {
        ProviderError::new(ProviderErrorKind::UnexpectedResponse, "Brave search returned an invalid response.")
      })?;
      if response.response_type != "search" {
        return Err(ProviderError::new(
          ProviderErrorKind::UnexpectedResponse,
          "Brave search returned an unexpected response type.",
        ));
      }
      Ok(SearchResponse {
        reported_cost_usd_micros: None,
        results: normalize_results(response.web.map_or_else(Vec::new, |web| web.results), num_results),
      })
    })
  }
}

fn result_limit(request: &SearchRequest<'_>) -> ProviderResult<usize> {
  let query = request.query.trim();
  if query.is_empty() || request.max_results == 0 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "Brave search requires a query and a positive result limit.",
    ));
  }
  // https://api-dashboard.search.brave.com/api-reference/web/search/get
  if query.chars().count() > 600 || query.split_whitespace().count() > 75 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "Brave search queries must not exceed 600 characters or 75 words.",
    ));
  }
  Ok(request.max_results.min(MAX_RESULTS))
}

fn retry_after(headers: &HeaderMap) -> Option<Duration> {
  if let Some(seconds) =
    headers.get(RETRY_AFTER).and_then(|value| value.to_str().ok()).and_then(|value| value.trim().parse::<u64>().ok())
  {
    return Some(Duration::from_secs(seconds));
  }
  // Brave's comma-separated windows report remaining requests and reset delays
  // in matching order. Only depleted windows should extend the cooldown.
  let remaining = headers.get("x-ratelimit-remaining")?.to_str().ok()?;
  let resets = headers.get("x-ratelimit-reset")?.to_str().ok()?;
  let remaining = remaining.split(',').map(|value| value.trim().parse::<u64>()).collect::<Result<Vec<_>, _>>().ok()?;
  let resets = resets.split(',').map(|value| value.trim().parse::<u64>()).collect::<Result<Vec<_>, _>>().ok()?;
  if remaining.len() != resets.len() {
    return None;
  }
  remaining
    .into_iter()
    .zip(resets)
    .filter_map(|(remaining, reset)| (remaining == 0).then_some(reset))
    .max()
    .map(Duration::from_secs)
}

async fn read_body(response: &mut reqwest::Response) -> ProviderResult<Vec<u8>> {
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|_| ProviderError::new(ProviderErrorKind::Transient, "Could not read Brave search response."))?
  {
    if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
      return Err(ProviderError::new(
        ProviderErrorKind::UnexpectedResponse,
        "Brave search response exceeded the size limit.",
      ));
    }
    body.extend_from_slice(&chunk);
  }
  Ok(body)
}

#[derive(Deserialize)]
struct BraveErrorResponse {
  error: BraveError,
}

#[derive(Deserialize)]
struct BraveError {
  code: String,
}

#[derive(Deserialize)]
struct BraveSearchResponse {
  #[serde(rename = "type")]
  response_type: String,
  web: Option<BraveWebResults>,
}

#[derive(Deserialize)]
struct BraveWebResults {
  results: Vec<BraveSearchResult>,
}

#[derive(Deserialize)]
struct BraveSearchResult {
  title: Option<String>,
  url: String,
  description: Option<String>,
  page_age: Option<String>,
}

fn normalize_results(results: Vec<BraveSearchResult>, max_results: usize) -> Vec<SearchResult> {
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
      Some(SearchResult {
        title,
        url,
        metadata: Some(SearchResultMetadata {
          published_date: result.page_age,
          author: None,
          excerpts: if snippet.is_empty() { Vec::new() } else { vec![snippet.clone()] },
        }),
        snippet,
      })
    })
    .take(max_results)
    .collect()
}
