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
use config::Config;
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response};
use image::ImageReader;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::is_uid;
use log::{debug, warn};
use once_cell::sync::Lazy;
use prometheus::{IntCounterVec, opts};
use serde::Deserialize;
use std::io::Cursor;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Mutex;

use crate::ai::artifact_paths::{
  item_fragments_manifest_path, item_fragments_path, item_geo_content_path, item_text_content_path,
  item_text_manifest_path,
};
use crate::ai::image_tagging::is_supported_image_tagging_mime_type;
use crate::config::{
  CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS, CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT, CONFIG_MAX_SCALE_IMAGE_UP_PERCENT,
};
use crate::storage::cache as storage_cache;
use crate::storage::cache::{ImageCacheKey, ImageSize};
use crate::storage::db::Db;
use crate::storage::object;
use crate::util::image::{adjust_image_for_exif_orientation, get_exif_orientation};
use crate::web::serve::{
  cors_response, forbidden_response, full_body, internal_server_error_response, not_found_response,
};
use crate::web::session::get_and_validate_session;

use super::command::authorize_item;

pub static METRIC_CACHED_IMAGE_REQUESTS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(opts!("cached_image_requests_total", "Total number of images served from cache."), &["name"])
    .expect("Could not create METRIC_CACHED_IMAGE_REQUESTS_TOTAL.")
});

const LABEL_HIT_APPROX: &'static str = "hit_approx";
const LABEL_HIT_EXACT: &'static str = "hit_exact";
const LABEL_HIT_ORIG: &'static str = "hit_orig";
const LABEL_MISS_ORIG: &'static str = "miss_orig";
const LABEL_MISS_CREATE: &'static str = "miss";
const LABEL_FULL: &'static str = "full";
const LABEL_FAILED: &'static str = "failed";
const TEXT_NOT_AVAILABLE_MESSAGE: &str = "[text not available]";
const FRAGMENTS_NOT_AVAILABLE_MESSAGE: &str = "[fragments not available]";
const GEO_INFO_NOT_AVAILABLE_MESSAGE: &str = "[geo info not available]";

// 90 => very high-quality with significant reduction in file size.
// 80 => almost no loss of quality.
// 75 and below => starting to see significant loss in quality.
// TODO (LOW): Make this configurable.
const JPEG_QUALITY: u8 = 80;
const FRAGMENT_VIEW_RULE: &str = "-----------------";

#[derive(Deserialize)]
struct ItemTextManifest {
  status: String,
  content_mime_type: String,
}

#[derive(Deserialize)]
struct FragmentRecord {
  ordinal: usize,
  text: String,
  page_start: Option<usize>,
  page_end: Option<usize>,
}

fn is_safe_inline_mime(mime_type: &str) -> bool {
  let mime_type = mime_type.to_ascii_lowercase();
  if mime_type == "image/svg+xml" {
    return false;
  }
  if mime_type.starts_with("image/") {
    return true;
  }
  matches!(
    mime_type.as_str(),
    "application/pdf"
      | "application/json"
      | "text/plain"
      | "text/markdown"
      | "text/csv"
      | "audio/mpeg"
      | "audio/mp4"
      | "audio/ogg"
      | "audio/wav"
      | "audio/webm"
      | "video/mp4"
      | "video/ogg"
      | "video/webm"
  )
}

fn response_filename(uid: &str, title_maybe: Option<&str>) -> String {
  match title_maybe.map(str::trim).filter(|title| !title.is_empty()) {
    Some(title) => title.to_owned(),
    None => uid.to_owned(),
  }
}

fn sanitize_ascii_filename(filename: &str) -> String {
  let sanitized: String = filename
    .chars()
    .map(|c| match c {
      'a'..='z' | 'A'..='Z' | '0'..='9' | ' ' | '.' | '-' | '_' | '(' | ')' | '[' | ']' => c,
      _ => '_',
    })
    .collect();
  let sanitized = sanitized.trim();
  if sanitized.is_empty() { "download".to_owned() } else { sanitized.to_owned() }
}

fn encode_rfc5987_value(value: &str) -> String {
  let mut encoded = String::new();
  for byte in value.as_bytes() {
    match byte {
      b'a'..=b'z'
      | b'A'..=b'Z'
      | b'0'..=b'9'
      | b'!'
      | b'#'
      | b'$'
      | b'&'
      | b'+'
      | b'-'
      | b'.'
      | b'^'
      | b'_'
      | b'`'
      | b'|'
      | b'~' => encoded.push(*byte as char),
      _ => encoded.push_str(&format!("%{:02X}", byte)),
    }
  }
  encoded
}

fn content_disposition_header(filename: &str, inline: bool) -> String {
  let mode = if inline { "inline" } else { "attachment" };
  let ascii_filename = sanitize_ascii_filename(filename);
  let utf8_filename = encode_rfc5987_value(filename);
  format!("{}; filename=\"{}\"; filename*=UTF-8''{}", mode, ascii_filename, utf8_filename)
}

fn response_content_headers(filename: &str, mime_type: &str) -> (String, String) {
  if is_safe_inline_mime(mime_type) {
    (mime_type.to_owned(), content_disposition_header(filename, true))
  } else {
    ("application/octet-stream".to_owned(), content_disposition_header(filename, false))
  }
}

fn response_content_headers_for_generated_item_text(filename: &str, mime_type: &str) -> (String, String) {
  let (content_type, content_disposition) = response_content_headers(filename, mime_type);
  let content_type = match mime_type {
    "text/plain" | "text/markdown" | "text/csv" if content_type == mime_type => {
      format!("{}; charset=utf-8", mime_type)
    }
    _ => content_type,
  };
  (content_type, content_disposition)
}

fn parse_resized_image_name(name: &str) -> Option<(&str, u32)> {
  let (uid, width) = name.split_once('_')?;
  if !is_uid(uid) {
    return None;
  }
  let width = width.parse::<u32>().ok()?;
  if width == 0 {
    return None;
  }
  Some((uid, width))
}

pub async fn serve_files_route(
  config: Arc<Config>,
  db: &Arc<Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
  req: &Request<hyper::body::Incoming>,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  if req.method() == "OPTIONS" {
    debug!("Serving OPTIONS request, assuming CORS query.");
    return cors_response();
  }

  let session_user_id_maybe = match get_and_validate_session(&req, &db).await {
    Some(s) => Some(s.user_id),
    None => None,
  };

  let name = &req.uri().path()[7..];

  if let Some(uid) = name.strip_suffix("/text") {
    if !is_uid(uid) {
      return not_found_response();
    }
    match get_item_text(db, &session_user_id_maybe, uid).await {
      Ok(text_response) => text_response,
      Err(e) => {
        METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_FAILED]).inc();
        internal_server_error_response(&format!("get_item_text failed for '{}': {}", uid, e))
      }
    }
  } else if name.contains("/fragments/") {
    let Some((uid, ordinal)) = parse_item_fragment_route(name) else {
      return not_found_response();
    };
    match get_item_fragment(db, &session_user_id_maybe, uid, ordinal).await {
      Ok(fragment_response) => fragment_response,
      Err(e) => {
        METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_FAILED]).inc();
        internal_server_error_response(&format!("get_item_fragment failed for '{}': {}", uid, e))
      }
    }
  } else if let Some(uid) = name.strip_suffix("/fragments") {
    if !is_uid(uid) {
      return not_found_response();
    }
    match get_item_fragments(db, &session_user_id_maybe, uid).await {
      Ok(fragments_response) => fragments_response,
      Err(e) => {
        METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_FAILED]).inc();
        internal_server_error_response(&format!("get_item_fragments failed for '{}': {}", uid, e))
      }
    }
  } else if name.contains("_") {
    match get_cached_resized_img(config, db, object_store, image_cache, &session_user_id_maybe, name).await {
      Ok(img_response) => img_response,
      Err(e) => {
        METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_FAILED]).inc();
        internal_server_error_response(&format!("get_cached_resized_img failed for '{}': {}", name, e))
      }
    }
  } else {
    match get_file(config, db, object_store, &session_user_id_maybe, name).await {
      Ok(file_response) => file_response,
      Err(e) => {
        METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_FAILED]).inc();
        internal_server_error_response(&format!("get_file failed for '{}': {}", name, e))
      }
    }
  }
}

async fn get_cached_resized_img(
  config: Arc<Config>,
  db: &Arc<Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
  session_user_id_maybe: &Option<String>,
  name: &str,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  // TODO (MEDIUM): Consider browser side caching more in the case an image of different size than
  // that requested is returned. There would be a strategy that is better by some metric that more
  // heavily weights getting the exact requested size to the user. Such a strategy probably needs
  // to keep track of frequency of different sizes requested over time as well.

  let Some((uid, requested_width)) = parse_resized_image_name(name) else {
    return Ok(not_found_response());
  };
  let uid = uid.to_owned();

  let max_scale_image_down_percent =
    config.get_float(CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT).map_err(|e| e.to_string())?;
  let max_scale_image_up_percent = config.get_float(CONFIG_MAX_SCALE_IMAGE_UP_PERCENT).map_err(|e| e.to_string())?;

  let browser_cache_max_age_seconds =
    config.get_int(CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS).map_err(|e| e.to_string())?;
  let cache_control_value = calc_cache_control(browser_cache_max_age_seconds);

  let object_encryption_key;
  let original_dimensions_px;
  let original_mime_type_string; // TODO (LOW): validation.
  let owner_id;
  let title_maybe;
  {
    let db = db.lock().await;
    let item = match db.item.get(&uid) {
      Ok(item) => item,
      Err(_) => return Ok(not_found_response()),
    };
    if let Err(e) = authorize_item(&db, item, session_user_id_maybe, 0) {
      warn!("Denied resized image request for item '{}': {}", uid, e);
      return Ok(forbidden_response());
    }
    owner_id = item.owner_id.clone();
    title_maybe = item.title.clone();

    object_encryption_key =
      db.user.get(&item.owner_id).ok_or(format!("User '{}' not found.", item.owner_id))?.object_encryption_key.clone();
    original_dimensions_px =
      item.image_size_px.as_ref().ok_or("Image item does not have image dimensions set.")?.clone();
    original_mime_type_string = item.mime_type.as_ref().ok_or("Image item does not have mime type set.")?.clone();
  }
  if original_dimensions_px.w <= 0 || original_dimensions_px.h <= 0 {
    return Err(
      format!(
        "Image item '{}' has invalid dimensions: {}x{}.",
        uid, original_dimensions_px.w, original_dimensions_px.h
      )
      .into(),
    );
  }
  let filename = response_filename(&uid, title_maybe.as_deref());

  // Never want to upscale original image. Instead, want to respond with the original image without modification.
  let respond_with_cached_original = requested_width >= original_dimensions_px.w as u32;

  {
    if let Some(candidates) = storage_cache::keys_for_item_id(image_cache.clone(), &owner_id, &uid)? {
      let mut best_candidate_maybe = None;
      for candidate in candidates {
        match &candidate.size {
          ImageSize::Original => {
            if respond_with_cached_original {
              debug!("Responding with cached image '{}' (unmodified original).", candidate);
              let candidate_for_log = format!("{}", candidate);
              let data = match storage_cache::get(image_cache.clone(), &owner_id, candidate).await? {
                Some(data) => data,
                None => {
                  warn!("Image cache entry '{}' disappeared before it could be served.", candidate_for_log);
                  continue;
                }
              };
              METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_HIT_ORIG]).inc();
              let (content_type, content_disposition) = response_content_headers(&filename, &original_mime_type_string);
              return Ok(
                Response::builder()
                  .header(hyper::header::CONTENT_TYPE, content_type)
                  .header("Content-Disposition", content_disposition)
                  .header("X-Content-Type-Options", "nosniff")
                  .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
                  .body(full_body(data))
                  .unwrap(),
              );
            } else {
              // TODO (LOW): It's appropriate and more optimal to return + cache the original in other circumstances as well.
              continue;
            }
          }
          ImageSize::Width(candidate_width) => {
            let candidate_width = *candidate_width;
            if respond_with_cached_original {
              continue;
            }
            if (requested_width as f64 / candidate_width as f64) > (1.0 + max_scale_image_up_percent / 100.0) {
              continue;
            }
            if (requested_width as f64 / candidate_width as f64) < (1.0 - max_scale_image_down_percent / 100.0) {
              continue;
            }
            best_candidate_maybe = match best_candidate_maybe {
              None => Some((candidate, candidate_width)),
              Some(current_best_candidate) => {
                let current_deviation = (current_best_candidate.1 as i32 - requested_width as i32).abs();
                let new_deviation = (candidate_width as i32 - requested_width as i32).abs();
                if new_deviation < current_deviation {
                  Some((candidate, candidate_width))
                } else {
                  Some(current_best_candidate)
                }
              }
            };
          }
        }
      }
      match best_candidate_maybe {
        Some(best_candidate) => {
          debug!("Responding with cached image '{}'.", best_candidate.0);
          let metric_label = if format!("{}_{}", best_candidate.0.item_id, best_candidate.0.size) == name {
            LABEL_HIT_EXACT
          } else {
            LABEL_HIT_APPROX
          };
          let candidate_for_log = format!("{}", best_candidate.0);
          match storage_cache::get(image_cache.clone(), &owner_id, best_candidate.0).await? {
            Some(data) => {
              METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[metric_label]).inc();
              return Ok(
                Response::builder()
                  .header(hyper::header::CONTENT_TYPE, "image/jpeg")
                  .header("Content-Disposition", content_disposition_header(&uid, true))
                  .header("X-Content-Type-Options", "nosniff")
                  .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
                  .body(full_body(data))
                  .unwrap(),
              );
            }
            None => {
              warn!("Image cache entry '{}' disappeared before it could be served.", candidate_for_log);
            }
          };
        }
        None => {
          debug!("Cached image(s) for '{}' exist, but none are close enough to the required size.", uid);
        }
      }
    }
  }

  let original_file_bytes =
    object::get(object_store, owner_id.clone(), String::from(&uid), &object_encryption_key).await?;

  if respond_with_cached_original {
    let cache_key = ImageCacheKey { item_id: uid.clone(), size: ImageSize::Original };
    debug!("Caching then returning image '{}' (unmodified original).", cache_key);
    METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_ORIG]).inc();
    // it is possible there was more than one request for this, and another request won inserting into cache.
    storage_cache::put_if_not_exist(image_cache, &owner_id, cache_key, original_file_bytes.clone()).await?;
    let (content_type, content_disposition) = response_content_headers(&filename, &original_mime_type_string);
    return Ok(
      Response::builder()
        .header(hyper::header::CONTENT_TYPE, content_type)
        .header("Content-Disposition", content_disposition)
        .header("X-Content-Type-Options", "nosniff")
        .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
        .body(full_body(original_file_bytes))
        .unwrap(),
    );
  }

  let exif_orientation = get_exif_orientation(original_file_bytes.clone(), &uid);

  // decode and resize
  let original_file_cursor = Cursor::new(original_file_bytes.clone());
  let original_file_reader = ImageReader::new(original_file_cursor).with_guessed_format()?;
  let original_img_maybe = original_file_reader.decode();
  match original_img_maybe {
    Ok(mut img) => {
      img = adjust_image_for_exif_orientation(img, exif_orientation, &uid);

      // Calculate the height for passing into the image resize method. The resize method makes the image as large as possible
      // whilst preserving the image aspect ratio. So calculate the exact height, then bump it up a bit to be 100% sure width
      // is the constraining factor in that calc.
      let aspect = original_dimensions_px.w as f64 / original_dimensions_px.h as f64;
      let requested_height = (requested_width as f64 / aspect).ceil() as u32 + 1;

      // Using Langczos3 for down scaling, as recommended by: https://crates.io/crates/resize
      img = img.resize(requested_width, requested_height, FilterType::Lanczos3);
      // Throw away alpha channel, if it exists.
      let img = img.to_rgb8();

      let buf = Vec::new();
      let mut cursor = Cursor::new(buf);
      let encoder = JpegEncoder::new_with_quality(&mut cursor, JPEG_QUALITY);
      img
        .write_with_encoder(encoder)
        .map_err(|e| format!("Could not create cached JPEG image for '{}': {}", name, e))?;

      debug!("Inserting image '{}' into cache and using as response.", name);

      let cache_key = ImageCacheKey { item_id: uid.clone(), size: ImageSize::Width(requested_width) };
      let data = cursor.get_ref().to_vec();
      // it is possible there was more than one request for this, and another request won inserting into cache..
      storage_cache::put_if_not_exist(image_cache, &owner_id, cache_key, data.clone()).await.map_err(|e| {
        format!("Failed to insert image ({}, {}) into image cache: {}", uid, requested_width, e.message())
      })?;

      METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_CREATE]).inc();
      Ok(
        Response::builder()
          .header(hyper::header::CONTENT_TYPE, "image/jpeg")
          .header("Content-Disposition", content_disposition_header(&uid, true))
          .header("X-Content-Type-Options", "nosniff")
          .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
          .body(full_body(data))
          .unwrap(),
      )
    }

    Err(e) => {
      // TODO (LOW): possibly do something better in this case. Possibly return the image as is if it's not too big. Possibly cache it.
      return Err(format!("Could not read original image '{}': {}", name, e).into());
    }
  }
}

async fn get_file(
  config: Arc<Config>,
  db: &Arc<Mutex<Db>>,
  object_store: Arc<object::ObjectStore>,
  session_user_id_maybe: &Option<String>,
  uid: &str,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  if !is_uid(uid) {
    return Ok(not_found_response());
  }

  let (item, object_encryption_key) = {
    let db = db.lock().await;
    let item = match db.item.get(&String::from(uid)) {
      Ok(item) => item.clone(),
      Err(_) => return Ok(not_found_response()),
    };
    if let Err(e) = authorize_item(&db, &item, session_user_id_maybe, 0) {
      warn!("Denied file request for item '{}': {}", uid, e);
      return Ok(forbidden_response());
    }
    let object_encryption_key =
      db.user.get(&item.owner_id).ok_or(format!("User '{}' not found.", item.owner_id))?.object_encryption_key.clone();
    (item, object_encryption_key)
  };

  let mime_type_string = item.mime_type.as_ref().ok_or(format!("Mime type is not available for item '{}'.", uid))?;
  let filename = response_filename(uid, item.title.as_deref());

  // TODO (MEDIUM): Consider putting non-image files in the cache. Not highest priority though since
  // by default, configuration is such that these are cached browser side.
  let data = object::get(object_store, item.owner_id, String::from(uid), &object_encryption_key).await?;

  let browser_cache_max_age_seconds =
    config.get_int(CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS).map_err(|e| e.to_string())?;

  METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_FULL]).inc();

  let (content_type, content_disposition) = response_content_headers(&filename, mime_type_string);

  Ok(
    Response::builder()
      .header(hyper::header::CONTENT_TYPE, content_type)
      .header("Content-Disposition", content_disposition)
      .header("X-Content-Type-Options", "nosniff")
      .header(hyper::header::CACHE_CONTROL, calc_cache_control(browser_cache_max_age_seconds))
      .body(full_body(data))
      .unwrap(),
  )
}

async fn get_item_text(
  db: &Arc<Mutex<Db>>,
  session_user_id_maybe: &Option<String>,
  uid: &str,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  if !is_uid(uid) {
    return Ok(not_found_response());
  }

  let (item, data_dir) = {
    let db = db.lock().await;
    let item = match db.item.get(&String::from(uid)) {
      Ok(item) => item.clone(),
      Err(_) => return Ok(not_found_response()),
    };
    if let Err(e) = authorize_item(&db, &item, session_user_id_maybe, 0) {
      warn!("Denied generated text request for item '{}': {}", uid, e);
      return Ok(forbidden_response());
    }
    (item, db.item.data_dir().to_owned())
  };

  let manifest_path = item_text_manifest_path(&data_dir, &item.owner_id, uid)?;
  let manifest_bytes = match fs::read(&manifest_path).await {
    Ok(bytes) => bytes,
    Err(_) => return Ok(text_not_available_response()),
  };
  let manifest: ItemTextManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(text_not_available_response()),
  };
  if manifest.status != "succeeded" {
    return Ok(text_not_available_response());
  }

  let text_path = item_text_content_path(&data_dir, &item.owner_id, uid)?;
  let text_data = match fs::read(&text_path).await {
    Ok(bytes) => bytes,
    Err(_) => return Ok(text_not_available_response()),
  };

  let (data, response_mime_type) = if manifest.content_mime_type == "application/json"
    && is_supported_image_tagging_mime_type(item.mime_type.as_deref())
  {
    let geo_data = match fs::read(item_geo_content_path(&data_dir, &item.owner_id, uid)?).await {
      Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
      Err(_) => GEO_INFO_NOT_AVAILABLE_MESSAGE.to_owned(),
    };
    (format!("{}\n\n{}", String::from_utf8_lossy(&text_data), geo_data).into_bytes(), "text/plain".to_owned())
  } else {
    (text_data, manifest.content_mime_type.clone())
  };

  let filename = item_text_filename(uid, &response_mime_type);
  let (content_type, content_disposition) =
    response_content_headers_for_generated_item_text(&filename, &response_mime_type);

  Ok(
    Response::builder()
      .header(hyper::header::CONTENT_TYPE, content_type)
      .header("Content-Disposition", content_disposition)
      .header("X-Content-Type-Options", "nosniff")
      .header(hyper::header::CACHE_CONTROL, "no-cache")
      .body(full_body(data))
      .unwrap(),
  )
}

async fn get_item_fragments(
  db: &Arc<Mutex<Db>>,
  session_user_id_maybe: &Option<String>,
  uid: &str,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  if !is_uid(uid) {
    return Ok(not_found_response());
  }

  let (item, data_dir) = {
    let db = db.lock().await;
    let item = match db.item.get(&String::from(uid)) {
      Ok(item) => item.clone(),
      Err(_) => return Ok(not_found_response()),
    };
    if let Err(e) = authorize_item(&db, &item, session_user_id_maybe, 0) {
      warn!("Denied fragments request for item '{}': {}", uid, e);
      return Ok(forbidden_response());
    }
    (item, db.item.data_dir().to_owned())
  };

  if fs::metadata(item_fragments_manifest_path(&data_dir, &item.owner_id, uid)?).await.is_err() {
    return Ok(fragments_not_available_response());
  }

  let fragments_path = item_fragments_path(&data_dir, &item.owner_id, uid)?;
  let fragments_bytes = match fs::read(&fragments_path).await {
    Ok(bytes) => bytes,
    Err(_) => return Ok(fragments_not_available_response()),
  };

  let fragments_text = match parse_fragments_text(&fragments_bytes) {
    Ok(text) if !text.is_empty() => text,
    _ => return Ok(fragments_not_available_response()),
  };

  let filename = item_fragments_filename(uid);
  let (content_type, content_disposition) = response_content_headers_for_generated_item_text(&filename, "text/plain");

  Ok(
    Response::builder()
      .header(hyper::header::CONTENT_TYPE, content_type)
      .header("Content-Disposition", content_disposition)
      .header("X-Content-Type-Options", "nosniff")
      .header(hyper::header::CACHE_CONTROL, "no-cache")
      .body(full_body(fragments_text))
      .unwrap(),
  )
}

async fn get_item_fragment(
  db: &Arc<Mutex<Db>>,
  session_user_id_maybe: &Option<String>,
  uid: &str,
  ordinal: usize,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  if !is_uid(uid) {
    return Ok(not_found_response());
  }

  let (item, data_dir) = {
    let db = db.lock().await;
    let item = match db.item.get(&String::from(uid)) {
      Ok(item) => item.clone(),
      Err(_) => return Ok(not_found_response()),
    };
    if let Err(e) = authorize_item(&db, &item, session_user_id_maybe, 0) {
      warn!("Denied fragment request for item '{}': {}", uid, e);
      return Ok(forbidden_response());
    }
    (item, db.item.data_dir().to_owned())
  };

  if fs::metadata(item_fragments_manifest_path(&data_dir, &item.owner_id, uid)?).await.is_err() {
    return Ok(fragments_not_available_response());
  }

  let fragments_path = item_fragments_path(&data_dir, &item.owner_id, uid)?;
  let fragments_bytes = match fs::read(&fragments_path).await {
    Ok(bytes) => bytes,
    Err(_) => return Ok(fragments_not_available_response()),
  };

  let fragment_text = match parse_fragment_text(&fragments_bytes, ordinal) {
    Ok(Some(text)) if !text.is_empty() => text,
    _ => return Ok(fragments_not_available_response()),
  };

  let filename = item_fragment_filename(uid, ordinal);
  let (content_type, content_disposition) = response_content_headers_for_generated_item_text(&filename, "text/plain");

  Ok(
    Response::builder()
      .header(hyper::header::CONTENT_TYPE, content_type)
      .header("Content-Disposition", content_disposition)
      .header("X-Content-Type-Options", "nosniff")
      .header(hyper::header::CACHE_CONTROL, "no-cache")
      .body(full_body(fragment_text))
      .unwrap(),
  )
}

fn text_not_available_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
    .header("Content-Disposition", content_disposition_header("text", true))
    .header("X-Content-Type-Options", "nosniff")
    .header(hyper::header::CACHE_CONTROL, "no-cache")
    .body(full_body(TEXT_NOT_AVAILABLE_MESSAGE))
    .unwrap()
}

fn fragments_not_available_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
    .header("Content-Disposition", content_disposition_header("fragments", true))
    .header("X-Content-Type-Options", "nosniff")
    .header(hyper::header::CACHE_CONTROL, "no-cache")
    .body(full_body(FRAGMENTS_NOT_AVAILABLE_MESSAGE))
    .unwrap()
}

fn parse_fragments_text(data: &[u8]) -> InfuResult<Vec<u8>> {
  let mut fragments = parse_fragment_records(data)?;
  fragments.sort_by(|a, b| a.ordinal.cmp(&b.ordinal));
  let text = fragments
    .into_iter()
    .map(render_fragment_text)
    .filter(|fragment| !fragment.is_empty())
    .collect::<Vec<String>>()
    .join("");
  Ok(text.into_bytes())
}

fn parse_fragment_text(data: &[u8], ordinal: usize) -> InfuResult<Option<Vec<u8>>> {
  Ok(
    parse_fragment_records(data)?
      .into_iter()
      .find(|fragment| fragment.ordinal == ordinal)
      .map(|fragment| render_fragment_text(fragment).into_bytes()),
  )
}

fn parse_fragment_records(data: &[u8]) -> InfuResult<Vec<FragmentRecord>> {
  let mut fragments = vec![];
  for line in String::from_utf8_lossy(data).lines() {
    if line.trim().is_empty() {
      continue;
    }
    fragments.push(serde_json::from_str::<FragmentRecord>(line)?);
  }
  Ok(fragments)
}

fn parse_item_fragment_route(name: &str) -> Option<(&str, usize)> {
  let (uid, suffix) = name.split_once("/fragments/")?;
  if !is_uid(uid) || suffix.is_empty() || suffix.contains('/') {
    return None;
  }
  suffix.parse::<usize>().ok().map(|ordinal| (uid, ordinal))
}

fn render_fragment_text(fragment: FragmentRecord) -> String {
  let text = fragment.text.trim();
  let mut metadata = vec![format!("Ordinal: {}", fragment.ordinal)];
  if let Some(page_label) = fragment_page_label(fragment.page_start, fragment.page_end) {
    metadata.push(page_label);
  }
  format!("{FRAGMENT_VIEW_RULE}\n{}\n{FRAGMENT_VIEW_RULE}\n\n{text}\n\n\n", metadata.join("\n"))
}

fn fragment_page_label(page_start: Option<usize>, page_end: Option<usize>) -> Option<String> {
  match (page_start, page_end) {
    (Some(start), Some(end)) if start == end => Some(format!("Page: {start}")),
    (Some(start), Some(end)) => Some(format!("Pages: {start}-{end}")),
    _ => None,
  }
}

fn item_text_filename(uid: &str, content_mime_type: &str) -> String {
  let extension = match content_mime_type {
    "text/markdown" => ".md",
    "application/json" => ".json",
    "text/plain" => ".txt",
    _ => "",
  };
  format!("{}_text{}", uid, extension)
}

fn item_fragments_filename(uid: &str) -> String {
  format!("{}_fragments.txt", uid)
}

fn item_fragment_filename(uid: &str, ordinal: usize) -> String {
  format!("{}_fragment_{}.txt", uid, ordinal)
}

fn calc_cache_control(max_age: i64) -> String {
  if max_age == 0 { "no-cache".to_owned() } else { format!("private, max-age={}", max_age) }
}
