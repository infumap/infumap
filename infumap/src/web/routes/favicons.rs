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
use infusdk::item::{ItemType, NoteIconMode};
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::is_uid;
use log::{debug, warn};
use reqwest::Url;
use reqwest::header::{ACCEPT, HeaderValue, LOCATION};
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
const MAX_FAVICON_BYTES: usize = 256 * 1024;
const MAX_FAVICON_REDIRECTS: usize = 3;
const FAVICON_USER_AGENT: &str = "Infumap favicon fetcher";

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
    if item.item_type != ItemType::Note || item.icon_mode != Some(NoteIconMode::Favicon) {
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
      let data = match fetch_favicon(&note_url).await? {
        Some(data) => data,
        None => return Ok(not_found_response()),
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
  let Some(mut favicon_url) = favicon_url_for_note_url(note_url) else {
    return Ok(None);
  };
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(FAVICON_FETCH_TIMEOUT_SECS))
    .redirect(reqwest::redirect::Policy::none())
    .user_agent(FAVICON_USER_AGENT)
    .build()
    .map_err(|e| format!("Could not build favicon HTTP client: {}", e))?;

  for _ in 0..=MAX_FAVICON_REDIRECTS {
    if !url_allowed_for_favicon_fetch(&favicon_url).await {
      debug!("Skipping favicon fetch for disallowed URL '{}'.", favicon_url);
      return Ok(None);
    }

    let response = match client
      .get(favicon_url.clone())
      .header(ACCEPT, HeaderValue::from_static("image/avif,image/webp,image/apng,image/*,*/*;q=0.8"))
      .send()
      .await
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

fn favicon_url_for_note_url(note_url: &str) -> Option<Url> {
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
  let mut url = Url::parse(&normalized).ok()?;
  if (url.scheme() != "http" && url.scheme() != "https") || url.host_str().is_none() {
    return None;
  }
  url.set_path("/favicon.ico");
  url.set_query(None);
  url.set_fragment(None);
  Some(url)
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
      favicon_url_for_note_url("https://example.com/path?q=1#x").unwrap().as_str(),
      "https://example.com/favicon.ico"
    );
    assert_eq!(favicon_url_for_note_url("example.com/path").unwrap().as_str(), "https://example.com/favicon.ico");
    assert!(favicon_url_for_note_url("mailto:test@example.com").is_none());
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
