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
use reqwest::{Client, Response, Url};
use serde::Deserialize;
use serde_json::json;

use super::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResponse,
  SearchResult, SearchResultMetadata,
};

const SEARCH_URL: &str = "https://llm.diffbot.com/api/v1/web_search";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
// Local cap matching the tool's result limit; Diffbot documents no size maximum.
const MAX_RESULTS: usize = 30;
const MAX_SNIPPET_CHARS: usize = 1000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

// One single-query search costs one credit. Normalize credits at the published
// Startup overage rate of $0.001/credit for the shared ledger, not as a claim
// about this account's actual price. Verified 2026-10-17:
// https://www.diffbot.com/pricing
const CREDIT_COST_USD_MICROS: u64 = 1000;

/// One web-index search per call, without retries, extraction or DQL queries.
/// The router enforces pacing and the budget wrapper reserves monthly capacity.
pub struct Diffbot {
  client: Client,
  api_key: HeaderValue,
  requests_per_minute: NonZeroU32,
}

impl Diffbot {
  pub fn new(api_key: &str, requests_per_minute: NonZeroU32) -> ProviderResult<Self> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
      return Err(ProviderError::new(ProviderErrorKind::InvalidCredentials, "DIFFBOT_API_KEY must not be empty."));
    }
    let mut api_key = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
      ProviderError::new(ProviderErrorKind::InvalidCredentials, "DIFFBOT_API_KEY is not a valid HTTP header value.")
    })?;
    api_key.set_sensitive(true);
    let client = Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .timeout(SEARCH_TIMEOUT)
      .build()
      .map_err(|_| ProviderError::new(ProviderErrorKind::Internal, "Could not build Diffbot HTTP client."))?;
    Ok(Self { client, api_key, requests_per_minute })
  }
}

impl SearchProvider for Diffbot {
  fn name(&self) -> &'static str {
    "diffbot"
  }

  fn requests_per_minute(&self) -> Option<NonZeroU32> {
    Some(self.requests_per_minute)
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
          "text": [request.query.trim()],
          "size": num_results,
          "maxTokens": num_results * 256
        }))
        .send()
        .await
        .map_err(|error| {
          let message =
            if error.is_timeout() { "Diffbot search request timed out." } else { "Diffbot search request failed." };
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
          429 => {
            // Diffbot uses 429 for both quota exhaustion and throttling. Only
            // an explicit quota message may persist a cap until monthly reset.
            let quota_exceeded = read_body(&mut response)
              .await
              .ok()
              .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
              .and_then(|body| {
                body.get("message")?.as_str().map(|message| message.trim().eq_ignore_ascii_case("quota exceeded"))
              })
              .unwrap_or(false);
            if quota_exceeded { ProviderErrorKind::QuotaExhausted } else { ProviderErrorKind::RateLimited }
          }
          408 | 500..=599 => ProviderErrorKind::Transient,
          _ => ProviderErrorKind::UnexpectedResponse,
        };
        // Billing is uncertain for failures. Never expose response bodies,
        // request URLs or credentials; the budget wrapper retains the estimate.
        return Err(
          ProviderError::new(kind, format!("Diffbot search returned HTTP {status}.")).with_retry_after(retry_after),
        );
      }

      let body = read_body(&mut response).await?;
      let response: DiffbotSearchResponse = serde_json::from_slice(&body).map_err(|_| {
        ProviderError::new(ProviderErrorKind::UnexpectedResponse, "Diffbot search returned an invalid response.")
      })?;
      Ok(SearchResponse {
        reported_cost_usd_micros: None,
        results: normalize_results(response.search_results, num_results),
      })
    })
  }
}

async fn read_body(response: &mut Response) -> ProviderResult<Vec<u8>> {
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|_| ProviderError::new(ProviderErrorKind::Transient, "Could not read Diffbot search response."))?
  {
    if chunk.len() > MAX_RESPONSE_BYTES - body.len() {
      return Err(ProviderError::new(
        ProviderErrorKind::UnexpectedResponse,
        "Diffbot search response exceeded the size limit.",
      ));
    }
    body.extend_from_slice(&chunk);
  }
  Ok(body)
}

fn result_limit(request: &SearchRequest<'_>) -> ProviderResult<usize> {
  if request.query.trim().is_empty() || request.max_results == 0 {
    return Err(ProviderError::new(
      ProviderErrorKind::InvalidRequest,
      "Diffbot search requires a query and a positive result limit.",
    ));
  }
  Ok(request.max_results.min(MAX_RESULTS))
}

#[derive(Deserialize)]
struct DiffbotSearchResponse {
  search_results: Vec<DiffbotSearchResult>,
}

#[derive(Deserialize)]
struct DiffbotSearchResult {
  title: Option<String>,
  #[serde(rename = "pageUrl")]
  url: String,
  content: Option<String>,
  date: Option<String>,
}

fn normalize_results(results: Vec<DiffbotSearchResult>, max_results: usize) -> Vec<SearchResult> {
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
        metadata: Some(SearchResultMetadata { published_date: result.date, author: None, excerpts: Vec::new() }),
      })
    })
    .take(max_results)
    .collect()
}
