// Copyright (C) 2023 The Infumap Authors
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
use exif::Tag;
use http_body_util::combinators::BoxBody;
use hyper::{Request, Response};
use image::ImageOutputFormat;
use image::imageops::FilterType;
use image::io::Reader;
use log::debug;
use once_cell::sync::Lazy;
use prometheus::{IntCounterVec, opts};
use std::io::Cursor;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::config::{CONFIG_MAX_IMAGE_SIZE_DEVIATION_SMALLER_PERCENT, CONFIG_MAX_IMAGE_SIZE_DEVIATION_LARGER_PERCENT};
use crate::storage::db::Db;
use crate::storage::db::session::Session;
use crate::storage::cache::{ImageCache, ImageSize, ImageCacheKey};
use crate::storage::object;
use crate::util::infu::InfuResult;
use crate::web::serve::{full_body, internal_server_error_response, not_found_response, forbidden_response};
use crate::web::session::get_and_validate_session;


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
    db: &Arc<Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    image_cache: &Arc<Mutex<ImageCache>>,
    config: Arc<Config>,
    req: &Request<hyper::body::Incoming>) -> Response<BoxBody<Bytes, hyper::Error>> {

  let session = match get_and_validate_session(&req, &db).await {
    Some(s) => s,
    None => { return forbidden_response(); }
  };

  let name = &req.uri().path()[7..];

  if name.contains("_") {
    match get_cached_resized_img(config, db, object_store, image_cache, &session, name).await {
      Ok(img_response) => img_response,
      Err(e) => internal_server_error_response(&format!("get_cached_resized_img failed: {}", e))
    }
  } else {
    match get_file(db, object_store, &session, name).await {
      Ok(file_response) => file_response,
      Err(e) => internal_server_error_response(&format!("get_file failed: {}", e))
    }
  }
}


async fn get_cached_resized_img(
    config: Arc<Config>,
    db: &Arc<Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    image_cache: &Arc<Mutex<ImageCache>>,
    session: &Session,
    name: &str) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {

  let name_parts = name.split('_').collect::<Vec<&str>>();
  if name_parts.len() != 2 {
    return Ok(not_found_response());
  }

  let uid = name_parts.get(0).unwrap().to_string();
  // Second part in request name is always a number, though we may respond with '{uid}_original' from the image cache.
  let requested_width = name_parts.get(1).unwrap().to_string().parse::<u32>()?;

  let max_image_size_deviation_smaller_percent;
  let max_image_size_deviation_larger_percent;
  {
    max_image_size_deviation_larger_percent = config.get_float(CONFIG_MAX_IMAGE_SIZE_DEVIATION_LARGER_PERCENT)?;
    max_image_size_deviation_smaller_percent = config.get_float(CONFIG_MAX_IMAGE_SIZE_DEVIATION_SMALLER_PERCENT)?;
  }

  let object_encryption_key;
  let original_dimensions_px;
  let original_mime_type_string; // TODO (LOW): validation.
  {
    let db = db.lock().await;
    let item = db.item.get(&String::from(&uid))?;
    if item.owner_id != session.user_id {
      return Err(format!("File owner {} does match session user '{}'.", item.owner_id, session.user_id).into());
    }
    object_encryption_key = db.user.get(&item.owner_id).ok_or(format!("User '{}' not found.", item.owner_id))?.object_encryption_key.clone();
    original_dimensions_px = item.image_size_px.as_ref().ok_or("Image item does not have image dimensions set.")?.clone();
    original_mime_type_string = item.mime_type.as_ref().ok_or("Image item does not have mime tyoe set.")?.clone();
  }

  // Never want to upscale. Instead, want to respond with the original image without modification.
  let respond_with_cached_original = requested_width >= original_dimensions_px.w as u32;

  {
    let mut image_cache = image_cache.lock().await;
    if let Some(candidates) = image_cache.keys_for_item_id(&session.user_id, &uid)? {
      let mut best_candidate_maybe = None;
      for candidate in candidates {
        match &candidate.size {
          ImageSize::Original => {
            if respond_with_cached_original {
              debug!("Returning cached image '{}' (unmodified original) as response to request for '{}'.", candidate, name);
              METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_HIT_ORIG]).inc();
              let data = image_cache.get(&session.user_id, candidate).await?.unwrap();
              return Ok(Response::builder()
                .header(hyper::header::CONTENT_TYPE, original_mime_type_string)
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
            if candidate_width as f64 / requested_width as f64 > (1.0 + max_image_size_deviation_larger_percent / 100.0) {
              continue;
            }
            if (candidate_width as f64 / requested_width as f64) < (1.0 - max_image_size_deviation_smaller_percent / 100.0) {
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
          debug!("Using cached image '{}' to respond to request for '{}'.", best_candidate.0, name);
          if format!("{}_{}", best_candidate.0.item_id, best_candidate.0.size) == name {
            METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_HIT_EXACT]).inc();
          }
          else {
            METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_HIT_APPROX]).inc();
          }
          let data = image_cache.get(&session.user_id, best_candidate.0).await?.unwrap();
          return Ok(Response::builder()
            .header(hyper::header::CONTENT_TYPE, "image/jpeg")
            .body(full_body(data)).unwrap());
        },
        None => {
          debug!("Cached image(s) for '{}' exist, but none are close enough to the required size.", uid);
        }
      }
    }
  }

  let original_file_bytes = object::get(object_store, &session.user_id, &String::from(&uid), &object_encryption_key).await?;

  if respond_with_cached_original {
    let cache_key = ImageCacheKey { item_id: uid, size: ImageSize::Original };
    debug!("Caching then returning image '{}' (unmodified original) to respond to request for '{}'.", cache_key, name);
    METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_ORIG]).inc();
    image_cache.lock().await.put(&session.user_id, cache_key, original_file_bytes.clone()).await?;
    return Ok(Response::builder()
      .header(hyper::header::CONTENT_TYPE, original_mime_type_string)
      .body(full_body(original_file_bytes)).unwrap());
  }

  // get orientation
  let mut original_file_cursor = Cursor::new(original_file_bytes.clone());
  let exifreader = exif::Reader::new();
  let exif_orientation = match exifreader.read_from_container(&mut original_file_cursor) {
    Ok(exif) => match exif.fields().find(|f| f.tag == Tag::Orientation) {
      Some(o) => {
        match &o.value {
          exif::Value::Short(s) => {
            match s.get(0) {
              Some(s) => *s,
              None => {
                debug!("EXIF Orientation value present but not present for image '{}', ignoring.", uid);
                1
              }
            }
          },
          _ => {
            debug!("EXIF Orientation value present but does not have type Short for image '{}', ignoring.", uid);
            1
          }
        }
      }
      None => 0
    },
    Err(_e) => { 1 }
  };

  // decode and resize
  let original_file_cursor = Cursor::new(original_file_bytes.clone());
  let original_file_reader = Reader::new(original_file_cursor).with_guessed_format()?;
  let original_img_maybe = original_file_reader.decode();
  match original_img_maybe {
    Ok(mut img) => {
      // Good overview on exif rotation values here: https://sirv.com/help/articles/rotate-photos-to-be-upright/
      // 1 = 0 degrees: the correct orientation, no adjustment is required.
      // 2 = 0 degrees, mirrored: image has been flipped back-to-front.
      // 3 = 180 degrees: image is upside down.
      // 4 = 180 degrees, mirrored: image has been flipped back-to-front and is upside down.
      // 5 = 90 degrees: image has been flipped back-to-front and is on its side.
      // 6 = 90 degrees, mirrored: image is on its side.
      // 7 = 270 degrees: image has been flipped back-to-front and is on its far side.
      // 8 = 270 degrees, mirrored: image is on its far side.
      match exif_orientation {
        0 => {}, // Invalid, but silently ignore. It's relatively common.
        1 => {},
        2 => { img = img.fliph(); }
        3 => { img = img.rotate180(); }
        4 => { img = img.fliph(); img = img.rotate180(); }
        5 => { img = img.rotate90(); img = img.fliph(); }
        6 => { img = img.rotate90(); }
        7 => { img = img.rotate270(); img = img.fliph(); }
        8 => { img = img.rotate270(); }
        o => {
          debug!("Unexpected EXIF orientation {} for image '{}'.", o, uid);
        }
      }

      // Calculate the height for passing into the image resize method. The resize method makes the image as large as possible
      // whilst preseving the image aspect ratio. So calculate the exact height, then bump it up a bit to be 100% sure width
      // is the constraining factor in that calc.
      let aspect = original_dimensions_px.w as f64 / original_dimensions_px.h as f64;
      let requested_height = (requested_width as f64 / aspect).ceil() as u32 + 1;

      // Using Langczos3 for downscaling, as recommended by: https://crates.io/crates/resize
      img = img.resize(requested_width, requested_height, FilterType::Lanczos3);

      let buf = Vec::new();
      let mut cursor = Cursor::new(buf);
      img.write_to(&mut cursor, ImageOutputFormat::Jpeg(JPEG_QUALITY))
        .map_err(|e| format!("Could not create cached JPEG image for '{}': {}", name, e))?;

      debug!("Inserting image '{}' into cache", name);

      let cache_key = ImageCacheKey { item_id: uid, size: ImageSize::Width(requested_width) };
      let data = cursor.get_ref().to_vec();
      image_cache.lock().await.put(&session.user_id, cache_key, data.clone()).await?;

      METRIC_CACHED_IMAGE_REQUESTS_TOTAL.with_label_values(&[LABEL_MISS_CREATE]).inc();
      Ok(Response::builder()
        .header(hyper::header::CONTENT_TYPE, "image/jpeg")
        .body(full_body(data)).unwrap())
    },

    Err(e) => {
      // TODO (LOW): possibly do something better in this case. Possibly return the image as is if it's not too big. Possibly cache it.
      return Err(format!("Could not read original image '{}': {}", name, e).into());
    }
  }
}


async fn get_file(
    db: &Arc<Mutex<Db>>,
    object_store: Arc<object::ObjectStore>,
    session: &Session,
    uid: &str) -> InfuResult<Response<BoxBody<Bytes, hyper::Error>>> {
  let db = db.lock().await;

  let item = db.item.get(&String::from(uid))?;
  if item.owner_id != session.user_id {
    return Err(format!("File owner {} does match session user '{}'.", item.owner_id, session.user_id).into());
  }

  let mime_type_string = item.mime_type.as_ref().ok_or(format!("Mime type is not available for item '{}'.", uid))?;

  let object_encryption_key = &db.user.get(&item.owner_id).ok_or(format!("User '{}' not found.", item.owner_id))?.object_encryption_key;

  let data = object::get(object_store, &session.user_id, &String::from(uid), object_encryption_key).await?;
  Ok(Response::builder().header(hyper::header::CONTENT_TYPE, mime_type_string).body(full_body(data)).unwrap())
}
