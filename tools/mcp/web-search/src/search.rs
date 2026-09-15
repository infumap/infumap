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

use once_cell::sync::Lazy;
use rand::seq::SliceRandom;
use reqwest::Url;
use reqwest::header::{ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, HeaderMap, HeaderValue, ORIGIN, REFERER, USER_AGENT};
use scraper::{Html, Selector};
use serde::Serialize;

use crate::error::InfuResult;

pub const DEFAULT_MAX_RESULTS: usize = 5;
pub const MAX_RESULTS_CAP: usize = 30;
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

#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
  pub title: String,
  pub url: String,
  pub snippet: String,
}

#[derive(Serialize)]
struct CompactWebSearchResponse<'a> {
  query: &'a str,
  results: &'a [SearchResult],
}

/// Search DuckDuckGo's undocumented HTML endpoint and return compact JSON for the model.
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

/// Search DuckDuckGo's undocumented HTML endpoint, matching the `ddgs` DuckDuckGo backend.
pub async fn search(query: &str, max_results: usize) -> InfuResult<Vec<SearchResult>> {
  let query = query.trim();
  if query.is_empty() {
    return Err("search query cannot be empty".into());
  }
  let max_results = max_results.clamp(1, MAX_RESULTS_CAP);

  let client = reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(10))
    .timeout(SEARCH_TIMEOUT)
    .build()
    .map_err(|e| format!("Could not build web search HTTP client: {}", e))?;

  let response = client
    .post(SEARCH_URL)
    .headers(search_headers())
    .form(&[("q", query), ("b", ""), ("l", SEARCH_REGION)])
    .send()
    .await
    .map_err(|e| format!("DuckDuckGo search request failed: {}", e))?;

  let status = response.status();
  let html = response.text().await.map_err(|e| format!("Could not read DuckDuckGo search body: {}", e))?;

  if status.as_u16() == 202 || is_blocked_html(&html) {
    return Err("DuckDuckGo blocked the search request (bot check or empty challenge page)".into());
  }
  if !status.is_success() {
    return Err(format!("DuckDuckGo search returned HTTP {}", status).into());
  }

  parse_results(&html, max_results)
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

fn parse_results(html: &str, max_results: usize) -> InfuResult<Vec<SearchResult>> {
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

fn unwrap_ddg_href(href: &str) -> Option<String> {
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
