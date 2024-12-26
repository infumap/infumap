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
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::ImageReader;
use infusdk::util::infu::InfuResult;
use log::debug;
use once_cell::sync::Lazy;
use prometheus::{IntCounterVec, opts};
use std::io::Cursor;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::config::{CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT, CONFIG_MAX_SCALE_IMAGE_UP_PERCENT, CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS};
use crate::storage::db::Db;
use crate::storage::cache as storage_cache;
use crate::storage::cache::{ImageSize, ImageCacheKey};
use crate::storage::object;
use crate::util::image::{get_exif_orientation, adjust_image_for_exif_orientation};
use crate::web::serve::{full_body, internal_server_error_response, not_found_response, cors_response};
use crate::web::session::get_and_validate_session;

use super::command::authorize_item;


pub static METRIC_CACHED_IMAGE_REQUESTS_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(opts!(
    "cached_image_requests_total",
    "Total number of images served from cache."), &["name"])
      .expect("Could not create METRIC_CACHED_IMAGE_REQUESTS_TOTAL.")
});

const LABEL_HIT_APPROX: &'static str = "hit_approx";
const LABEL_HIT_EXACT: &'static str = "hit_exact";
const LABEL_HIT_ORIG: &'static str = "hit_orig";
const LABEL_MISS_ORIG: &'static str = "miss_orig";
const LABEL_MISS_CREATE: &'static str = "miss";

// 90 => very high-quality with significant reduction in file size.
// 80 => almost no loss of quality.
// 75 and below => starting to see significant loss in quality.
// TODO (LOW): Make this configurable.
const JPEG_QUALITY: u8 = 80;


pub async fn serve_files_route(
    config: Arc<Config>,
    db: &Arc<Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
    req: &Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {

  if req.method() == "OPTIONS" {
    debug!("Serving OPTIONS request, assuming CORS query.");
    return cors_response();
  }

  let session_user_id_maybe = match get_and_validate_session(&req, &db).await {
    Some(s) => Some(s.user_id),
    None => None
  };

  let name = &req.uri().path()[7..];

  if name.contains("_") {
    match get_cached_resized_img(config, db, object_store, image_cache, &session_user_id_maybe, name).await {
      Ok(img_response) => img_response,
      Err(e) => internal_server_error_response(&format!("get_cached_resized_img failed: {}", e))
    }
  } else {
    match get_file(config, db, object_store, &session_user_id_maybe, name).await {
      Ok(file_response) => file_response,
      Err(e) => internal_server_error_response(&format!("get_file failed: {}", e))
    }
  }
}


async fn get_cached_resized_img(
    config: Arc<Config>,
    db: &Arc<Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    image_cache: Arc<std::sync::Mutex<storage_cache::ImageCache>>,
    session_user_id_maybe: &Option<String>,
    name: &str) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {

  // TODO (MEDIUM): Consider browser side caching more in the case an image of different size than
  // that requested is returned. There would be a strategy that is better by some metric that more
  // heavily weights getting the exact requested size to the user. Such a strategy probably needs
  // to keep track of frequency of different sizes requested over time as well.

  let name_parts = name.split('_').collect::<Vec<&str>>();
  if name_parts.len() != 2 {
    return Ok(not_found_response());
  }

  let uid = name_parts.get(0).unwrap().to_string();
  // Second part in request name is always a number, though we may respond with '{uid}_original' from the image cache.
  let requested_width = name_parts.get(1).unwrap().to_string().parse::<u32>()?;

  let max_scale_image_down_percent = config.get_float(CONFIG_MAX_SCALE_IMAGE_DOWN_PERCENT).map_err(|e| e.to_string())?;
  let max_scale_image_up_percent = config.get_float(CONFIG_MAX_SCALE_IMAGE_UP_PERCENT).map_err(|e| e.to_string())?;

  let browser_cache_max_age_seconds = config.get_int(CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS).map_err(|e| e.to_string())?;
  let cache_control_value = calc_cache_control(browser_cache_max_age_seconds);

  let object_encryption_key;
  let original_dimensions_px;
  let original_mime_type_string; // TODO (LOW): validation.
  let owner_id;
  {
    let db = db.lock().await;
    let item = db.item.get(&String::from(&uid))?;
    authorize_item(&db, item, session_user_id_maybe, 0)?;
    owner_id = item.owner_id.clone();

    object_encryption_key = db.user.get(&item.owner_id).ok_or(format!("User '{}' not found.", item.owner_id))?.object_encryption_key.clone();
    original_dimensions_px = item.image_size_px.as_ref().ok_or("Image item does not have image dimensions set.")?.clone();
    original_mime_type_string = item.mime_type.as_ref().ok_or("Image item does not have mime type set.")?.clone();
  }

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
              METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_HIT_ORIG]).inc();
              let data = storage_cache::get(image_cache, &owner_id, candidate).await?.unwrap();
              return Ok(Response::builder()
                .header(hyper::header::CONTENT_TYPE, original_mime_type_string)
                .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
                .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
                .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
                .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                .body(full_body(data)).unwrap());
            } else {
              // TODO (LOW): It's appropriate and more optimal to return + cache the original in other circumstances as well.
              continue;
            }
          },
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
          if format!("{}_{}", best_candidate.0.item_id, best_candidate.0.size) == name {
            METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_HIT_EXACT]).inc();
          }
          else {
            METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_HIT_APPROX]).inc();
          }
          let data = storage_cache::get(image_cache, &owner_id, best_candidate.0).await?.unwrap();
          return Ok(Response::builder()
            .header(hyper::header::CONTENT_TYPE, "image/jpeg")
            .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
            .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
            .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
            .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .body(full_body(data)).unwrap());
        },
        None => {
          debug!("Cached image(s) for '{}' exist, but none are close enough to the required size.", uid);
        }
      }
    }
  }

  let original_file_bytes = object::get(object_store, owner_id.clone(), String::from(&uid), &object_encryption_key).await?;

  if respond_with_cached_original {
    let cache_key = ImageCacheKey { item_id: uid, size: ImageSize::Original };
    debug!("Caching then returning image '{}' (unmodified original).", cache_key);
    METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_ORIG]).inc();
    // it is possible there was more than one request for this, and another request won inserting into cache.
    storage_cache::put_if_not_exist(image_cache, &owner_id, cache_key, original_file_bytes.clone()).await?;
    return Ok(Response::builder()
      .header(hyper::header::CONTENT_TYPE, original_mime_type_string)
      .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
      .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
      .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
      .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
      .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
      .body(full_body(original_file_bytes)).unwrap());
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

      // Using Langczos3 for downscaling, as recommended by: https://crates.io/crates/resize
      img = img.resize(requested_width, requested_height, FilterType::Lanczos3);
      // Throw away alpha channel, if it exists.
      let img = img.to_rgb8();

      let buf = Vec::new();
      let mut cursor = Cursor::new(buf);
      let encoder = JpegEncoder::new_with_quality(&mut cursor, JPEG_QUALITY);
      img.write_with_encoder(encoder)
        .map_err(|e| format!("Could not create cached JPEG image for '{}': {}", name, e))?;

      debug!("Inserting image '{}' into cache and using as response.", name);

      let cache_key = ImageCacheKey { item_id: uid.clone(), size: ImageSize::Width(requested_width) };
      let data = cursor.get_ref().to_vec();
      // it is possible there was more than one request for this, and another request won inserting into cache..
      storage_cache::put_if_not_exist(image_cache, &owner_id, cache_key, data.clone()).await
        .map_err(|e| format!("Failed to insert image ({}, {}) into image cache: {}", uid, requested_width, e.message()))?;

      METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_CREATE]).inc();
      Ok(Response::builder()
        .header(hyper::header::CONTENT_TYPE, "image/jpeg")
        .header(hyper::header::CACHE_CONTROL, cache_control_value.clone())
        .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
        .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
        .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .body(full_body(data)).unwrap())
    },

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
    uid: &str) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {

  let (item, object_encryption_key) = {
    let db = db.lock().await;
    let item = db.item.get(&String::from(uid))?.clone();
    authorize_item(&db, &item, session_user_id_maybe, 0)?;
    let object_encryption_key =
      db.user.get(&item.owner_id).ok_or(format!("User '{}' not found.", item.owner_id))?.object_encryption_key.clone();
    (item, object_encryption_key)
  };

  let mime_type_string = item.mime_type.as_ref()
    .ok_or(format!("Mime type is not available for item '{}'.", uid))?;

  // TODO (MEDIUM): Consider putting non-image files in the cache. Not highest priority though since
  // by default, configuration is such that these are cached browser side.
  let data = object::get(object_store, item.owner_id, String::from(uid), &object_encryption_key).await?;

  let browser_cache_max_age_seconds = config.get_int(CONFIG_BROWSER_CACHE_MAX_AGE_SECONDS).map_err(|e| e.to_string())?;

  Ok(Response::builder()
    .header(hyper::header::CONTENT_TYPE, mime_type_string)
    .header(hyper::header::CACHE_CONTROL, calc_cache_control(browser_cache_max_age_seconds))
    .header(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(hyper::header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
    .header(hyper::header::ACCESS_CONTROL_MAX_AGE, "86400")
    .header(hyper::header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
    .body(full_body(data)).unwrap())
}


fn calc_cache_control(max_age: i64) -> String {
  if max_age == 0 {
    "no-cache".to_owned()
  }
  else {
    format!("private, max-age={}", max_age)
  }
}
