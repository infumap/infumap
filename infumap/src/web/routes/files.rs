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
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response};
use image::ImageReader;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use infusdk::util::geometry::Dimensions;
use infusdk::util::infu::InfuResult;
use infusdk::util::time::unix_now_secs_i64;
use infusdk::util::uid::is_uid;
use log::{debug, warn};
use once_cell::sync::Lazy;
use prometheus::{IntCounterVec, opts};
use serde::Deserialize;
use std::collections::HashMap;
use std::future::Future;
use std::io::Cursor;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::spawn_blocking;

use crate::ai::artifact_paths::{
  item_fragments_manifest_path, item_fragments_path, item_geo_content_path, item_text_content_path,
  item_text_manifest_path,
};
use crate::ai::image_tagging::is_supported_image_tagging_mime_type;
use crate::ai::search_activity::{Phase, item_activity, user_summary};
use crate::ai::search_processing::SearchContentKind;
use crate::config::{
  CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS, CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT, CONFIG_MAX_SCALE_IMAGE_UP_PERCENT,
};
use crate::storage::cache as storage_cache;
use crate::storage::cache::{ImageCacheKey, ImageSize};
use crate::storage::db::Db;
use crate::storage::object;
use crate::util::image::{IMAGE_PROCESSING_SEMAPHORE, adjust_image_for_exif_orientation, get_exif_orientation};
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
const LABEL_MISS_SHARED: &'static str = "miss_shared";
const LABEL_PARTIAL: &'static str = "partial";
const LABEL_PENDING: &'static str = "pending";
const LABEL_FULL: &'static str = "full";
const LABEL_FAILED: &'static str = "failed";
/// Request header: the client does not want to wait for the requested rendition of an image to be generated. If it is
/// not cached, the response is a smaller cached rendition (marked with PARTIAL_IMAGE_HEADER_NAME) if there is one, else
/// 202 (pending). Either way, generation is started, and a request without this header waits for it. This lets the
/// client get everything that is fast to serve before waiting on anything slow.
pub const DEFER_IMAGE_HEADER_NAME: &str = "x-infumap-image-defer";
/// Response header marking a response as a smaller rendition of an image than requested. See partial_image_response.
pub const PARTIAL_IMAGE_HEADER_NAME: &str = "x-infumap-partial-image";

/// Bounds the number of image jobs (object store fetch + resize) in progress, and hence the memory used by original
/// images held at once. Jobs beyond this queue in the order they were started.
static IMAGE_JOB_SEMAPHORE: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(4)));

/// Request header (with DEFER_IMAGE_HEADER_NAME): the image is wanted ahead of everything else, e.g. it is in a popup.
/// Its job does not queue behind other image jobs, or for the image processing semaphore. Such jobs are separately
/// bounded by HIGH_PRIORITY_IMAGE_JOB_SEMAPHORE.
pub const HIGH_PRIORITY_IMAGE_HEADER_NAME: &str = "x-infumap-image-priority-high";
static HIGH_PRIORITY_IMAGE_JOB_SEMAPHORE: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(2)));
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
  } else if let Some(uid) = name.strip_suffix("/search-status") {
    if !is_uid(uid) {
      return not_found_response();
    }
    match get_item_search_status(db, &session_user_id_maybe, uid).await {
      Ok(status_response) => status_response,
      Err(e) => internal_server_error_response(&format!("get_item_search_status failed for '{}': {}", uid, e)),
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
    let defer = req.headers().contains_key(DEFER_IMAGE_HEADER_NAME);
    let high_priority = req.headers().contains_key(HIGH_PRIORITY_IMAGE_HEADER_NAME);
    match get_cached_resized_img(
      config,
      db,
      object_store,
      image_cache,
      &session_user_id_maybe,
      name,
      defer,
      high_priority,
    )
    .await
    {
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
  defer: bool,
  high_priority: bool,
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

  // The largest cached rendition too small to be the response. It can be sent as a partial response whilst the
  // requested rendition is generated.
  let mut smaller_width_maybe: Option<u32> = None;

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
              return Ok(original_image_response(data, &filename, &original_mime_type_string, &cache_control_value));
            } else {
              // TODO (LOW): It's appropriate and more optimal to return + cache the original in other circumstances as well.
              continue;
            }
          }
          ImageSize::Width(candidate_width) => {
            let candidate_width = *candidate_width;
            if respond_with_cached_original
              || (requested_width as f64 / candidate_width as f64) > (1.0 + max_scale_image_up_percent / 100.0)
            {
              // Resized renditions are always smaller than the original, so in the original case, all are too small.
              if smaller_width_maybe.map_or(true, |w| candidate_width > w) {
                smaller_width_maybe = Some(candidate_width);
              }
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
              return Ok(resized_image_response(data, &uid, &cache_control_value));
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

  let job_key = ImageCacheKey {
    item_id: uid.clone(),
    size: if respond_with_cached_original { ImageSize::Original } else { ImageSize::Width(requested_width) },
  }
  .to_string();
  let (job, job_was_started) = IMAGE_JOBS.get_or_start(
    job_key,
    fetch_and_cache_image(
      object_store,
      image_cache.clone(),
      owner_id.clone(),
      uid.clone(),
      object_encryption_key,
      original_dimensions_px,
      if respond_with_cached_original { None } else { Some(requested_width) },
      high_priority,
    ),
  );

  if defer {
    if let Some(smaller_width) = smaller_width_maybe {
      let smaller_key = ImageCacheKey { item_id: uid.clone(), size: ImageSize::Width(smaller_width) };
      if let Some(data) = storage_cache::get(image_cache.clone(), &owner_id, smaller_key).await? {
        debug!("Responding with partial image '{}_{}' whilst '{}' is generated.", uid, smaller_width, name);
        METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_PARTIAL]).inc();
        return Ok(partial_image_response(data, &uid));
      }
    }
    debug!("Responding with pending for '{}' whilst it is generated.", name);
    METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_PENDING]).inc();
    return Ok(pending_image_response());
  }
  if !job_was_started {
    METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_SHARED]).inc();
  }

  let data = job.await.map_err(|e| format!("Image job for '{}' failed: {}", name, e))?;
  if respond_with_cached_original {
    Ok(original_image_response(data, &filename, &original_mime_type_string, &cache_control_value))
  } else {
    Ok(resized_image_response(data, &uid, &cache_control_value))
  }
}

fn original_image_response<T: Into<Bytes>>(
  data: T,
  filename: &str,
  original_mime_type: &str,
  cache_control_value: &str,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  let (content_type, content_disposition) = response_content_headers(filename, original_mime_type);
  Response::builder()
    .header(hyper::header::CONTENT_TYPE, content_type)
    .header("Content-Disposition", content_disposition)
    .header("X-Content-Type-Options", "nosniff")
    .header(hyper::header::CACHE_CONTROL, cache_control_value)
    .body(full_body(data))
    .unwrap()
}

fn resized_image_response<T: Into<Bytes>>(
  data: T,
  uid: &str,
  cache_control_value: &str,
) -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .header(hyper::header::CONTENT_TYPE, "image/jpeg")
    .header("Content-Disposition", content_disposition_header(uid, true))
    .header("X-Content-Type-Options", "nosniff")
    .header(hyper::header::CACHE_CONTROL, cache_control_value)
    .body(full_body(data))
    .unwrap()
}

/// A smaller rendition than requested, sent whilst the requested one is generated. It must not be cached by the
/// browser, since it is not what the url refers to.
fn partial_image_response(data: Vec<u8>, uid: &str) -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .header(hyper::header::CONTENT_TYPE, "image/jpeg")
    .header("Content-Disposition", content_disposition_header(uid, true))
    .header("X-Content-Type-Options", "nosniff")
    .header(hyper::header::CACHE_CONTROL, "no-store")
    .header(PARTIAL_IMAGE_HEADER_NAME, "1")
    .body(full_body(data))
    .unwrap()
}

/// No rendition of the image is available yet, but one is being generated. Not to be cached by the browser.
fn pending_image_response() -> Response<BoxBody<Bytes, hyper::Error>> {
  Response::builder()
    .status(hyper::StatusCode::ACCEPTED)
    .header(hyper::header::CACHE_CONTROL, "no-store")
    .body(full_body(Bytes::new()))
    .unwrap()
}

/// Fetches the original image from the object store, resizes it to requested_width_maybe (None => the unmodified
/// original), and inserts the result into the image cache. See HIGH_PRIORITY_IMAGE_HEADER_NAME for high_priority.
async fn fetch_and_cache_image(
  object_store: Arc<object::ObjectStore>,
  image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
  owner_id: String,
  uid: String,
  object_encryption_key: String,
  original_dimensions_px: Dimensions<i64>,
  requested_width_maybe: Option<u32>,
  high_priority: bool,
) -> Result<Bytes, String> {
  let job_semaphore =
    if high_priority { HIGH_PRIORITY_IMAGE_JOB_SEMAPHORE.clone() } else { IMAGE_JOB_SEMAPHORE.clone() };
  let _job_permit = job_semaphore.acquire_owned().await.map_err(|e| format!("Image job semaphore closed: {}", e))?;
  let original_file_bytes = object::get(object_store, owner_id.clone(), uid.clone(), &object_encryption_key)
    .await
    .map_err(|e| e.to_string())?;

  let (cache_key, data) = match requested_width_maybe {
    None => {
      METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_ORIG]).inc();
      (ImageCacheKey { item_id: uid.clone(), size: ImageSize::Original }, original_file_bytes)
    }
    Some(requested_width) => {
      // The permit is moved into the blocking task so it is held until the work completes.
      let permit = if high_priority {
        None
      } else {
        Some(
          IMAGE_PROCESSING_SEMAPHORE
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| format!("Image resize semaphore closed: {}", e))?,
        )
      };
      let uid_for_resize = uid.clone();
      let name = format!("{}_{}", uid, requested_width);
      let data = spawn_blocking(move || {
        let _permit = permit;
        resize_image_to_jpeg(original_file_bytes, &uid_for_resize, &name, original_dimensions_px, requested_width)
      })
      .await
      .map_err(|e| format!("Image resize task failed: {}", e))?
      .map_err(|e| e.to_string())?;
      METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_CREATE]).inc();
      (ImageCacheKey { item_id: uid.clone(), size: ImageSize::Width(requested_width) }, data)
    }
  };

  debug!("Inserting image '{}' into cache.", cache_key);
  let cache_key_for_log = cache_key.to_string();
  // it is possible another request (e.g. from before a restart, or for an approximate size) inserted this already.
  storage_cache::put_if_not_exist(image_cache, &owner_id, cache_key, data.clone())
    .await
    .map_err(|e| format!("Failed to insert image '{}' into image cache: {}", cache_key_for_log, e.message()))?;
  Ok(Bytes::from(data))
}

type ImageJob = Shared<BoxFuture<'static, Result<Bytes, String>>>;

/// Image renditions currently being fetched / generated, keyed by cache key. Concurrent requests for the same
/// rendition share one job. Jobs run as tasks, so they complete (and their result is cached) even if no request is
/// waiting on them any more, e.g. after a partial response, or a client disconnect.
struct ImageJobs {
  jobs: std::sync::Mutex<HashMap<String, ImageJob>>,
}

static IMAGE_JOBS: Lazy<Arc<ImageJobs>> = Lazy::new(|| Arc::new(ImageJobs::new()));

impl ImageJobs {
  fn new() -> ImageJobs {
    ImageJobs { jobs: std::sync::Mutex::new(HashMap::new()) }
  }

  /// Returns the job in progress for key if there is one, else starts one that runs work. The bool is true if the
  /// job was started by this call.
  fn get_or_start<F>(self: &Arc<Self>, key: String, work: F) -> (ImageJob, bool)
  where
    F: Future<Output = Result<Bytes, String>> + Send + 'static,
  {
    let mut jobs = self.jobs.lock().unwrap();
    if let Some(job) = jobs.get(&key) {
      return (job.clone(), false);
    }
    // Removes the job when the task ends, including if it panics.
    struct RemoveOnDrop {
      jobs: Arc<ImageJobs>,
      key: String,
    }
    impl Drop for RemoveOnDrop {
      fn drop(&mut self) {
        self.jobs.jobs.lock().unwrap().remove(&self.key);
      }
    }
    let remove_on_drop = RemoveOnDrop { jobs: self.clone(), key: key.clone() };
    // The lock is held until the job is inserted, so the task cannot remove it before then.
    let handle = tokio::spawn(async move {
      let _remove_on_drop = remove_on_drop;
      work.await
    });
    let job =
      async move { handle.await.unwrap_or_else(|e| Err(format!("Image job task failed: {}", e))) }.boxed().shared();
    jobs.insert(key, job.clone());
    (job, true)
  }
}

/// CPU intensive - must not be called on an async worker thread.
fn resize_image_to_jpeg(
  original_file_bytes: Vec<u8>,
  uid: &str,
  name: &str,
  original_dimensions_px: Dimensions<i64>,
  requested_width: u32,
) -> InfuResult<Vec<u8>> {
  let exif_orientation = get_exif_orientation(original_file_bytes.clone(), uid);

  // decode and resize
  let original_file_cursor = Cursor::new(original_file_bytes);
  let original_file_reader = ImageReader::new(original_file_cursor).with_guessed_format()?;
  let mut img = match original_file_reader.decode() {
    Ok(img) => img,
    Err(e) => {
      // TODO (LOW): possibly do something better in this case. Possibly return the image as is if it's not too big. Possibly cache it.
      return Err(format!("Could not read original image '{}': {}", name, e).into());
    }
  };
  img = adjust_image_for_exif_orientation(img, exif_orientation, uid);

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
  img.write_with_encoder(encoder).map_err(|e| format!("Could not create cached JPEG image for '{}': {}", name, e))?;

  Ok(cursor.into_inner())
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

/// Current outstanding search work for one item, as reported by the workers.
async fn get_item_search_status(
  db: &Arc<Mutex<Db>>,
  session_user_id_maybe: &Option<String>,
  uid: &str,
) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  let item = {
    let db = db.lock().await;
    let item = match db.item.get(&String::from(uid)) {
      Ok(item) => item.clone(),
      Err(_) => return Ok(not_found_response()),
    };
    if let Err(e) = authorize_item(&db, &item, session_user_id_maybe, 0) {
      warn!("Denied search status request for item '{}': {}", uid, e);
      return Ok(forbidden_response());
    }
    item
  };

  let content = match SearchContentKind::from_mime_type(item.mime_type.as_deref()) {
    Some(SearchContentKind::Pdf) => "PDF",
    Some(SearchContentKind::Image) => "image",
    Some(SearchContentKind::Markdown) => "Markdown",
    Some(SearchContentKind::Text) => "plain text",
    None => "not supported (title only)",
  };
  let mut lines =
    vec![format!("Search status: {}", item.title.as_deref().unwrap_or(uid)), format!("Content: {}", content)];
  let now = unix_now_secs_i64().unwrap_or(0);
  let stages = item_activity(&item.owner_id, uid);
  for stage in &stages {
    let phase = match stage.phase {
      Phase::Queued => "queued",
      Phase::Processing => "processing",
      Phase::Waiting => "waiting",
      Phase::NeedsAttention => "needs attention",
    };
    lines.push(String::new());
    lines.push(format!("{}: {}", stage.label, phase));
    if let Some(detail) = &stage.detail {
      lines.push(format!("  {}", detail));
    }
    if let Some(retry_at) = stage.retry_at_unix_secs {
      lines.push(format!("  Next attempt in about {} minute(s).", ((retry_at - now).max(0) + 59) / 60));
    }
  }
  if stages.is_empty() {
    lines.push(String::new());
    lines.push(if user_summary(&item.owner_id).checking {
      "Startup checks are still running; outstanding work may not be listed yet.".to_owned()
    } else {
      "No outstanding search processing.".to_owned()
    });
  }
  lines.push(String::new());

  Ok(
    Response::builder()
      .header(hyper::header::CONTENT_TYPE, "text/plain; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .header(hyper::header::CACHE_CONTROL, "no-cache")
      .body(full_body(lines.join("\n")))
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use tokio::sync::oneshot;

  fn job_count(jobs: &Arc<ImageJobs>) -> usize {
    jobs.jobs.lock().unwrap().len()
  }

  #[tokio::test]
  async fn concurrent_requests_share_one_job() {
    let jobs = Arc::new(ImageJobs::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = oneshot::channel::<()>();

    let runs_for_work = runs.clone();
    let (job1, started1) = jobs.get_or_start("a_100".to_owned(), async move {
      runs_for_work.fetch_add(1, Ordering::SeqCst);
      rx.await.unwrap();
      Ok(Bytes::from_static(b"data"))
    });
    let runs_for_work = runs.clone();
    let (job2, started2) = jobs.get_or_start("a_100".to_owned(), async move {
      runs_for_work.fetch_add(1, Ordering::SeqCst);
      Ok(Bytes::from_static(b"other"))
    });
    assert!(started1);
    assert!(!started2);

    tx.send(()).unwrap();
    assert_eq!(job1.await.unwrap(), Bytes::from_static(b"data"));
    assert_eq!(job2.await.unwrap(), Bytes::from_static(b"data"));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
  }

  #[tokio::test]
  async fn job_is_removed_when_complete() {
    let jobs = Arc::new(ImageJobs::new());
    let (job, _) = jobs.get_or_start("a_100".to_owned(), async { Ok(Bytes::from_static(b"data")) });
    job.await.unwrap();
    assert_eq!(job_count(&jobs), 0);
    let (_, started) = jobs.get_or_start("a_100".to_owned(), async { Ok(Bytes::from_static(b"data")) });
    assert!(started);
  }

  #[tokio::test]
  async fn job_runs_to_completion_when_not_awaited() {
    let jobs = Arc::new(ImageJobs::new());
    let (tx, rx) = oneshot::channel::<()>();
    let (job, _) = jobs.get_or_start("a_100".to_owned(), async move {
      tx.send(()).unwrap();
      Ok(Bytes::from_static(b"data"))
    });
    drop(job);
    rx.await.unwrap();
  }

  #[tokio::test]
  async fn failed_job_reports_error_and_is_removed() {
    let jobs = Arc::new(ImageJobs::new());
    let (job, _) = jobs.get_or_start("a_100".to_owned(), async { Err("failed".to_owned()) });
    assert_eq!(job.await.unwrap_err(), "failed");
    assert_eq!(job_count(&jobs), 0);
  }

  #[tokio::test]
  async fn panicked_job_reports_error_and_is_removed() {
    let jobs = Arc::new(ImageJobs::new());
    let (job, _) = jobs.get_or_start("a_100".to_owned(), async {
      if true {
        panic!("deliberate test panic");
      }
      Ok(Bytes::new())
    });
    assert!(job.await.unwrap_err().starts_with("Image job task failed"));
    assert_eq!(job_count(&jobs), 0);
  }
}
