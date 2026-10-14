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
use once_cell::sync::Lazy;
use rand::seq::SliceRandom;
use reqwest::Url;
use reqwest::header::{
  ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, HeaderMap, HeaderValue, ORIGIN, REFERER, RETRY_AFTER, USER_AGENT,
};
use scraper::{Html, Selector};

use super::{
  ProviderError, ProviderErrorKind, ProviderResult, RequestCost, SearchProvider, SearchRequest, SearchResult,
};

const SEARCH_URL: &str = "https://html.duckduckgo.com/html/";
const SEARCH_REGION: &str = "us-en";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

const CHROME_USER_AGENTS: &[&str] = &[
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

static SEARCH_USER_AGENT: Lazy<&'static str> =
  Lazy::new(|| CHROME_USER_AGENTS.choose(&mut rand::thread_rng()).copied().unwrap_or(CHROME_USER_AGENTS[0]));

static RESULT_SELECTOR: Lazy<Selector> = Lazy::new(|| Selector::parse("div.web-result").expect("result selector"));
static TITLE_SELECTOR: Lazy<Selector> =
  Lazy::new(|| Selector::parse("h2 a.result__a, a.result__a").expect("title selector"));
static SNIPPET_SELECTOR: Lazy<Selector> =
  Lazy::new(|| Selector::parse("a.result__snippet, td.result-snippet").expect("snippet selector"));
static NO_RESULTS_SELECTOR: Lazy<Selector> =
  Lazy::new(|| Selector::parse("div.no-results").expect("no-results selector"));

/// Adapter for DuckDuckGo's undocumented HTML endpoint, matching the `ddgs` backend.
pub struct DuckDuckGo;

impl SearchProvider for DuckDuckGo {
  fn name(&self) -> &'static str {
    "duckduckgo"
  }

  fn estimate_cost(&self, _request: &SearchRequest<'_>) -> ProviderResult<RequestCost> {
    Ok(RequestCost::Unmetered)
  }

  fn search<'a>(&'a self, request: SearchRequest<'a>) -> BoxFuture<'a, ProviderResult<Vec<SearchResult>>> {
    Box::pin(async move {
      let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(SEARCH_TIMEOUT)
        .build()
        .map_err(|e| {
          ProviderError::new(ProviderErrorKind::Internal, format!("Could not build web search HTTP client: {e}"))
        })?;

      let response = client
        .post(SEARCH_URL)
        .headers(search_headers())
        .form(&[("q", request.query), ("b", ""), ("l", SEARCH_REGION)])
        .send()
        .await
        .map_err(|e| {
          ProviderError::new(ProviderErrorKind::Transient, format!("DuckDuckGo search request failed: {e}"))
        })?;

      let status = response.status();
      // Honor delta-seconds Retry-After values. A missing or unsupported value
      // leaves cooldown policy to the router rather than inventing a duration.
      let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
      if status.as_u16() == 202 || status.as_u16() == 403 {
        return Err(blocked_error().with_retry_after(retry_after));
      }
      if !status.is_success() {
        let kind = match status.as_u16() {
          429 => ProviderErrorKind::RateLimited,
          408 | 500..=599 => ProviderErrorKind::Transient,
          400 | 413 | 414 | 422 => ProviderErrorKind::InvalidRequest,
          _ => ProviderErrorKind::UnexpectedResponse,
        };
        return Err(
          ProviderError::new(kind, format!("DuckDuckGo search returned HTTP {status}")).with_retry_after(retry_after),
        );
      }

      let html = response.text().await.map_err(|e| {
        let kind = if e.is_decode() { ProviderErrorKind::UnexpectedResponse } else { ProviderErrorKind::Transient };
        ProviderError::new(kind, format!("Could not read DuckDuckGo search body: {e}"))
      })?;
      if is_blocked_html(&html) {
        return Err(blocked_error().with_retry_after(retry_after));
      }

      parse_results(&html, request.max_results)
    })
  }
}

fn blocked_error() -> ProviderError {
  ProviderError::new(
    ProviderErrorKind::Blocked,
    "DuckDuckGo blocked the search request (bot check or empty challenge page)",
  )
}

fn search_headers() -> HeaderMap {
  let mut headers = HeaderMap::new();
  headers.insert(USER_AGENT, HeaderValue::from_static(*SEARCH_USER_AGENT));
  headers.insert(
    ACCEPT,
    HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"),
  );
  headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
  headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, deflate, br"));
  headers.insert(ORIGIN, HeaderValue::from_static("https://html.duckduckgo.com"));
  headers.insert(REFERER, HeaderValue::from_static("https://html.duckduckgo.com/"));
  headers.insert("upgrade-insecure-requests", HeaderValue::from_static("1"));
  headers
}

pub(crate) fn parse_results(html: &str, max_results: usize) -> ProviderResult<Vec<SearchResult>> {
  let document = Html::parse_document(html);
  if document.select(&NO_RESULTS_SELECTOR).next().is_some() {
    return Ok(Vec::new());
  }

  let mut results = Vec::new();
  let mut seen_urls = HashSet::new();
  for node in document.select(&RESULT_SELECTOR) {
    let class_attr = node.value().attr("class").unwrap_or("");
    if class_attr
      .split_whitespace()
      .any(|class| class.contains("result--ad") || class == "ad-result" || class.contains("has-ad"))
    {
      continue;
    }
    let Some(anchor) = node.select(&TITLE_SELECTOR).next() else {
      continue;
    };
    let href = anchor.value().attr("href").unwrap_or("");
    let Some(url) = unwrap_ddg_href(href) else {
      continue;
    };
    let title = collapse_ws(&anchor.text().collect::<String>());
    if title.is_empty() {
      continue;
    }
    if !seen_urls.insert(url.clone()) {
      continue;
    }
    let snippet = node
      .select(&SNIPPET_SELECTOR)
      .next()
      .map(|snippet| collapse_ws(&snippet.text().collect::<String>()))
      .unwrap_or_default();
    results.push(SearchResult { title, url, snippet });
    if results.len() >= max_results {
      break;
    }
  }
  Ok(results)
}

pub(crate) fn unwrap_ddg_href(href: &str) -> Option<String> {
  let href = href.trim();
  if href.is_empty() {
    return None;
  }
  let absolute = if let Some(rest) = href.strip_prefix("//") {
    format!("https://{rest}")
  } else if href.starts_with('/') {
    format!("https://html.duckduckgo.com{href}")
  } else {
    href.to_string()
  };
  let parsed = Url::parse(&absolute).ok()?;
  let host = parsed.host_str().unwrap_or("");
  if host.ends_with("duckduckgo.com") {
    if parsed.path() == "/y.js" || parsed.path().starts_with("/y.js") {
      return None;
    }
    if parsed.path() == "/l/" || parsed.path() == "/l" {
      for (key, value) in parsed.query_pairs() {
        if key == "uddg" {
          let dest = value.into_owned();
          if dest.starts_with("http://") || dest.starts_with("https://") {
            return Some(dest);
          }
        }
      }
      return None;
    }
  }
  Some(absolute)
}

fn is_blocked_html(html: &str) -> bool {
  let lowered = html.to_ascii_lowercase();
  lowered.contains("anomaly.js")
    || lowered.contains("bots use duckduckgo too")
    || lowered.contains("unfortunately, bots")
    || (lowered.contains("captcha") && lowered.contains("duckduckgo"))
}

fn collapse_ws(value: &str) -> String {
  value.split_whitespace().collect::<Vec<_>>().join(" ")
}
