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

use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{error, info};
use once_cell::sync::OnceCell;
use reqwest::multipart::{Form, Part};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::{task, time};

use crate::config::{CONFIG_DATA_DIR, CONFIG_IMAGE_TAGGING_URL};
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::util::image::extract_image_metadata;
use crate::util::retry::endpoint_retry_delay;

mod artifacts;

#[allow(unused_imports)]
pub use artifacts::FailedImageTagInfo;
pub use artifacts::{delete_item_image_tag_dir, item_needs_image_tagging, list_failed_images};

use self::artifacts::{
  ImageTagArtifact, ManifestCheckResult, clear_item_image_tag_dir, manifest_check, write_failed_manifest,
  write_success_artifacts,
};

const IDLE_POLL_SECS: u64 = 60;
const REQUEST_TIMEOUT_SECS: u64 = 30 * 60;
const LARGE_IMAGE_SIZE_BYTES: i64 = 10 * 1024 * 1024;
const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const MAX_RESPONSE_FORMAT_RETRY_ATTEMPTS: usize = 0;
const SUPPORTED_IMAGE_MIME_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/tiff"];
const CLI_FAILED_MANIFEST_EXTRACTOR_URL: &str = "manual://extract-cli";

static PROCESSING_STATE: OnceCell<Arc<Mutex<ProcessingState>>> = OnceCell::new();

#[derive(Clone)]
struct ImageCandidate {
  user_id: String,
  item_id: String,
  mime_type: String,
  file_size_bytes: Option<i64>,
  creation_date: i64,
  last_modified_date: i64,
}

impl ImageCandidate {
  fn from_item(item: &Item) -> Option<ImageCandidate> {
    let mime_type = item.mime_type.as_deref()?;
    if !is_supported_image_tagging_mime_type(Some(mime_type)) {
      return None;
    }
    Some(ImageCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      mime_type: mime_type.to_owned(),
      file_size_bytes: item.file_size_bytes,
      creation_date: item.creation_date,
      last_modified_date: item.last_modified_date,
    })
  }
}

pub(crate) struct LoadedImageTagging {
  candidate: ImageCandidate,
  file_bytes: Vec<u8>,
}

struct ProcessingState {
  queue: Vec<ImageCandidate>,
  queued_item_ids: HashSet<String>,
}

enum TagOutcome {
  Success(ImageTagArtifact, Option<u64>),
  DocumentFailed(String),
  ResponseFormatFailed(String),
  EndpointUnavailable(String),
}

struct TaggingProgress {
  processed: u64,
  succeeded: u64,
  other_failed: u64,
}

impl TaggingProgress {
  fn on_success(&mut self) {
    self.processed += 1;
    self.succeeded += 1;
  }

  fn on_other_failed(&mut self) {
    self.processed += 1;
    self.other_failed += 1;
  }

  fn summary(&self) -> String {
    format!("total={} succeeded={} failed={}", self.processed, self.succeeded, self.other_failed)
  }
}

pub fn is_supported_image_tagging_mime_type(mime_type: Option<&str>) -> bool {
  let Some(mime_type) = mime_type else {
    return false;
  };
  SUPPORTED_IMAGE_MIME_TYPES.contains(&mime_type)
}

pub fn should_tag_image_item(item: &Item) -> bool {
  is_supported_image_tagging_mime_type(item.mime_type.as_deref())
}

pub fn enqueue_image_item_if_active(item: &Item) {
  let Some(state) = PROCESSING_STATE.get() else {
    return;
  };

  let Some(candidate) = ImageCandidate::from_item(item) else {
    return;
  };

  if let Ok(mut state) = state.try_lock() {
    enqueue_candidate(&mut state, candidate);
    return;
  }

  let state = state.clone();
  let _enqueue = task::spawn(async move {
    let mut state = state.lock().await;
    enqueue_candidate(&mut state, candidate);
  });
}

pub fn dequeue_image_item_if_active(item_id: &str) {
  let Some(state) = PROCESSING_STATE.get() else {
    return;
  };

  let item_id = item_id.to_owned();

  if let Ok(mut state) = state.try_lock() {
    remove_candidate(&mut state, &item_id);
    return;
  }

  let state = state.clone();
  let _dequeue = task::spawn(async move {
    let mut state = state.lock().await;
    remove_candidate(&mut state, &item_id);
  });
}

pub async fn tag_single_item_no_retry(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<()> {
  tag_single_item_inner(data_dir, image_tagging_url, db, object_store, item_id, false).await
}

async fn tag_single_item_inner(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
  retry_endpoint_unavailable: bool,
) -> InfuResult<()> {
  let loaded = load_image_for_tagging(db.clone(), object_store, item_id).await?;
  process_loaded_image_tagging(data_dir, image_tagging_url, db, loaded, retry_endpoint_unavailable).await
}

pub(crate) async fn load_image_for_tagging(
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<LoadedImageTagging> {
  let (candidate, object_encryption_key) = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    let Some(candidate) = ImageCandidate::from_item(item) else {
      return Err(format!("Item '{}' is not a supported taggable image.", item_id).into());
    };
    let key =
      db.user.get(&item.owner_id).ok_or(format!("User '{}' not loaded.", item.owner_id))?.object_encryption_key.clone();
    (candidate, key)
  };
  info!("Starting source object read/decrypt for image '{}' (user {}).", candidate.item_id, candidate.user_id);
  let object_read_started_at = Instant::now();
  let file_bytes = storage_object::get(
    object_store.clone(),
    candidate.user_id.clone(),
    candidate.item_id.clone(),
    &object_encryption_key,
  )
  .await;
  let file_bytes = match file_bytes {
    Ok(bytes) => bytes,
    Err(e) => {
      let elapsed = object_read_started_at.elapsed();
      let error_message = e.to_string();
      error!(
        "Could not read source image object for '{}' (user {}) after {}: {}",
        candidate.item_id,
        candidate.user_id,
        format_duration_for_log(elapsed),
        error_message
      );
      return Err(format!("Could not read source image object for '{}': {}", candidate.item_id, error_message).into());
    }
  };
  let object_read_elapsed = object_read_started_at.elapsed();
  info!(
    "Completed source object read/decrypt for image '{}' (user {}) in {} ({} bytes).",
    candidate.item_id,
    candidate.user_id,
    format_duration_for_log(object_read_elapsed),
    file_bytes.len()
  );
  Ok(LoadedImageTagging { candidate, file_bytes })
}

pub(crate) async fn process_loaded_image_tagging(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  loaded: LoadedImageTagging,
  retry_endpoint_unavailable: bool,
) -> InfuResult<()> {
  let LoadedImageTagging { candidate, file_bytes } = loaded;
  clear_item_image_tag_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build HTTP client: {}", e))?;
  let outcome = if retry_endpoint_unavailable {
    request_image_tagging_with_retries(&client, image_tagging_url, &candidate, &file_bytes, None).await
  } else {
    request_image_tagging_once(&client, image_tagging_url, &candidate, &file_bytes).await
  };
  if !candidate_still_current(db.clone(), &candidate).await? {
    return Err(format!("Item '{}' was deleted or replaced while tagging was in progress.", candidate.item_id).into());
  }
  match outcome {
    TagOutcome::Success(mut tag_data, duration_ms) => {
      tag_data.image_metadata = extract_image_metadata(&file_bytes);
      write_success_artifacts(data_dir, image_tagging_url, &candidate, &tag_data, duration_ms).await?;
      info!("Tagged image '{}' (user {}).", candidate.item_id, candidate.user_id);
    }
    TagOutcome::DocumentFailed(msg) => {
      write_failed_manifest(data_dir, image_tagging_url, &candidate, &msg).await?;
      return Err(format!("Image tagging failed for '{}': {}", candidate.item_id, msg).into());
    }
    TagOutcome::ResponseFormatFailed(msg) => {
      write_failed_manifest(data_dir, image_tagging_url, &candidate, &msg).await?;
      return Err(format!("Image tagging failed for '{}': {}", candidate.item_id, msg).into());
    }
    TagOutcome::EndpointUnavailable(msg) => {
      return Err(format!("Image tagging endpoint unavailable: {}", msg).into());
    }
  }
  Ok(())
}

pub async fn mark_item_image_tagging_failed(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  item_id: &str,
  reason_maybe: Option<&str>,
) -> InfuResult<()> {
  let candidate = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    let Some(candidate) = ImageCandidate::from_item(item) else {
      return Err(format!("Item '{}' is not a supported taggable image.", item_id).into());
    };
    candidate
  };
  clear_item_image_tag_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
  let error_message = match reason_maybe.map(|reason| reason.trim()).filter(|reason| !reason.is_empty()) {
    Some(reason) => format!("Marked failed via CLI: {}", reason),
    None => "Marked failed via CLI.".to_owned(),
  };
  write_failed_manifest(data_dir, CLI_FAILED_MANIFEST_EXTRACTOR_URL, &candidate, &error_message).await?;
  info!("Marked image '{}' (user {}) as failed for image tagging via CLI.", candidate.item_id, candidate.user_id);
  Ok(())
}

pub fn image_tagging_url_from_config(config: &Config) -> InfuResult<Option<String>> {
  match config.get_string(CONFIG_IMAGE_TAGGING_URL) {
    Ok(url) if !url.trim().is_empty() => Ok(Some(url)),
    Ok(_) => Ok(None),
    Err(_) => Ok(None),
  }
}

pub fn init_image_tagging_processing_loop(
  config: &Config,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  let image_tagging_url = match image_tagging_url_from_config(config)? {
    Some(url) => url,
    None => return Ok(()),
  };
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  start_image_tagging_processing_loop(data_dir, image_tagging_url, Duration::ZERO, db, object_store)
}

pub fn start_image_tagging_processing_loop(
  data_dir: String,
  image_tagging_url: String,
  request_delay: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  if PROCESSING_STATE.get().is_some() {
    return Err("Image tagging processing loop is already running in this process.".into());
  }
  let state = Arc::new(Mutex::new(ProcessingState { queue: vec![], queued_item_ids: HashSet::new() }));
  PROCESSING_STATE
    .set(state.clone())
    .map_err(|_| "Image tagging processing loop is already running in this process.".to_owned())?;
  let progress = Arc::new(Mutex::new(TaggingProgress { processed: 0, succeeded: 0, other_failed: 0 }));

  info!(
    "Starting image tagging processing loop using '{}' with startup queue population and live enqueue updates (no rescan, delay {:.3}s).",
    image_tagging_url,
    request_delay.as_secs_f64()
  );
  let _worker = task::spawn(async move {
    run_image_tagging_loop(data_dir, image_tagging_url, request_delay, db, object_store, state, progress).await;
  });

  Ok(())
}

async fn run_image_tagging_loop(
  data_dir: String,
  image_tagging_url: String,
  request_delay: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ProcessingState>>,
  progress: Arc<Mutex<TaggingProgress>>,
) {
  let started_at = Instant::now();
  populate_initial_image_queue(&data_dir, db.clone(), state.clone()).await;
  let mut next_prefetch = Some(spawn_image_prefetch(
    data_dir.clone(),
    image_tagging_url.clone(),
    db.clone(),
    object_store.clone(),
    state.clone(),
    progress.clone(),
  ));
  let mut current_process = advance_image_prefetch_to_process(
    data_dir.clone(),
    image_tagging_url.clone(),
    db.clone(),
    object_store.clone(),
    state.clone(),
    progress.clone(),
    &mut next_prefetch,
  )
  .await;

  loop {
    let Some(current_handle) = current_process else {
      return;
    };

    let next_process = if request_delay == Duration::ZERO {
      advance_image_prefetch_to_process(
        data_dir.clone(),
        image_tagging_url.clone(),
        db.clone(),
        object_store.clone(),
        state.clone(),
        progress.clone(),
        &mut next_prefetch,
      )
      .await
    } else {
      None
    };

    let (item_id, user_id, queue_remaining, result) = match current_handle.await {
      Ok(result) => result,
      Err(e) => {
        error!("Image tagging request task failed: {}", e);
        time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
        current_process = advance_image_prefetch_to_process(
          data_dir.clone(),
          image_tagging_url.clone(),
          db.clone(),
          object_store.clone(),
          state.clone(),
          progress.clone(),
          &mut next_prefetch,
        )
        .await;
        continue;
      }
    };

    match result {
      Ok(()) => {
        let (progress_summary, throughput_suffix) = {
          let mut progress = progress.lock().await;
          progress.on_success();
          (progress.summary(), average_throughput_suffix(&started_at, progress.processed))
        };
        info!(
          "Image '{}' (user {}): tagged successfully. {} remaining. {}.{}",
          item_id, user_id, queue_remaining, progress_summary, throughput_suffix
        );
      }
      Err(e) => {
        let (progress_summary, throughput_suffix) = {
          let mut progress = progress.lock().await;
          progress.on_other_failed();
          (progress.summary(), average_throughput_suffix(&started_at, progress.processed))
        };
        info!(
          "Image '{}' (user {}): tagging failed: {}. {} remaining. {}.{}",
          item_id, user_id, e, queue_remaining, progress_summary, throughput_suffix
        );
      }
    }

    if request_delay > Duration::ZERO {
      time::sleep(request_delay).await;
      current_process = advance_image_prefetch_to_process(
        data_dir.clone(),
        image_tagging_url.clone(),
        db.clone(),
        object_store.clone(),
        state.clone(),
        progress.clone(),
        &mut next_prefetch,
      )
      .await;
    } else {
      current_process = next_process;
    }
  }
}

fn spawn_image_prefetch(
  data_dir: String,
  _image_tagging_url: String,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ProcessingState>>,
  progress: Arc<Mutex<TaggingProgress>>,
) -> task::JoinHandle<(LoadedImageTagging, usize)> {
  task::spawn(async move { prefetch_next_image_tagging(data_dir, db, object_store, state, progress).await })
}

fn spawn_image_process(
  data_dir: String,
  image_tagging_url: String,
  db: Arc<Mutex<Db>>,
  loaded: LoadedImageTagging,
  queue_remaining: usize,
) -> task::JoinHandle<(String, String, usize, InfuResult<()>)> {
  let item_id = loaded.candidate.item_id.clone();
  let user_id = loaded.candidate.user_id.clone();
  task::spawn(async move {
    let result = process_loaded_image_tagging(&data_dir, &image_tagging_url, db, loaded, true).await;
    (item_id, user_id, queue_remaining, result)
  })
}

async fn advance_image_prefetch_to_process(
  data_dir: String,
  image_tagging_url: String,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ProcessingState>>,
  progress: Arc<Mutex<TaggingProgress>>,
  next_prefetch: &mut Option<task::JoinHandle<(LoadedImageTagging, usize)>>,
) -> Option<task::JoinHandle<(String, String, usize, InfuResult<()>)>> {
  loop {
    let current_prefetch = next_prefetch.take()?;
    let (loaded, queue_remaining) = match current_prefetch.await {
      Ok(result) => result,
      Err(e) => {
        error!("Image tagging prefetch task failed: {}", e);
        time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
        *next_prefetch = Some(spawn_image_prefetch(
          data_dir.clone(),
          image_tagging_url.clone(),
          db.clone(),
          object_store.clone(),
          state.clone(),
          progress.clone(),
        ));
        continue;
      }
    };

    *next_prefetch = Some(spawn_image_prefetch(
      data_dir.clone(),
      image_tagging_url.clone(),
      db.clone(),
      object_store.clone(),
      state.clone(),
      progress.clone(),
    ));

    let item_id = loaded.candidate.item_id.clone();
    let user_id = loaded.candidate.user_id.clone();
    let progress_summary = {
      let progress = progress.lock().await;
      progress.summary()
    };
    info!(
      "Starting image tagging for '{}' (user {}). Pending queue: {}. Progress: {}",
      item_id, user_id, queue_remaining, progress_summary
    );

    return Some(spawn_image_process(data_dir.clone(), image_tagging_url.clone(), db.clone(), loaded, queue_remaining));
  }
}

async fn prefetch_next_image_tagging(
  _data_dir: String,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ProcessingState>>,
  progress: Arc<Mutex<TaggingProgress>>,
) -> (LoadedImageTagging, usize) {
  loop {
    let (candidate, queue_remaining) = wait_for_next_image_candidate(state.clone()).await;
    if candidate.file_size_bytes.map_or(false, |size| size >= LARGE_IMAGE_SIZE_BYTES) {
      info!(
        "Image '{}' (user {}): large image (~{} MB); tagging may take longer and use significant memory.",
        candidate.item_id,
        candidate.user_id,
        candidate.file_size_bytes.map(|size| size / (1024 * 1024)).unwrap_or(0)
      );
    }

    match load_image_for_tagging(db.clone(), object_store.clone(), &candidate.item_id).await {
      Ok(loaded) => return (loaded, queue_remaining),
      Err(e) => {
        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_other_failed();
          progress.summary()
        };
        info!(
          "Image '{}' (user {}): source-object prefetch failed: {}. {} remaining. {}",
          candidate.item_id, candidate.user_id, e, queue_remaining, progress_summary
        );
        time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
      }
    }
  }
}

async fn wait_for_next_image_candidate(state: Arc<Mutex<ProcessingState>>) -> (ImageCandidate, usize) {
  loop {
    let (candidate, queue_remaining) = {
      let mut state = state.lock().await;
      pop_candidate(&mut state)
    };

    match (candidate, queue_remaining) {
      (Some(candidate), remaining) => return (candidate, remaining),
      (None, _) => time::sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await,
    }
  }
}

fn format_duration_for_log(duration: Duration) -> String {
  if duration.subsec_nanos() == 0 {
    let secs = duration.as_secs();
    if secs >= 60 && secs % 60 == 0 {
      let minutes = secs / 60;
      return if minutes == 1 { "1 minute".to_owned() } else { format!("{} minutes", minutes) };
    }
    return if secs == 1 { "1 second".to_owned() } else { format!("{} seconds", secs) };
  }
  format!("{:.3} seconds", duration.as_secs_f64())
}

fn average_throughput_suffix(started_at: &Instant, completed_requests: u64) -> String {
  if completed_requests == 0 {
    return String::new();
  }

  let elapsed_secs = started_at.elapsed().as_secs_f64().max(0.001);
  let per_minute = (completed_requests as f64) * 60.0 / elapsed_secs;
  format!(" avg_throughput={:.2} images/min", per_minute)
}

async fn request_image_tagging_with_retries(
  client: &reqwest::Client,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  file_bytes: &[u8],
  worker_id_maybe: Option<usize>,
) -> TagOutcome {
  let mut unavailable_attempt = 0usize;
  let mut response_format_attempt = 0usize;

  loop {
    let outcome = request_image_tagging(client, image_tagging_url, &candidate.mime_type, file_bytes.to_vec()).await;
    match outcome {
      TagOutcome::ResponseFormatFailed(message) => {
        if response_format_attempt >= MAX_RESPONSE_FORMAT_RETRY_ATTEMPTS {
          return TagOutcome::DocumentFailed(format!(
            "Image tagging service repeatedly returned malformed structured output after {} attempt(s): {}",
            response_format_attempt + 1,
            message
          ));
        }

        response_format_attempt += 1;
        match worker_id_maybe {
          Some(worker_id) => {
            info!(
              "Worker {}: image tagging endpoint '{}' returned malformed structured output for '{}' (user {}) ({}). Retrying immediately.",
              worker_id, image_tagging_url, candidate.item_id, candidate.user_id, message
            );
          }
          None => {
            info!(
              "Image tagging endpoint '{}' returned malformed structured output for '{}' (user {}) ({}). Retrying immediately.",
              image_tagging_url, candidate.item_id, candidate.user_id, message
            );
          }
        }
      }
      TagOutcome::EndpointUnavailable(message) => {
        let delay = endpoint_retry_delay(unavailable_attempt);
        unavailable_attempt += 1;
        match worker_id_maybe {
          Some(worker_id) => {
            info!(
              "Worker {}: image tagging endpoint '{}' is unavailable for '{}' (user {}) ({}). Retrying in {}.",
              worker_id,
              image_tagging_url,
              candidate.item_id,
              candidate.user_id,
              message,
              format_duration_for_log(delay)
            );
          }
          None => {
            info!(
              "Image tagging endpoint '{}' is unavailable for '{}' (user {}) ({}). Retrying in {}.",
              image_tagging_url,
              candidate.item_id,
              candidate.user_id,
              message,
              format_duration_for_log(delay)
            );
          }
        }
        time::sleep(delay).await;
      }
      other => {
        if unavailable_attempt > 0 || response_format_attempt > 0 {
          match worker_id_maybe {
            Some(worker_id) => {
              info!(
                "Worker {}: image tagging endpoint '{}' accepted requests again for '{}' (user {}) after {} unavailable attempt(s) and {} malformed-response attempt(s).",
                worker_id,
                image_tagging_url,
                candidate.item_id,
                candidate.user_id,
                unavailable_attempt,
                response_format_attempt
              );
            }
            None => {
              info!(
                "Image tagging endpoint '{}' accepted requests again for '{}' (user {}) after {} unavailable attempt(s) and {} malformed-response attempt(s).",
                image_tagging_url, candidate.item_id, candidate.user_id, unavailable_attempt, response_format_attempt
              );
            }
          }
        }
        return other;
      }
    }
  }
}

async fn request_image_tagging_once(
  client: &reqwest::Client,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  file_bytes: &[u8],
) -> TagOutcome {
  request_image_tagging(client, image_tagging_url, &candidate.mime_type, file_bytes.to_vec()).await
}

fn pop_candidate(state: &mut ProcessingState) -> (Option<ImageCandidate>, usize) {
  let candidate = match state.queue.pop() {
    Some(candidate) => {
      state.queued_item_ids.remove(&candidate.item_id);
      candidate
    }
    None => return (None, 0),
  };
  let remaining = state.queue.len();
  (Some(candidate), remaining)
}

fn enqueue_candidate(state: &mut ProcessingState, candidate: ImageCandidate) {
  if state.queued_item_ids.contains(&candidate.item_id) {
    return;
  }

  state.queue.push(candidate);
  state.queue.sort_by(compare_candidates_desc);

  state.queued_item_ids.clear();
  for queued_candidate in &state.queue {
    state.queued_item_ids.insert(queued_candidate.item_id.clone());
  }
}

fn remove_candidate(state: &mut ProcessingState, item_id: &str) {
  state.queue.retain(|candidate| candidate.item_id != item_id);
  state.queued_item_ids.remove(item_id);
}

fn compare_candidates_desc(a: &ImageCandidate, b: &ImageCandidate) -> std::cmp::Ordering {
  let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
  let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
  b_size.cmp(&a_size).then(b.last_modified_date.cmp(&a.last_modified_date)).then(b.item_id.cmp(&a.item_id))
}

async fn populate_initial_image_queue(data_dir: &str, db: Arc<Mutex<Db>>, state: Arc<Mutex<ProcessingState>>) {
  let candidates = {
    let db = db.lock().await;
    let mut candidates = db
      .item
      .all_loaded_items()
      .into_iter()
      .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
      .filter_map(|item| ImageCandidate::from_item(&item))
      .collect::<Vec<ImageCandidate>>();
    candidates.sort_by(|a, b| {
      let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
      let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
      a_size.cmp(&b_size).then(a.last_modified_date.cmp(&b.last_modified_date)).then(a.item_id.cmp(&b.item_id))
    });
    candidates
  };

  let total_candidates = candidates.len();
  let mut pending_candidates = vec![];
  let mut already_succeeded = 0usize;
  let mut already_failed = 0usize;
  let mut skipped_errors = 0usize;

  for candidate in candidates {
    match manifest_check(data_dir, &candidate).await {
      Ok(ManifestCheckResult::NeedsTagging) => pending_candidates.push(candidate),
      Ok(ManifestCheckResult::AlreadySucceeded) => already_succeeded += 1,
      Ok(ManifestCheckResult::AlreadyFailed) => already_failed += 1,
      Err(e) => {
        skipped_errors += 1;
        error!(
          "Skipping image '{}' (user {}) during startup queue population: {}",
          candidate.item_id, candidate.user_id, e
        );
      }
    }
  }

  let scheduled = pending_candidates.len();
  {
    let mut state = state.lock().await;
    for candidate in pending_candidates {
      enqueue_candidate(&mut state, candidate);
    }
  }

  info!(
    "Initialized image tagging queue with {} pending item(s) from {} total supported image(s) (already succeeded: {}, already failed: {}, skipped due to errors: {}).",
    scheduled, total_candidates, already_succeeded, already_failed, skipped_errors
  );
}

async fn candidate_still_current(db: Arc<Mutex<Db>>, candidate: &ImageCandidate) -> InfuResult<bool> {
  let db = db.lock().await;
  let item = match db.item.get(&candidate.item_id) {
    Ok(item) => item,
    Err(_) => return Ok(false),
  };
  Ok(
    item.owner_id == candidate.user_id
      && item.creation_date == candidate.creation_date
      && item.mime_type.as_deref() == Some(candidate.mime_type.as_str())
      && is_supported_image_tagging_mime_type(item.mime_type.as_deref()),
  )
}

async fn request_image_tagging(
  client: &reqwest::Client,
  image_tagging_url: &str,
  mime_type: &str,
  file_bytes: Vec<u8>,
) -> TagOutcome {
  let part = match Part::bytes(file_bytes).mime_str(mime_type) {
    Ok(part) => part,
    Err(e) => return TagOutcome::EndpointUnavailable(format!("Could not build multipart upload: {}", e)),
  };
  let form = Form::new().part("file", part);

  let response = match client.post(image_tagging_url).multipart(form).send().await {
    Ok(response) => response,
    Err(e) => return TagOutcome::EndpointUnavailable(e.to_string()),
  };

  let status = response.status();
  let body = match response.text().await {
    Ok(body) => body,
    Err(e) => return TagOutcome::EndpointUnavailable(format!("Could not read response body: {}", e)),
  };

  if status.is_success() {
    let parsed: Value = match serde_json::from_str(&body) {
      Ok(parsed) => parsed,
      Err(e) => return TagOutcome::EndpointUnavailable(format!("Could not parse success response: {}", e)),
    };
    let tag_data = ImageTagArtifact::from_value(parsed);
    let duration_ms = tag_data.duration_ms();
    return TagOutcome::Success(tag_data, duration_ms);
  }

  if is_terminal_document_response(status) {
    return TagOutcome::DocumentFailed(format!("HTTP {}: {}", status, body));
  }

  if let Some(message) = classify_malformed_structured_output_response(status, &body) {
    return TagOutcome::ResponseFormatFailed(format!("HTTP {}: {}", status, message));
  }

  TagOutcome::EndpointUnavailable(format!("HTTP {}: {}", status, body))
}

fn is_terminal_document_response(status: reqwest::StatusCode) -> bool {
  matches!(status, reqwest::StatusCode::UNPROCESSABLE_ENTITY | reqwest::StatusCode::PAYLOAD_TOO_LARGE)
}

fn classify_malformed_structured_output_response(status: reqwest::StatusCode, body: &str) -> Option<String> {
  if status != reqwest::StatusCode::INTERNAL_SERVER_ERROR {
    return None;
  }

  let detail = extract_response_detail(body).unwrap_or_else(|| body.trim().to_owned());
  if is_malformed_structured_output_detail(&detail) { Some(detail) } else { None }
}

fn extract_response_detail(body: &str) -> Option<String> {
  let parsed: Value = serde_json::from_str(body).ok()?;
  let detail = parsed.get("detail")?.as_str()?.trim();
  if detail.is_empty() { None } else { Some(detail.to_owned()) }
}

fn is_malformed_structured_output_detail(detail: &str) -> bool {
  let lowered = detail.trim().to_ascii_lowercase();
  if lowered.starts_with("model output ") {
    return true;
  }

  let looks_like_json_decode_error = (lowered.contains("expecting ") || lowered.contains("unterminated "))
    && lowered.contains(" line ")
    && lowered.contains(" column ");

  looks_like_json_decode_error
    || lowered.contains("invalid control character")
    || lowered.contains("extra data")
    || lowered.contains("json object")
    || lowered.contains("json root")
}
