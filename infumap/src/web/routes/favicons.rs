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

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response};
use infusdk::item::{ItemIconMode, ItemType};
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::is_uid;
use log::{debug, info, warn};
use reqwest::Url;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderValue, LOCATION};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::storage::cache::favicon::{self as favicon_cache, FaviconCache, FaviconCacheKey};
use crate::storage::db::Db;
use crate::util::mime::detect_mime_type;
use crate::web::serve::{cors_response, full_body, internal_server_error_response, not_found_response};
use crate::web::session::get_and_validate_session;

use super::command::authorize_item;

const FAVICON_FETCH_TIMEOUT_SECS: u64 = 5;
const MAX_FAVICON_DISCOVERY_HTML_BYTES: usize = 256 * 1024;
const MAX_FAVICON_BYTES: usize = 256 * 1024;
const MAX_FAVICON_CANDIDATES_TO_FETCH: usize = 8;
const MAX_FAVICON_REDIRECTS: usize = 3;
const FAVICON_USER_AGENT: &str = "Infumap favicon fetcher";
const FAVICON_IMAGE_ACCEPT: &str = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
const HTML_ACCEPT: &str = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

#[derive(Clone, Debug, Eq, PartialEq)]
struct FaviconCandidate {
  url: Url,
  score: i32,
}

pub async fn serve_favicons_route(
  db: &Arc<Mutex<Db>>,
  favicon_cache: Arc<std::sync::Mutex<FaviconCache>>,
  req: &Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  if req.method() == "OPTIONS" {
    debug!("Serving OPTIONS request, assuming CORS query.");
    return cors_response();
  }

  let session_user_id_maybe = match get_and_validate_session(req, db).await {
    Some(s) => Some(s.user_id),
    None => None,
  };

  let note_id = &req.uri().path()[10..];
  if note_id.is_empty() || note_id.contains('/') || !is_uid(&note_id.to_owned()) {
    return not_found_response();
  }

  match get_or_fetch_favicon(db, favicon_cache, &session_user_id_maybe, note_id).await {
    Ok(response) => response,
    Err(e) => {
      warn!("get_or_fetch_favicon failed for note '{}': {}", note_id, e);
      internal_server_error_response(&format!("get_or_fetch_favicon failed: {}", e))
    }
  }
}

async fn get_or_fetch_favicon(
  db: &Arc<Mutex<Db>>,
  favicon_cache: Arc<std::sync::Mutex<FaviconCache>>,
  session_user_id_maybe: &Option<String>,
  note_id: &str,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  let owner_id;
  let key;
  let note_url;
  {
    let db = db.lock().await;
    let item = match db.item.get(&note_id.to_owned()) {
      Ok(item) => item,
      Err(_) => return Ok(not_found_response()),
    };
    authorize_item(&db, item, session_user_id_maybe, 0)?;
    if item.item_type != ItemType::Note
      || !matches!(item.icon_mode, Some(ItemIconMode::Auto) | Some(ItemIconMode::Favicon))
    {
      return Ok(not_found_response());
    }
    let url = match item.url.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
      Some(url) => url,
      None => return Ok(not_found_response()),
    };
    owner_id = item.owner_id.clone();
    note_url = url.to_owned();
    key = FaviconCacheKey::for_url(item.id.clone(), url);
  }

  let data = match favicon_cache::get(favicon_cache.clone(), &owner_id, key.clone()).await? {
    Some(data) => data,
    None => {
      info!("Favicon cache miss for note '{}' url '{}'. Fetching.", note_id, note_url);
      let data = match fetch_favicon(&note_url).await? {
        Some(data) => data,
        None => {
          info!("No favicon found for note '{}' url '{}'.", note_id, note_url);
          return Ok(not_found_response());
        }
      };
      favicon_cache::put_if_not_exist(favicon_cache, &owner_id, key, data.clone()).await?;
      data
    }
  };

  let Some(content_type) = favicon_content_type(&data) else {
    return Ok(not_found_response());
  };

  Ok(
    Response::builder()
      .header(hyper::header::CONTENT_TYPE, content_type)
      .header("X-Content-Type-Options", "nosniff")
      .header(hyper::header::CACHE_CONTROL, "no-cache")
      .body(full_body(data))
      .unwrap(),
  )
}

async fn fetch_favicon(note_url: &str) -> InfuResult<Option<Vec<u8>>> {
  let Some(page_url) = page_url_for_note_url(note_url) else {
    return Ok(None);
  };
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(FAVICON_FETCH_TIMEOUT_SECS))
    .redirect(reqwest::redirect::Policy::none())
    .user_agent(FAVICON_USER_AGENT)
    .build()
    .map_err(|e| format!("Could not build favicon HTTP client: {}", e))?;

  let mut candidates = discover_favicon_candidates(&client, page_url.clone()).await?;
  candidates.push(FaviconCandidate { url: favicon_url_for_page_url(&page_url), score: 0 });
  candidates = dedupe_and_sort_candidates(candidates);

  for candidate in candidates.into_iter().take(MAX_FAVICON_CANDIDATES_TO_FETCH) {
    if let Some(data) = fetch_favicon_image(&client, candidate.url).await? {
      return Ok(Some(data));
    }
  }

  Ok(None)
}

async fn discover_favicon_candidates(client: &reqwest::Client, page_url: Url) -> InfuResult<Vec<FaviconCandidate>> {
  let Some((final_page_url, html)) = fetch_html_prefix(client, page_url).await? else {
    return Ok(vec![]);
  };
  Ok(discover_favicon_candidates_from_html(&final_page_url, &html))
}

async fn fetch_html_prefix(client: &reqwest::Client, mut page_url: Url) -> InfuResult<Option<(Url, String)>> {
  for _ in 0..=MAX_FAVICON_REDIRECTS {
    if !url_allowed_for_favicon_fetch(&page_url).await {
      debug!("Skipping favicon HTML discovery for disallowed URL '{}'.", page_url);
      return Ok(None);
    }

    let response = match client.get(page_url.clone()).header(ACCEPT, HeaderValue::from_static(HTML_ACCEPT)).send().await
    {
      Ok(response) => response,
      Err(e) => {
        debug!("Favicon HTML discovery for '{}' failed: {}", page_url, e);
        return Ok(None);
      }
    };

    if response.status().is_redirection() {
      let Some(location) = response.headers().get(LOCATION).and_then(|v| v.to_str().ok()) else {
        return Ok(None);
      };
      page_url = match page_url.join(location) {
        Ok(next_url) => next_url,
        Err(_) => return Ok(None),
      };
      continue;
    }

    if !response.status().is_success() {
      debug!("Favicon HTML discovery for '{}' returned status {}.", page_url, response.status());
      return Ok(None);
    }

    let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(|v| v.to_owned());
    if content_type.as_deref().map(content_type_allows_html_discovery).unwrap_or(true) == false {
      return Ok(None);
    }

    let bytes = response_bytes_prefix(response, MAX_FAVICON_DISCOVERY_HTML_BYTES).await;
    let html = String::from_utf8_lossy(&bytes).to_string();
    if !looks_like_html(&html) {
      return Ok(None);
    }
    return Ok(Some((page_url, html)));
  }

  Ok(None)
}

async fn fetch_favicon_image(client: &reqwest::Client, mut favicon_url: Url) -> InfuResult<Option<Vec<u8>>> {
  for _ in 0..=MAX_FAVICON_REDIRECTS {
    if !url_allowed_for_favicon_fetch(&favicon_url).await {
      debug!("Skipping favicon fetch for disallowed URL '{}'.", favicon_url);
      return Ok(None);
    }

    let response =
      match client.get(favicon_url.clone()).header(ACCEPT, HeaderValue::from_static(FAVICON_IMAGE_ACCEPT)).send().await
      {
        Ok(response) => response,
        Err(e) => {
          debug!("Favicon fetch for '{}' failed: {}", favicon_url, e);
          return Ok(None);
        }
      };

    if response.status().is_redirection() {
      let Some(location) = response.headers().get(LOCATION).and_then(|v| v.to_str().ok()) else {
        return Ok(None);
      };
      favicon_url = match favicon_url.join(location) {
        Ok(next_url) => next_url,
        Err(_) => return Ok(None),
      };
      continue;
    }

    if !response.status().is_success() {
      debug!("Favicon fetch for '{}' returned status {}.", favicon_url, response.status());
      return Ok(None);
    }

    let data = match response_bytes_limited(response).await? {
      Some(data) => data,
      None => return Ok(None),
    };
    if favicon_content_type(&data).is_none() {
      return Ok(None);
    }
    return Ok(Some(data));
  }

  Ok(None)
}

fn page_url_for_note_url(note_url: &str) -> Option<Url> {
  let trimmed = note_url.trim();
  if trimmed.is_empty() {
    return None;
  }
  let normalized = if trimmed.contains("://") {
    trimmed.to_owned()
  } else if has_non_http_url_scheme(trimmed) {
    return None;
  } else {
    format!("https://{}", trimmed)
  };
  let url = Url::parse(&normalized).ok()?;
  if (url.scheme() != "http" && url.scheme() != "https") || url.host_str().is_none() {
    return None;
  }
  Some(url)
}

fn favicon_url_for_page_url(page_url: &Url) -> Url {
  let mut url = page_url.clone();
  url.set_path("/favicon.ico");
  url.set_query(None);
  url.set_fragment(None);
  url
}

fn has_non_http_url_scheme(value: &str) -> bool {
  let Some(colon_idx) = value.find(':') else {
    return false;
  };
  let first_path_idx = value.find(['/', '?', '#']).unwrap_or(usize::MAX);
  if colon_idx > first_path_idx {
    return false;
  }
  let scheme = &value[..colon_idx];
  !scheme.contains('.')
    && scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
    && scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
}

async fn url_allowed_for_favicon_fetch(url: &Url) -> bool {
  if url.scheme() != "http" && url.scheme() != "https" {
    return false;
  }
  let Some(host) = url.host_str() else {
    return false;
  };
  if host_is_obviously_local(host) {
    return false;
  }
  let Some(port) = url.port_or_known_default() else {
    return false;
  };
  let addrs = match tokio::net::lookup_host((host, port)).await {
    Ok(addrs) => addrs.collect::<Vec<_>>(),
    Err(e) => {
      debug!("Could not resolve favicon host '{}': {}", host, e);
      return false;
    }
  };
  !addrs.is_empty() && addrs.iter().all(|addr| ip_allowed_for_favicon_fetch(addr.ip()))
}

fn host_is_obviously_local(host: &str) -> bool {
  let lower = host.trim_end_matches('.').to_ascii_lowercase();
  lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local")
}

fn ip_allowed_for_favicon_fetch(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(ip) => {
      let octets = ip.octets();
      !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || octets[0] == 0
        || octets[0] >= 224
        || (octets[0] == 100 && (octets[1] & 0xc0) == 64)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113))
    }
    IpAddr::V6(ip) => {
      if let Some(mapped) = ip.to_ipv4_mapped() {
        return ip_allowed_for_favicon_fetch(IpAddr::V4(mapped));
      }
      let octets = ip.octets();
      !(ip.is_loopback()
        || ip.is_unspecified()
        || octets[0] == 0xff
        || (octets[0] & 0xfe) == 0xfc
        || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80)
        || (octets[0] == 0x20 && octets[1] == 0x01 && octets[2] == 0x0d && octets[3] == 0xb8))
    }
  }
}

async fn response_bytes_limited(response: reqwest::Response) -> InfuResult<Option<Vec<u8>>> {
  if response.content_length().map(|v| v > MAX_FAVICON_BYTES as u64).unwrap_or(false) {
    return Ok(None);
  }

  let mut result = Vec::new();
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = match chunk {
      Ok(chunk) => chunk,
      Err(_) => return Ok(None),
    };
    if result.len() + chunk.len() > MAX_FAVICON_BYTES {
      return Ok(None);
    }
    result.extend_from_slice(&chunk);
  }
  Ok(Some(result))
}

async fn response_bytes_prefix(response: reqwest::Response, max_bytes: usize) -> Vec<u8> {
  let mut result = Vec::new();
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let Ok(chunk) = chunk else {
      break;
    };
    let remaining = max_bytes.saturating_sub(result.len());
    if remaining == 0 {
      break;
    }
    if chunk.len() > remaining {
      result.extend_from_slice(&chunk[..remaining]);
      break;
    }
    result.extend_from_slice(&chunk);
  }
  result
}

fn discover_favicon_candidates_from_html(page_url: &Url, html: &str) -> Vec<FaviconCandidate> {
  let mut candidates = vec![];
  for tag in extract_link_tags(html_head_prefix(html)) {
    if let Some(candidate) = favicon_candidate_from_link_tag(page_url, tag) {
      candidates.push(candidate);
    }
  }
  dedupe_and_sort_candidates(candidates)
}

fn dedupe_and_sort_candidates(candidates: Vec<FaviconCandidate>) -> Vec<FaviconCandidate> {
  let mut by_url = HashMap::<String, FaviconCandidate>::new();
  for candidate in candidates {
    let key = candidate.url.as_str().to_owned();
    match by_url.get(&key) {
      Some(existing) if existing.score >= candidate.score => {}
      _ => {
        by_url.insert(key, candidate);
      }
    }
  }

  let mut result = by_url.into_values().collect::<Vec<FaviconCandidate>>();
  result.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.url.as_str().cmp(b.url.as_str())));
  result
}

fn favicon_candidate_from_link_tag(page_url: &Url, tag: &str) -> Option<FaviconCandidate> {
  let attrs = parse_link_tag_attrs(tag);
  let rel = attrs.get("rel")?;
  let rel_tokens = rel.split_ascii_whitespace().map(|v| v.to_ascii_lowercase()).collect::<Vec<String>>();
  if !rel_tokens.iter().any(|token| favicon_rel_token_is_supported(token)) {
    return None;
  }

  let href = attrs.get("href")?.trim();
  if href.is_empty() {
    return None;
  }

  let url = page_url.join(href).ok()?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return None;
  }

  Some(FaviconCandidate { score: score_favicon_link(&attrs, &rel_tokens, &url), url })
}

fn favicon_rel_token_is_supported(token: &str) -> bool {
  token == "icon" || token == "mask-icon" || token.starts_with("apple-touch-icon")
}

fn score_favicon_link(attrs: &HashMap<String, String>, rel_tokens: &[String], url: &Url) -> i32 {
  let mut score = 0;
  if rel_tokens.iter().any(|token| token == "icon") {
    score += 100;
  }
  if rel_tokens.iter().any(|token| token.starts_with("apple-touch-icon")) {
    score += 80;
  }
  if rel_tokens.iter().any(|token| token == "shortcut") {
    score += 5;
  }
  if rel_tokens.iter().any(|token| token == "mask-icon") {
    score += 10;
  }

  if let Some(sizes) = attrs.get("sizes") {
    score += score_favicon_sizes(sizes);
  }
  if let Some(mime_type) = attrs.get("type") {
    score += score_favicon_mime_type(mime_type);
  }
  score + score_favicon_path(url.path())
}

fn score_favicon_sizes(sizes: &str) -> i32 {
  let lower = sizes.to_ascii_lowercase();
  if lower.split_ascii_whitespace().any(|size| size == "any") {
    return 20;
  }

  let mut best = 0;
  for size in lower.split_ascii_whitespace() {
    let Some((width, height)) = size.split_once('x') else {
      continue;
    };
    let Ok(width) = width.parse::<i32>() else {
      continue;
    };
    let Ok(height) = height.parse::<i32>() else {
      continue;
    };
    if width <= 0 || height <= 0 || width != height {
      continue;
    }
    let score = if width < 16 {
      5
    } else if width < 32 {
      20
    } else if width < 64 {
      35
    } else if width <= 192 {
      40
    } else {
      30
    };
    best = best.max(score);
  }
  best
}

fn score_favicon_mime_type(mime_type: &str) -> i32 {
  match mime_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
    "image/png" | "image/webp" | "image/jpeg" | "image/gif" | "image/x-icon" | "image/vnd.microsoft.icon" => 20,
    "image/svg+xml" => -40,
    other if other.starts_with("image/") => 5,
    _ => 0,
  }
}

fn score_favicon_path(path: &str) -> i32 {
  let lower = path.to_ascii_lowercase();
  if lower.ends_with(".png") || lower.ends_with(".webp") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
    10
  } else if lower.ends_with(".ico") {
    8
  } else if lower.ends_with(".svg") {
    -20
  } else {
    0
  }
}

fn html_head_prefix(html: &str) -> &str {
  let lower = html.to_ascii_lowercase();
  match lower.find("</head") {
    Some(end) => &html[..end],
    None => html,
  }
}

fn extract_link_tags(html: &str) -> Vec<&str> {
  let mut result = vec![];
  let bytes = html.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    let Some(rel_start) = bytes[i..].iter().position(|b| *b == b'<') else {
      break;
    };
    let tag_start = i + rel_start;
    let mut name_start = tag_start + 1;
    while name_start < bytes.len() && bytes[name_start].is_ascii_whitespace() {
      name_start += 1;
    }
    if starts_with_ascii_word(bytes, name_start, b"link") {
      if let Some(tag_end) = find_html_tag_end(bytes, name_start + 4) {
        result.push(&html[tag_start..=tag_end]);
        i = tag_end + 1;
        continue;
      }
    }
    i = tag_start + 1;
  }
  result
}

fn starts_with_ascii_word(bytes: &[u8], start: usize, word: &[u8]) -> bool {
  if start + word.len() > bytes.len() {
    return false;
  }
  if !bytes[start..start + word.len()].eq_ignore_ascii_case(word) {
    return false;
  }
  match bytes.get(start + word.len()) {
    Some(next) => !next.is_ascii_alphanumeric() && *next != b'-' && *next != b'_',
    None => true,
  }
}

fn find_html_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
  let mut quote: Option<u8> = None;
  for (idx, byte) in bytes.iter().enumerate().skip(start) {
    if let Some(quote_byte) = quote {
      if *byte == quote_byte {
        quote = None;
      }
      continue;
    }
    if *byte == b'"' || *byte == b'\'' {
      quote = Some(*byte);
      continue;
    }
    if *byte == b'>' {
      return Some(idx);
    }
  }
  None
}

fn parse_link_tag_attrs(tag: &str) -> HashMap<String, String> {
  let bytes = tag.as_bytes();
  let mut attrs = HashMap::new();
  let mut i = match tag.to_ascii_lowercase().find("link") {
    Some(link_idx) => link_idx + 4,
    None => return attrs,
  };

  while i < bytes.len() {
    while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
      i += 1;
    }
    if i >= bytes.len() || bytes[i] == b'>' {
      break;
    }

    let name_start = i;
    while i < bytes.len() && is_html_attr_name_byte(bytes[i]) {
      i += 1;
    }
    if i == name_start {
      i += 1;
      continue;
    }
    let name = tag[name_start..i].to_ascii_lowercase();

    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
      i += 1;
    }

    let mut value = String::new();
    if i < bytes.len() && bytes[i] == b'=' {
      i += 1;
      while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
      }
      let value_start;
      let value_end;
      if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
        let quote = bytes[i];
        i += 1;
        value_start = i;
        while i < bytes.len() && bytes[i] != quote {
          i += 1;
        }
        value_end = i;
        if i < bytes.len() {
          i += 1;
        }
      } else {
        value_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' && bytes[i] != b'/' {
          i += 1;
        }
        value_end = i;
      }
      value = decode_html_attr_value(&tag[value_start..value_end]);
    }
    attrs.insert(name, value);
  }

  attrs
}

fn is_html_attr_name_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b':'
}

fn decode_html_attr_value(value: &str) -> String {
  let mut result = String::new();
  let mut rest = value;
  loop {
    let Some(amp_idx) = rest.find('&') else {
      result.push_str(rest);
      break;
    };
    result.push_str(&rest[..amp_idx]);
    let after_amp = &rest[amp_idx + 1..];
    let Some(semi_idx) = after_amp.find(';') else {
      result.push('&');
      rest = after_amp;
      continue;
    };
    let entity = &after_amp[..semi_idx];
    if let Some(decoded) = decode_html_entity(entity) {
      result.push(decoded);
    } else {
      result.push('&');
      result.push_str(entity);
      result.push(';');
    }
    rest = &after_amp[semi_idx + 1..];
  }
  result
}

fn decode_html_entity(entity: &str) -> Option<char> {
  match entity.to_ascii_lowercase().as_str() {
    "amp" => Some('&'),
    "quot" => Some('"'),
    "apos" => Some('\''),
    "lt" => Some('<'),
    "gt" => Some('>'),
    other if other.starts_with("#x") => u32::from_str_radix(&other[2..], 16).ok().and_then(char::from_u32),
    other if other.starts_with('#') => other[1..].parse::<u32>().ok().and_then(char::from_u32),
    _ => None,
  }
}

fn content_type_allows_html_discovery(content_type: &str) -> bool {
  matches!(
    content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str(),
    "text/html" | "application/xhtml+xml"
  )
}

fn looks_like_html(html: &str) -> bool {
  let lower = html.trim_start().to_ascii_lowercase();
  lower.starts_with("<!doctype html")
    || lower.starts_with("<html")
    || lower.contains("<head")
    || lower.contains("<link")
}

fn favicon_content_type(data: &[u8]) -> Option<String> {
  if data.len() >= 6 && data.starts_with(&[0, 0, 1, 0]) {
    return Some("image/x-icon".to_owned());
  }
  let mime_type = detect_mime_type(data);
  match mime_type.as_str() {
    "image/gif" | "image/jpeg" | "image/png" | "image/vnd.microsoft.icon" | "image/webp" | "image/x-icon" => {
      Some(mime_type)
    }
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_png_favicon() {
    let data = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D', b'R'];
    assert_eq!(favicon_content_type(&data), Some("image/png".to_owned()));
  }

  #[test]
  fn rejects_html_favicon() {
    assert_eq!(favicon_content_type(b"<!doctype html><html></html>"), None);
  }

  #[test]
  fn builds_favicon_url_from_note_url() {
    assert_eq!(
      favicon_url_for_page_url(&page_url_for_note_url("https://example.com/path?q=1#x").unwrap()).as_str(),
      "https://example.com/favicon.ico"
    );
    assert_eq!(
      favicon_url_for_page_url(&page_url_for_note_url("example.com/path").unwrap()).as_str(),
      "https://example.com/favicon.ico"
    );
    assert!(page_url_for_note_url("mailto:test@example.com").is_none());
  }

  #[test]
  fn discovers_favicon_candidates_from_html_head() {
    let page_url = Url::parse("https://example.com/docs/page.html").unwrap();
    let html = r#"
      <html><head>
        <link rel="stylesheet" href="/app.css">
        <link rel="apple-touch-icon" href="touch.png" sizes="180x180">
        <link rel="shortcut icon" href="/favicon-32.png" sizes="32x32" type="image/png">
      </head><body></body></html>
    "#;
    let candidates = discover_favicon_candidates_from_html(&page_url, html);
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].url.as_str(), "https://example.com/favicon-32.png");
    assert_eq!(candidates[1].url.as_str(), "https://example.com/docs/touch.png");
  }

  #[test]
  fn parses_unquoted_and_entity_encoded_link_attrs() {
    let page_url = Url::parse("https://example.com/").unwrap();
    let html = r#"<LINK REL=icon HREF="/icons/a&amp;b.ico" SIZES=16x16>"#;
    let candidates = discover_favicon_candidates_from_html(&page_url, html);
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].url.as_str(), "https://example.com/icons/a&b.ico");
  }

  #[test]
  fn ignores_links_after_html_head() {
    let page_url = Url::parse("https://example.com/").unwrap();
    let html = r#"
      <html><head><link rel="icon" href="/head.ico"></head>
      <body><link rel="icon" href="/body.ico"></body></html>
    "#;
    let candidates = discover_favicon_candidates_from_html(&page_url, html);
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].url.as_str(), "https://example.com/head.ico");
  }

  #[test]
  fn recognizes_ico_favicon() {
    assert_eq!(favicon_content_type(&[0, 0, 1, 0, 1, 0]), Some("image/x-icon".to_owned()));
  }

  #[test]
  fn rejects_obviously_local_favicon_targets() {
    assert!(host_is_obviously_local("localhost"));
    assert!(host_is_obviously_local("example.local"));
    assert!(!host_is_obviously_local("example.com"));
    assert!(!ip_allowed_for_favicon_fetch("127.0.0.1".parse().unwrap()));
    assert!(!ip_allowed_for_favicon_fetch("192.168.1.1".parse().unwrap()));
    assert!(ip_allowed_for_favicon_fetch("93.184.216.34".parse().unwrap()));
  }
}
