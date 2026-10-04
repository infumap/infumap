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

//! Background replacement of legacy (8x8 PNG) image item placeholders with ones created by
//! create_image_placeholder.
//!
//! Whether an item still needs to be processed is determined by its thumbnail field, so no other state is
//! kept: if the server is restarted, the backfill continues with the remaining items.

use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use base64::{Engine as _, engine::general_purpose};
use config::Config;
use image::ImageReader;
use infusdk::item::is_image_item;
use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use log::{error, info, warn};
use once_cell::sync::Lazy;
use prometheus::{IntCounterVec, opts};
use tokio::sync::{Mutex, Semaphore};
use tokio::task;

use crate::config::{CONFIG_ENABLE_IMAGE_PLACEHOLDER_BACKFILL, CONFIG_IMAGE_PLACEHOLDER_BACKFILL_MAX_ITEMS};
use crate::storage::cache::{self as storage_cache, ImageCache, ImageCacheKey, ImageSize};
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::util::image::{
  IMAGE_PROCESSING_SEMAPHORE, adjust_image_for_exif_orientation, create_image_placeholder, get_exif_orientation,
  is_legacy_image_placeholder,
};
use crate::web::routes::command::set_image_placeholder_if_legacy;

pub static METRIC_IMAGE_PLACEHOLDER_BACKFILL_TOTAL: Lazy<IntCounterVec> = Lazy::new(|| {
  IntCounterVec::new(
    opts!("image_placeholder_backfill_total", "Total number of image placeholder backfill outcomes."),
    &["name"],
  )
  .expect("Could not create METRIC_IMAGE_PLACEHOLDER_BACKFILL_TOTAL.")
});

const LABEL_FROM_CACHE: &'static str = "from_cache";
const LABEL_FROM_OBJECT_STORE: &'static str = "from_object_store";
const LABEL_SKIPPED: &'static str = "skipped";
const LABEL_FAILED: &'static str = "failed";

// Object store fetches are network bound, so a second worker can be fetching whilst the other is decoding.
const NUM_WORKERS: usize = 2;
// Smallest cached scaled down image that will be used as a source instead of fetching the original.
const MIN_CACHED_SOURCE_WIDTH_PX: u32 = 80;
const PROGRESS_LOG_INTERVAL: usize = 500;

struct Candidate {
  item_id: Uid,
  owner_id: Uid,
}

enum Outcome {
  FromCache,
  FromObjectStore,
  Skipped,
}

struct Progress {
  total: usize,
  from_cache: AtomicUsize,
  from_object_store: AtomicUsize,
  skipped: AtomicUsize,
  failed: AtomicUsize,
  start: Instant,
}

impl Progress {
  fn num_processed(&self) -> usize {
    self.from_cache.load(Ordering::Relaxed)
      + self.from_object_store.load(Ordering::Relaxed)
      + self.skipped.load(Ordering::Relaxed)
      + self.failed.load(Ordering::Relaxed)
  }

  fn summary(&self) -> String {
    let processed = self.num_processed();
    let elapsed_secs = self.start.elapsed().as_secs_f64();
    let rate = if elapsed_secs > 0.0 { processed as f64 / elapsed_secs } else { 0.0 };
    let remaining_mins = if rate > 0.0 { (self.total - processed) as f64 / rate / 60.0 } else { 0.0 };
    format!(
      "{}/{} processed ({} from cache, {} from object store, {} skipped, {} failed) in {:.0}s, {:.2}/s, ~{:.0} min remaining.",
      processed,
      self.total,
      self.from_cache.load(Ordering::Relaxed),
      self.from_object_store.load(Ordering::Relaxed),
      self.skipped.load(Ordering::Relaxed),
      self.failed.load(Ordering::Relaxed),
      elapsed_secs,
      rate,
      remaining_mins
    )
  }
}

pub fn init_image_placeholder_backfill(
  config: &Config,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  image_cache: Arc<std::sync::Mutex<ImageCache>>,
) -> InfuResult<()> {
  if !config.get_bool(CONFIG_ENABLE_IMAGE_PLACEHOLDER_BACKFILL).map_err(|e| e.to_string())? {
    return Ok(());
  }
  let max_items =
    usize::try_from(config.get_int(CONFIG_IMAGE_PLACEHOLDER_BACKFILL_MAX_ITEMS).map_err(|e| e.to_string())?)
      .map_err(|e| format!("Invalid {}: {}", CONFIG_IMAGE_PLACEHOLDER_BACKFILL_MAX_ITEMS, e))?;
  task::spawn(async move {
    if let Err(e) = run(db, object_store, image_cache, max_items).await {
      error!("Image placeholder backfill failed: {}", e);
    }
  });
  Ok(())
}

async fn run(
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  image_cache: Arc<std::sync::Mutex<ImageCache>>,
  max_items: usize,
) -> InfuResult<()> {
  // Newest first: these are the most likely to be viewed.
  let mut candidates = {
    let db = db.lock().await;
    let mut candidates = vec![];
    for key in db.item.all_loaded_items() {
      let item = db.item.get(&key.item_id)?;
      if is_image_item(item) && is_legacy_image_placeholder(item.thumbnail.as_deref()) {
        candidates.push((item.creation_date, Candidate { item_id: key.item_id, owner_id: key.user_id }));
      }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.into_iter().map(|(_, c)| c).collect::<Vec<Candidate>>()
  };
  if candidates.is_empty() {
    info!("Image placeholder backfill: there are no image items with a legacy placeholder.");
    return Ok(());
  }

  // Then, those that can be created from the image cache first: these are cheap, and were recently viewed.
  let mut from_cache = vec![];
  let mut other = vec![];
  for candidate in candidates.drain(..) {
    if cached_source_key(image_cache.clone(), &candidate)?.is_some() {
      from_cache.push(candidate);
    } else {
      other.push(candidate);
    }
  }
  let num_legacy = from_cache.len() + other.len();
  let mut queue: VecDeque<Candidate> = from_cache.into_iter().chain(other).collect();
  if max_items > 0 {
    queue.truncate(max_items);
  }
  info!(
    "Image placeholder backfill: {} image item(s) have a legacy placeholder, processing {} of them.",
    num_legacy,
    queue.len()
  );

  let progress = Arc::new(Progress {
    total: queue.len(),
    from_cache: AtomicUsize::new(0),
    from_object_store: AtomicUsize::new(0),
    skipped: AtomicUsize::new(0),
    failed: AtomicUsize::new(0),
    start: Instant::now(),
  });
  let queue = Arc::new(std::sync::Mutex::new(queue));
  // At most one of the workers decodes at a time, to limit the impact on the server.
  let decode_semaphore = Arc::new(Semaphore::new(1));

  let mut workers = vec![];
  for _ in 0..NUM_WORKERS {
    let db = db.clone();
    let object_store = object_store.clone();
    let image_cache = image_cache.clone();
    let queue = queue.clone();
    let progress = progress.clone();
    let decode_semaphore = decode_semaphore.clone();
    workers.push(task::spawn(async move {
      loop {
        let Some(candidate) = queue.lock().unwrap().pop_front() else { break };
        let result =
          process(db.clone(), object_store.clone(), image_cache.clone(), decode_semaphore.clone(), &candidate).await;
        let (counter, label) = match result {
          Ok(Outcome::FromCache) => (&progress.from_cache, LABEL_FROM_CACHE),
          Ok(Outcome::FromObjectStore) => (&progress.from_object_store, LABEL_FROM_OBJECT_STORE),
          Ok(Outcome::Skipped) => (&progress.skipped, LABEL_SKIPPED),
          Err(e) => {
            warn!("Image placeholder backfill: could not create placeholder for item '{}': {}", candidate.item_id, e);
            (&progress.failed, LABEL_FAILED)
          }
        };
        counter.fetch_add(1, Ordering::Relaxed);
        METRIC_IMAGE_PLACEHOLDER_BACKFILL_TOTAL.with_label_values(&[label]).inc();
        if progress.num_processed() % PROGRESS_LOG_INTERVAL == 0 {
          info!("Image placeholder backfill: {}", progress.summary());
        }
      }
    }));
  }
  for worker in workers {
    worker.await.map_err(|e| format!("Image placeholder backfill worker failed: {}", e))?;
  }

  info!("Image placeholder backfill complete: {}", progress.summary());
  if progress.failed.load(Ordering::Relaxed) > 0 {
    info!("Image placeholder backfill: failed items will be retried the next time the server starts.");
  }
  Ok(())
}

/// The key of a cached image that is a suitable source for creating a placeholder, if there is one. Prefer the
/// smallest scaled down image that is big enough, since it is the cheapest to decode.
fn cached_source_key(
  image_cache: Arc<std::sync::Mutex<ImageCache>>,
  candidate: &Candidate,
) -> InfuResult<Option<ImageCacheKey>> {
  let Some(keys) = storage_cache::keys_for_item_id(image_cache, &candidate.owner_id, &candidate.item_id)? else {
    return Ok(None);
  };
  let mut best_width_maybe = None;
  let mut has_original = false;
  for key in keys {
    match key.size {
      ImageSize::Width(w) if w >= MIN_CACHED_SOURCE_WIDTH_PX => {
        if best_width_maybe.map_or(true, |best| w < best) {
          best_width_maybe = Some(w);
        }
      }
      ImageSize::Width(_) => {}
      ImageSize::Original => has_original = true,
    }
  }
  let size = match best_width_maybe {
    Some(w) => ImageSize::Width(w),
    None if has_original => ImageSize::Original,
    None => return Ok(None),
  };
  Ok(Some(ImageCacheKey { item_id: candidate.item_id.clone(), size }))
}

async fn process(
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  image_cache: Arc<std::sync::Mutex<ImageCache>>,
  decode_semaphore: Arc<Semaphore>,
  candidate: &Candidate,
) -> InfuResult<Outcome> {
  let object_encryption_key = {
    let db = db.lock().await;
    let Ok(item) = db.item.get(&candidate.item_id) else { return Ok(Outcome::Skipped) };
    if !is_image_item(item) || !is_legacy_image_placeholder(item.thumbnail.as_deref()) {
      return Ok(Outcome::Skipped);
    }
    db.user.get(&item.owner_id).ok_or(format!("User '{}' not found.", item.owner_id))?.object_encryption_key.clone()
  };

  // Scaled down images in the cache have already been adjusted for EXIF orientation, and have no EXIF data, so
  // the same orientation handling is correct for them and for the original.
  let cached_maybe = match cached_source_key(image_cache.clone(), candidate)? {
    Some(key) => storage_cache::get(image_cache, &candidate.owner_id, key).await?,
    None => None,
  };
  let (bytes, outcome) = match cached_maybe {
    Some(bytes) => (bytes, Outcome::FromCache),
    None => (
      storage_object::get(object_store, candidate.owner_id.clone(), candidate.item_id.clone(), &object_encryption_key)
        .await?,
      Outcome::FromObjectStore,
    ),
  };

  // Permits are moved into the blocking task so they are held until the work completes.
  let decode_permit =
    decode_semaphore.acquire_owned().await.map_err(|e| format!("Backfill decode semaphore closed: {}", e))?;
  let processing_permit = IMAGE_PROCESSING_SEMAPHORE
    .clone()
    .acquire_owned()
    .await
    .map_err(|e| format!("Image processing semaphore closed: {}", e))?;
  let item_id = candidate.item_id.clone();
  let placeholder = task::spawn_blocking(move || -> InfuResult<Vec<u8>> {
    let _permits = (decode_permit, processing_permit);
    let exif_orientation = get_exif_orientation(bytes.clone(), &item_id);
    let img = ImageReader::new(Cursor::new(bytes))
      .with_guessed_format()?
      .decode()
      .map_err(|e| format!("Could not decode image: {}", e))?;
    let img = adjust_image_for_exif_orientation(img, exif_orientation, &item_id);
    create_image_placeholder(&img)
  })
  .await
  .map_err(|e| format!("Image processing task failed: {}", e))??;

  let thumbnail = general_purpose::STANDARD.encode(placeholder);
  let updated = {
    let mut db = db.lock().await;
    set_image_placeholder_if_legacy(&mut db, &candidate.item_id, thumbnail).await?
  };
  Ok(if updated { outcome } else { Outcome::Skipped })
}
