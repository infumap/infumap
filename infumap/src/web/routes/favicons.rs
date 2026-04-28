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
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response};
use infusdk::item::{ItemType, NoteIconMode};
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::is_uid;
use log::{debug, warn};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::storage::cache::favicon::{self as favicon_cache, FaviconCache, FaviconCacheKey};
use crate::storage::db::Db;
use crate::util::mime::detect_mime_type;
use crate::web::serve::{cors_response, full_body, internal_server_error_response, not_found_response};
use crate::web::session::get_and_validate_session;

use super::command::authorize_item;

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

  match get_cached_favicon(db, favicon_cache, &session_user_id_maybe, note_id).await {
    Ok(response) => response,
    Err(e) => {
      warn!("get_cached_favicon failed for note '{}': {}", note_id, e);
      internal_server_error_response(&format!("get_cached_favicon failed: {}", e))
    }
  }
}

async fn get_cached_favicon(
  db: &Arc<Mutex<Db>>,
  favicon_cache: Arc<std::sync::Mutex<FaviconCache>>,
  session_user_id_maybe: &Option<String>,
  note_id: &str,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  let owner_id;
  let key;
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
    key = FaviconCacheKey::for_url(item.id.clone(), url);
  }

  let data = match favicon_cache::get(favicon_cache, &owner_id, key).await? {
    Some(data) => data,
    None => return Ok(not_found_response()),
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

fn favicon_content_type(data: &[u8]) -> Option<String> {
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
}
