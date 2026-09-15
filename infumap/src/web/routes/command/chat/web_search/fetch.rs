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

use std::net::IpAddr;
use std::time::Duration;

use futures_util::StreamExt;
use htmd::HtmlToMarkdown;
use infusdk::util::infu::InfuResult;
use rand::seq::SliceRandom;
use reqwest::Url;
use reqwest::header::{ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, HeaderMap, HeaderValue, LOCATION, USER_AGENT};
use serde::Serialize;
use tokio::net::lookup_host;

pub const DEFAULT_MAX_CHARS: usize = 8_000;
pub const MAX_CHARS_CAP: usize = 100_000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FETCH_BYTES: usize = 512 * 1024;
const MAX_REDIRECTS: usize = 5;

const USER_AGENTS: &[&str] = &[
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
];

const METADATA_HOSTS: &[&str] =
  &["localhost", "ip6-localhost", "metadata", "metadata.google.internal", "metadata.tencentyun.com"];

#[derive(Clone, Debug, Serialize)]
pub struct FetchedPage {
  pub url: String,
  pub final_url: String,
  pub content_type: String,
  pub truncated: bool,
  pub text: String,
}

#[derive(Serialize)]
struct CompactFetchedPage<'a> {
  url: &'a str,
  #[serde(rename = "finalUrl")]
  final_url: &'a str,
  truncated: bool,
  text: &'a str,
  #[serde(rename = "hostChanged", skip_serializing_if = "is_false")]
  host_changed: bool,
}

/// Fetch a URL, convert HTML to markdown, and return compact JSON for the model.
pub async fn fetch_page_json(url: &str, max_chars: usize) -> InfuResult<String> {
  let page = fetch_url(url, max_chars).await?;
  compact_fetch_page_json(&page)
}

pub fn compact_fetch_page_json(page: &FetchedPage) -> InfuResult<String> {
  serde_json::to_string(&CompactFetchedPage {
    url: &page.url,
    final_url: &page.final_url,
    truncated: page.truncated,
    text: &page.text,
    host_changed: hosts_differ(&page.url, &page.final_url),
  })
  .map_err(|e| format!("Could not serialize fetched page: {}", e).into())
}

/// Fetch a URL, convert HTML to markdown, and truncate the result.
pub async fn fetch_url(url: &str, max_chars: usize) -> InfuResult<FetchedPage> {
  let max_chars = max_chars.clamp(1, MAX_CHARS_CAP);
  let requested = normalize_url_scheme(url.trim())?;
  let client = reqwest::Client::builder()
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(CONNECT_TIMEOUT)
    .timeout(FETCH_TIMEOUT)
    .build()
    .map_err(|e| format!("Could not build fetch HTTP client: {}", e))?;

  let mut current = requested.clone();
  let ua = USER_AGENTS.choose(&mut rand::thread_rng()).copied().unwrap_or(USER_AGENTS[0]);

  for _ in 0..=MAX_REDIRECTS {
    assert_public_destination(&current).await?;
    let response = client
      .get(current.clone())
      .headers(fetch_headers(ua))
      .send()
      .await
      .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    let status = response.status();
    if status.is_redirection() {
      let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Failed to fetch URL: redirect missing Location header.")?;
      current = current.join(location).map_err(|e| format!("Failed to fetch URL: invalid redirect: {}", e))?;
      continue;
    }
    if !status.is_success() {
      return Err(format!("Failed to fetch URL: HTTP {}", status).into());
    }

    let content_type = response
      .headers()
      .get(reqwest::header::CONTENT_TYPE)
      .and_then(|value| value.to_str().ok())
      .unwrap_or("")
      .to_ascii_lowercase();
    let body = read_limited_body(response).await?;
    let text = decode_body(&body, &content_type, max_chars);
    return Ok(FetchedPage {
      url: requested.as_str().to_string(),
      final_url: current.as_str().to_string(),
      content_type,
      truncated: text.truncated,
      text: text.text,
    });
  }

  Err("Failed to fetch URL: too many redirects.".into())
}

struct DecodedText {
  text: String,
  truncated: bool,
}

fn fetch_headers(user_agent: &'static str) -> HeaderMap {
  let mut headers = HeaderMap::new();
  headers.insert(USER_AGENT, HeaderValue::from_static(user_agent));
  headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"));
  headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
  headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, deflate, br"));
  headers
}

fn normalize_url_scheme(url: &str) -> InfuResult<Url> {
  if url.is_empty() {
    return Err("fetch URL cannot be empty".into());
  }
  let with_scheme = if url.starts_with("http://") || url.starts_with("https://") {
    url.to_string()
  } else if url.starts_with("//") {
    format!("https:{url}")
  } else {
    format!("https://{url}")
  };
  Url::parse(&with_scheme).map_err(|e| format!("invalid URL: {}", e).into())
}

async fn assert_public_destination(url: &Url) -> InfuResult<()> {
  match url.scheme() {
    "http" | "https" => {}
    other => return Err(format!("Blocked: unsupported URL scheme '{other}'.").into()),
  }
  if !url.username().is_empty() || url.password().is_some() {
    return Err("Blocked: URL must not include credentials.".into());
  }
  let host = url.host_str().ok_or_else(|| "Blocked: URL has no host.")?;
  if is_blocked_host(host) {
    return Err(format!("Blocked: refusing to fetch host '{host}'.").into());
  }
  let port = url.port_or_known_default().unwrap_or(80);
  let addrs = lookup_host((host, port)).await.map_err(|e| format!("Failed to resolve host: {}", e))?;
  let mut saw_address = false;
  for addr in addrs {
    saw_address = true;
    if !is_global_ip(addr.ip()) {
      return Err(format!("Blocked: refusing to fetch non-public address {}.", addr.ip()).into());
    }
  }
  if !saw_address {
    return Err(format!("Failed to resolve host: no addresses for '{host}'.").into());
  }
  Ok(())
}

fn is_blocked_host(host: &str) -> bool {
  let host = host.trim_end_matches('.').to_ascii_lowercase();
  METADATA_HOSTS.iter().any(|blocked| *blocked == host)
    || host.ends_with(".localhost")
    || host.ends_with(".local")
    || host.starts_with("169.254.")
    || host == "::ffff:169.254.169.254"
}

fn is_global_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => {
      let o = v4.octets();
      !(v4.is_unspecified()
        || v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_multicast()
        || v4.is_broadcast()
        || o[0] == 0
        || (o[0] == 100 && o[1] & 0b1100_0000 == 64)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        || o[0] >= 240)
    }
    IpAddr::V6(v6) => {
      if let Some(v4) = v6.to_ipv4_mapped() {
        return is_global_ip(IpAddr::V4(v4));
      }
      let s = v6.segments();
      !(v6.is_unspecified()
        || v6.is_loopback()
        || v6.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] == 0x2001 && s[1] == 0xdb8))
    }
  }
}

fn is_false(value: &bool) -> bool {
  !*value
}

fn hosts_differ(requested: &str, final_url: &str) -> bool {
  let requested_host = Url::parse(requested).ok().and_then(|url| url.host_str().map(normalize_host));
  let final_host = Url::parse(final_url).ok().and_then(|url| url.host_str().map(normalize_host));
  match (requested_host, final_host) {
    (Some(requested_host), Some(final_host)) => requested_host != final_host,
    _ => requested != final_url,
  }
}

fn normalize_host(host: &str) -> String {
  host.trim_end_matches('.').to_ascii_lowercase()
}

async fn read_limited_body(response: reqwest::Response) -> InfuResult<Vec<u8>> {
  let mut stream = response.bytes_stream();
  let mut body = Vec::new();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|e| format!("Failed to fetch URL: {}", e))?;
    let remaining = MAX_FETCH_BYTES.saturating_sub(body.len());
    if remaining == 0 {
      break;
    }
    if chunk.len() > remaining {
      body.extend_from_slice(&chunk[..remaining]);
      break;
    }
    body.extend_from_slice(&chunk);
  }
  Ok(body)
}

fn decode_body(body: &[u8], content_type: &str, max_chars: usize) -> DecodedText {
  let raw = String::from_utf8_lossy(body);
  let converted = if looks_like_html(body, content_type) { html_to_markdown(&raw) } else { raw.trim().to_string() };
  truncate_text(&converted, max_chars)
}

fn looks_like_html(body: &[u8], content_type: &str) -> bool {
  if content_type.contains("html") {
    return true;
  }
  if content_type.contains("json")
    || content_type.starts_with("text/plain")
    || content_type.starts_with("text/markdown")
    || content_type.starts_with("text/csv")
  {
    return false;
  }
  let prefix = std::str::from_utf8(body.get(..512).unwrap_or(body)).unwrap_or("").trim_start().to_ascii_lowercase();
  prefix.starts_with("<!doctype html") || prefix.starts_with("<html")
}

fn html_to_markdown(html: &str) -> String {
  let converter = HtmlToMarkdown::builder()
    .skip_tags(vec!["script", "style", "nav", "footer", "aside", "noscript", "iframe", "svg", "form"])
    .build();
  let source = extract_main_html(html);
  converter.convert(&source).unwrap_or_else(|_| source).trim().to_string()
}

fn extract_main_html(html: &str) -> String {
  let document = scraper::Html::parse_document(html);
  for selector_text in ["article", "main", "[role=main]"] {
    let Ok(selector) = scraper::Selector::parse(selector_text) else {
      continue;
    };
    if let Some(node) = document.select(&selector).next() {
      let inner = node.html();
      if inner.len() > 200 {
        return inner;
      }
    }
  }
  html.to_string()
}

fn truncate_text(text: &str, max_chars: usize) -> DecodedText {
  if text.is_empty() {
    return DecodedText { text: "(page returned no readable text)".to_string(), truncated: false };
  }
  let total = text.chars().count();
  if total <= max_chars {
    return DecodedText { text: text.to_string(), truncated: false };
  }
  let truncated: String = text.chars().take(max_chars).collect();
  DecodedText { text: format!("{truncated}\n\n... (truncated, {total} chars total)"), truncated: true }
}
