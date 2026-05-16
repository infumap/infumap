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

use futures_util::StreamExt;
use infusdk::util::infu::InfuResult;
use log::debug;
use reqwest::Url;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderValue, LOCATION};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

const LINK_TITLE_FETCH_TIMEOUT_SECS: u64 = 5;
const MAX_LINK_TITLE_HTML_BYTES: usize = 256 * 1024;
const MAX_LINK_TITLE_REDIRECTS: usize = 3;
const MAX_LINK_TITLE_CHARS: usize = 1000;
const MAX_X_OEMBED_JSON_BYTES: usize = 64 * 1024;
const LINK_TITLE_USER_AGENT: &str = "Infumap link title fetcher";
const LINK_TITLE_HTML_ACCEPT: &str = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";
const LINK_TITLE_JSON_ACCEPT: &str = "application/json,*/*;q=0.1";

pub fn normalize_link_url(value: &str) -> InfuResult<Url> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return Err("Invalid link URL.".into());
  }

  let normalized = if trimmed.contains("://") {
    trimmed.to_owned()
  } else if has_non_http_url_scheme(trimmed) {
    return Err("Invalid link URL.".into());
  } else if !looks_like_url_without_scheme(trimmed) {
    return Err("Invalid link URL.".into());
  } else {
    format!("https://{}", trimmed)
  };

  let url = Url::parse(&normalized).map_err(|_| "Invalid link URL.")?;
  if (url.scheme() != "http" && url.scheme() != "https") || url.host_str().is_none() {
    return Err("Invalid link URL.".into());
  }

  Ok(url)
}

pub async fn fetch_link_title(url: &Url) -> InfuResult<Option<String>> {
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(LINK_TITLE_FETCH_TIMEOUT_SECS))
    .redirect(reqwest::redirect::Policy::none())
    .user_agent(LINK_TITLE_USER_AGENT)
    .build()
    .map_err(|e| format!("Could not build link title HTTP client: {}", e))?;

  let html_maybe = fetch_html_prefix(&client, url.clone()).await?;

  if let Some(html) = &html_maybe {
    if let Some(title) = extract_title_from_html(html) {
      return Ok(Some(title));
    }
  }

  if is_x_or_twitter_url(url) {
    return fetch_x_or_twitter_title(&client, url, html_maybe.as_deref()).await;
  }

  Ok(None)
}

async fn fetch_html_prefix(client: &reqwest::Client, mut page_url: Url) -> InfuResult<Option<String>> {
  for _ in 0..=MAX_LINK_TITLE_REDIRECTS {
    if !url_allowed_for_title_fetch(&page_url).await {
      debug!("Skipping link title fetch for disallowed URL '{}'.", page_url);
      return Ok(None);
    }

    let response = match client
      .get(page_url.clone())
      .header(ACCEPT, HeaderValue::from_static(LINK_TITLE_HTML_ACCEPT))
      .send()
      .await
    {
      Ok(response) => response,
      Err(e) => {
        debug!("Link title fetch for '{}' failed: {}", page_url, e);
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
      debug!("Link title fetch for '{}' returned status {}.", page_url, response.status());
      return Ok(None);
    }

    let content_type = response.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(|v| v.to_owned());
    if content_type.as_deref().map(content_type_allows_html).unwrap_or(true) == false {
      return Ok(None);
    }

    let bytes = response_bytes_prefix(response, MAX_LINK_TITLE_HTML_BYTES).await;
    let html = decode_html_bytes(&bytes);
    if !looks_like_html(&html) {
      return Ok(None);
    }
    return Ok(Some(html));
  }

  Ok(None)
}

fn extract_title_from_html(html: &str) -> Option<String> {
  let head = html_head_prefix(html);
  extract_title_tag(head).or_else(|| extract_meta_title(head))
}

fn extract_title_tag(html: &str) -> Option<String> {
  let bytes = html.as_bytes();
  let lower = html.to_ascii_lowercase();
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
    if starts_with_ascii_word(bytes, name_start, b"title") {
      let tag_end = find_html_tag_end(bytes, name_start + 5)?;
      let title_start = tag_end + 1;
      let close_idx = lower[title_start..].find("</title")?;
      let title_end = title_start + close_idx;
      return normalize_title_text(&html[title_start..title_end]);
    }
    i = tag_start + 1;
  }
  None
}

fn extract_meta_title(html: &str) -> Option<String> {
  let mut fallback: Option<String> = None;
  for tag in extract_tags(html, b"meta") {
    let attrs = parse_tag_attrs(tag, b"meta");
    let Some(content) = attrs.get("content") else {
      continue;
    };
    let title_kind =
      attrs.get("property").or_else(|| attrs.get("name")).map(|v| v.trim().to_ascii_lowercase()).unwrap_or_default();

    if title_kind == "og:title" {
      if let Some(title) = normalize_title_text(content) {
        return Some(title);
      }
    }
    if title_kind == "twitter:title" && fallback.is_none() {
      fallback = normalize_title_text(content);
    }
  }
  fallback
}

#[derive(Deserialize)]
struct XTwitterOEmbedResponse {
  #[serde(default)]
  author_name: String,
  #[serde(default)]
  html: String,
  #[serde(default)]
  title: String,
}

async fn fetch_x_or_twitter_title(
  client: &reqwest::Client,
  url: &Url,
  html_maybe: Option<&str>,
) -> InfuResult<Option<String>> {
  if x_or_twitter_status_id(url).is_some() {
    if let Some(title) = fetch_x_or_twitter_oembed_title(client, url).await? {
      return Ok(Some(title));
    }
  }

  Ok(html_maybe.and_then(|html| extract_x_or_twitter_initial_state_title(url, html)))
}

async fn fetch_x_or_twitter_oembed_title(client: &reqwest::Client, url: &Url) -> InfuResult<Option<String>> {
  let mut oembed_url = Url::parse("https://publish.twitter.com/oembed")
    .map_err(|e| format!("Could not build X/Twitter oEmbed URL: {}", e))?;
  oembed_url.query_pairs_mut().append_pair("url", url.as_str()).append_pair("omit_script", "1").append_pair("dnt", "1");

  let response = match client
    .get(oembed_url.clone())
    .header(ACCEPT, HeaderValue::from_static(LINK_TITLE_JSON_ACCEPT))
    .send()
    .await
  {
    Ok(response) => response,
    Err(e) => {
      debug!("X/Twitter oEmbed title fetch for '{}' failed: {}", url, e);
      return Ok(None);
    }
  };

  if !response.status().is_success() {
    debug!("X/Twitter oEmbed title fetch for '{}' returned status {}.", url, response.status());
    return Ok(None);
  }

  let bytes = response_bytes_prefix(response, MAX_X_OEMBED_JSON_BYTES).await;
  let body = String::from_utf8_lossy(&bytes);
  let parsed: XTwitterOEmbedResponse = match serde_json::from_str(&body) {
    Ok(parsed) => parsed,
    Err(e) => {
      debug!("Could not parse X/Twitter oEmbed response for '{}': {}", url, e);
      return Ok(None);
    }
  };

  if let Some(text) = extract_x_oembed_tweet_text(&parsed.html) {
    return Ok(format_x_or_twitter_title(Some(parsed.author_name.as_str()), None, &text));
  }
  Ok(normalize_title_text(&parsed.title))
}

fn extract_x_oembed_tweet_text(html: &str) -> Option<String> {
  let lower = html.to_ascii_lowercase();
  let p_start = lower.find("<p")?;
  let content_start = find_html_tag_end(html.as_bytes(), p_start + 2)? + 1;
  let rel_content_end = lower[content_start..].find("</p")?;
  let content_end = content_start + rel_content_end;
  html_fragment_to_text(&html[content_start..content_end])
}

fn extract_x_or_twitter_initial_state_title(url: &Url, html: &str) -> Option<String> {
  let state = extract_x_initial_state_json(html)?;
  if let Some(status_id) = x_or_twitter_status_id(url) {
    if let Some(title) = extract_x_status_title_from_initial_state(&state, status_id) {
      return Some(title);
    }
  }
  let handle = x_or_twitter_profile_handle(url)?;
  extract_x_profile_title_from_initial_state(&state, handle)
}

fn extract_x_initial_state_json(html: &str) -> Option<serde_json::Value> {
  const MARKER: &str = "window.__INITIAL_STATE__=";
  let json_start = html.find(MARKER)? + MARKER.len();
  let json_end = find_balanced_json_object_end(&html[json_start..])?;
  serde_json::from_str(&html[json_start..json_start + json_end]).ok()
}

fn find_balanced_json_object_end(value: &str) -> Option<usize> {
  let bytes = value.as_bytes();
  if bytes.first().copied()? != b'{' {
    return None;
  }
  let mut depth = 0usize;
  let mut in_string = false;
  let mut escaped = false;
  for (idx, byte) in bytes.iter().enumerate() {
    if in_string {
      if escaped {
        escaped = false;
      } else if *byte == b'\\' {
        escaped = true;
      } else if *byte == b'"' {
        in_string = false;
      }
      continue;
    }

    if *byte == b'"' {
      in_string = true;
    } else if *byte == b'{' {
      depth += 1;
    } else if *byte == b'}' {
      depth = depth.checked_sub(1)?;
      if depth == 0 {
        return Some(idx + 1);
      }
    }
  }
  None
}

fn extract_x_status_title_from_initial_state(state: &serde_json::Value, status_id: &str) -> Option<String> {
  let tweet = state.pointer("/entities/tweets/entities")?.get(status_id)?;
  let text = json_string_field(tweet, "full_text").or_else(|| json_string_field(tweet, "text"))?;
  let user_id = json_string_field(tweet, "user");
  let (name, screen_name) = user_id
    .and_then(|id| state.pointer("/entities/users/entities").and_then(|users| users.get(id)))
    .map(|user| (json_string_field(user, "name"), json_string_field(user, "screen_name")))
    .unwrap_or((None, None));
  format_x_or_twitter_title(name.as_deref(), screen_name.as_deref(), &text)
}

fn extract_x_profile_title_from_initial_state(state: &serde_json::Value, handle: &str) -> Option<String> {
  let handle_lower = handle.to_ascii_lowercase();
  let users = state.pointer("/entities/users/entities")?.as_object()?;
  let user = users.values().find(|user| {
    json_string_field(user, "screen_name")
      .map(|screen_name| screen_name.eq_ignore_ascii_case(&handle_lower))
      .unwrap_or(false)
  })?;
  let name = json_string_field(user, "name");
  let screen_name = json_string_field(user, "screen_name");
  format_x_profile_title(name.as_deref(), screen_name.as_deref())
}

fn json_string_field(value: &serde_json::Value, field: &str) -> Option<String> {
  value.get(field)?.as_str().map(|v| v.to_owned())
}

fn format_x_or_twitter_title(author_name: Option<&str>, screen_name: Option<&str>, text: &str) -> Option<String> {
  let author = format_x_author(author_name, screen_name);
  let text = normalize_title_text(text)?;
  match author {
    Some(author) => normalize_title_text(&format!("{}: {}", author, text)),
    None => Some(text),
  }
}

fn format_x_profile_title(name: Option<&str>, screen_name: Option<&str>) -> Option<String> {
  let author = format_x_author(name, screen_name)?;
  normalize_title_text(&format!("{} / X", author))
}

fn format_x_author(name: Option<&str>, screen_name: Option<&str>) -> Option<String> {
  let name = name.and_then(normalize_title_text);
  let screen_name = screen_name.and_then(normalize_title_text);
  match (name, screen_name) {
    (Some(name), Some(screen_name)) if screen_name.starts_with('@') => Some(format!("{} ({})", name, screen_name)),
    (Some(name), Some(screen_name)) => Some(format!("{} (@{})", name, screen_name)),
    (Some(name), None) => Some(name),
    (None, Some(screen_name)) if screen_name.starts_with('@') => Some(screen_name),
    (None, Some(screen_name)) => Some(format!("@{}", screen_name)),
    (None, None) => None,
  }
}

fn html_fragment_to_text(html: &str) -> Option<String> {
  let bytes = html.as_bytes();
  let mut result = String::new();
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] != b'<' {
      let next_tag = bytes[i..].iter().position(|byte| *byte == b'<').map(|idx| i + idx).unwrap_or(bytes.len());
      result.push_str(&html[i..next_tag]);
      i = next_tag;
      continue;
    }

    let tag_start = i;
    let tag_name_start = tag_start + 1;
    let tag_name_start =
      if bytes.get(tag_name_start).copied() == Some(b'/') { tag_name_start + 1 } else { tag_name_start };
    let Some(tag_end) = find_html_tag_end(bytes, tag_name_start) else {
      break;
    };
    let tag_name_end = (tag_name_start..tag_end).find(|idx| !is_html_attr_name_byte(bytes[*idx])).unwrap_or(tag_end);
    let tag_name = html[tag_name_start..tag_name_end].to_ascii_lowercase();
    if matches!(tag_name.as_str(), "br" | "p" | "div" | "blockquote") {
      result.push(' ');
    }
    i = tag_end + 1;
  }
  normalize_title_text(&result)
}

fn is_x_or_twitter_url(url: &Url) -> bool {
  let Some(host) = url.host_str() else {
    return false;
  };
  matches!(
    host.trim_end_matches('.').to_ascii_lowercase().as_str(),
    "x.com" | "www.x.com" | "twitter.com" | "www.twitter.com" | "mobile.twitter.com"
  )
}

fn x_or_twitter_status_id(url: &Url) -> Option<&str> {
  let segments = url.path_segments()?.filter(|segment| !segment.is_empty()).collect::<Vec<&str>>();
  for window in segments.windows(2) {
    if window[0] == "status" && window[1].chars().all(|c| c.is_ascii_digit()) {
      return Some(window[1]);
    }
  }
  None
}

fn x_or_twitter_profile_handle(url: &Url) -> Option<&str> {
  let first_segment = url.path_segments()?.find(|segment| !segment.is_empty())?;
  if matches!(first_segment, "home" | "explore" | "messages" | "notifications" | "search" | "settings" | "i" | "intent")
  {
    return None;
  }
  if first_segment.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { Some(first_segment) } else { None }
}

fn normalize_title_text(value: &str) -> Option<String> {
  let decoded = decode_html_entities(value);
  let collapsed = decoded.split_whitespace().collect::<Vec<&str>>().join(" ");
  if collapsed.is_empty() { None } else { Some(collapsed.chars().take(MAX_LINK_TITLE_CHARS).collect()) }
}

fn decode_html_bytes(bytes: &[u8]) -> String {
  if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
    return String::from_utf8_lossy(&bytes[3..]).to_string();
  }
  String::from_utf8_lossy(bytes).to_string()
}

fn html_head_prefix(html: &str) -> &str {
  let lower = html.to_ascii_lowercase();
  match lower.find("</head") {
    Some(end) => &html[..end],
    None => html,
  }
}

fn extract_tags<'a>(html: &'a str, tag_name: &[u8]) -> Vec<&'a str> {
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
    if starts_with_ascii_word(bytes, name_start, tag_name) {
      if let Some(tag_end) = find_html_tag_end(bytes, name_start + tag_name.len()) {
        result.push(&html[tag_start..=tag_end]);
        i = tag_end + 1;
        continue;
      }
    }
    i = tag_start + 1;
  }
  result
}

fn parse_tag_attrs(tag: &str, tag_name: &[u8]) -> HashMap<String, String> {
  let bytes = tag.as_bytes();
  let mut attrs = HashMap::new();
  let mut i = 0;
  while i < bytes.len() && bytes[i] != b'<' {
    i += 1;
  }
  if i >= bytes.len() {
    return attrs;
  }
  i += 1;
  while i < bytes.len() && bytes[i].is_ascii_whitespace() {
    i += 1;
  }
  if !starts_with_ascii_word(bytes, i, tag_name) {
    return attrs;
  }
  i += tag_name.len();

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
      value = decode_html_entities(&tag[value_start..value_end]);
    }
    attrs.insert(name, value);
  }

  attrs
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

fn is_html_attr_name_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b':'
}

fn decode_html_entities(value: &str) -> String {
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
    "nbsp" => char::from_u32(0x00a0),
    "ndash" => char::from_u32(0x2013),
    "mdash" => char::from_u32(0x2014),
    "lsquo" => char::from_u32(0x2018),
    "rsquo" => char::from_u32(0x2019),
    "ldquo" => char::from_u32(0x201c),
    "rdquo" => char::from_u32(0x201d),
    other if other.starts_with("#x") => u32::from_str_radix(&other[2..], 16).ok().and_then(char::from_u32),
    other if other.starts_with('#') => other[1..].parse::<u32>().ok().and_then(char::from_u32),
    _ => None,
  }
}

fn content_type_allows_html(content_type: &str) -> bool {
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
    || lower.contains("<title")
    || lower.contains("<meta")
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

fn looks_like_url_without_scheme(value: &str) -> bool {
  let authority = value.split(['/', '?', '#']).next().unwrap_or("");
  let host_port = authority.rsplit('@').next().unwrap_or(authority);
  let host = if host_port.starts_with('[') {
    host_port.split(']').next().unwrap_or(host_port)
  } else {
    host_port.split(':').next().unwrap_or(host_port)
  };
  host.contains('.') || host.parse::<IpAddr>().is_ok()
}

async fn url_allowed_for_title_fetch(url: &Url) -> bool {
  if url.scheme() != "http" && url.scheme() != "https" {
    return false;
  }
  if !url.username().is_empty() || url.password().is_some() {
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
      debug!("Could not resolve link title host '{}': {}", host, e);
      return false;
    }
  };
  !addrs.is_empty() && addrs.iter().all(|addr| ip_allowed_for_title_fetch(addr.ip()))
}

fn host_is_obviously_local(host: &str) -> bool {
  let lower = host.trim_end_matches('.').to_ascii_lowercase();
  lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local")
}

fn ip_allowed_for_title_fetch(ip: IpAddr) -> bool {
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
        return ip_allowed_for_title_fetch(IpAddr::V4(mapped));
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
