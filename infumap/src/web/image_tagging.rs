use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info};
use once_cell::sync::OnceCell;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;
use tokio::{task, time};

use crate::config::{CONFIG_DATA_DIR, CONFIG_IMAGE_TAGGING_URL};
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::util::fs::{ensure_256_subdirs, expand_tilde, path_exists};
use crate::util::retry::endpoint_retry_delay;

const IDLE_POLL_SECS: u64 = 60;
const REQUEST_TIMEOUT_SECS: u64 = 30 * 60;
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_PENDING_IMAGES: usize = 100;
const REFILL_WHEN_QUEUE_AT_MOST: usize = 50;
const LARGE_IMAGE_SIZE_BYTES: i64 = 10 * 1024 * 1024;
const REFILL_WAIT_MILLIS: u64 = 1000;
const SUPPORTED_IMAGE_MIME_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "image/tiff"];
const DEFAULT_BACKGROUND_CONCURRENCY: usize = 1;
const JSON_CONTENT_MIME_TYPE: &str = "application/json";

static PROCESSING_STATE: OnceCell<Arc<Mutex<ProcessingState>>> = OnceCell::new();

#[derive(Clone)]
struct ImageCandidate {
  user_id: String,
  item_id: String,
  title: String,
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
      title: item.title.clone().unwrap_or_else(|| format!("{}.bin", item.id)),
      mime_type: mime_type.to_owned(),
      file_size_bytes: item.file_size_bytes,
      creation_date: item.creation_date,
      last_modified_date: item.last_modified_date,
    })
  }
}

struct ProcessingState {
  queue: Vec<ImageCandidate>,
  queued_item_ids: HashSet<String>,
  scan_exhausted: bool,
  refill_in_progress: bool,
}

#[derive(Serialize, Deserialize)]
struct ImageTagManifest {
  schema_version: u32,
  status: String,
  source_mime_type: String,
  content_mime_type: String,
  extractor: ImageTagManifestExtractor,
  error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ImageTagManifestExtractor {
  image_tagging_url: String,
  tagged_at_unix_secs: i64,
  duration_ms: Option<u64>,
}

enum TagOutcome {
  Success(Value, Option<u64>),
  DocumentFailed(String),
  EndpointUnavailable(String),
}

struct RefillResult {
  found_any: bool,
  total_candidates: usize,
  considered_candidates: usize,
  queued_candidates: usize,
  already_succeeded: usize,
  already_failed: usize,
  needs_tagging: usize,
}

struct TaggingProgress {
  processed: u64,
  succeeded: u64,
  document_failed: u64,
  other_failed: u64,
}

impl TaggingProgress {
  fn on_success(&mut self) {
    self.processed += 1;
    self.succeeded += 1;
  }

  fn on_document_failed(&mut self) {
    self.processed += 1;
    self.document_failed += 1;
  }

  fn on_other_failed(&mut self) {
    self.processed += 1;
    self.other_failed += 1;
  }

  fn summary(&self) -> String {
    format!(
      "total={} succeeded={} document_failed={} other_failed={}",
      self.processed, self.succeeded, self.document_failed, self.other_failed
    )
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

#[derive(Clone)]
pub struct FailedImageTagInfo {
  pub user_id: String,
  pub item_id: String,
  pub file_name: String,
  pub error: Option<String>,
}

pub async fn list_failed_images(data_dir: &str, db: Arc<Mutex<Db>>) -> InfuResult<Vec<FailedImageTagInfo>> {
  let mut out = vec![];
  let image_items: Vec<(String, String, String)> = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|iu| db.item.get(&iu.item_id).ok().map(|item| (iu.user_id.clone(), item)))
      .filter(|(_, item)| should_tag_image_item(item))
      .map(|(user_id, item)| {
        (user_id, item.id.clone(), item.title.clone().unwrap_or_else(|| format!("{}.bin", item.id)))
      })
      .collect()
  };
  for (user_id, item_id, file_name) in image_items {
    let path = match manifest_path(data_dir, &user_id, &item_id) {
      Ok(path) => path,
      Err(e) => {
        debug!(
          "Skipping failed image tag listing for item '{}' (user '{}'): could not build manifest path: {}",
          item_id, user_id, e
        );
        continue;
      }
    };
    if !path_exists(&path).await {
      continue;
    }
    let bytes = match fs::read(&path).await {
      Ok(bytes) => bytes,
      Err(e) => {
        debug!(
          "Skipping failed image tag listing for item '{}' (user '{}'): could not read manifest '{}': {}",
          item_id,
          user_id,
          path.display(),
          e
        );
        continue;
      }
    };
    let manifest: ImageTagManifest = match serde_json::from_slice(&bytes) {
      Ok(manifest) => manifest,
      Err(e) => {
        debug!(
          "Skipping failed image tag listing for item '{}' (user '{}'): could not parse manifest '{}': {}",
          item_id,
          user_id,
          path.display(),
          e
        );
        continue;
      }
    };
    if manifest.status != "failed" {
      continue;
    }
    out.push(FailedImageTagInfo { user_id, item_id, file_name, error: manifest.error });
  }
  Ok(out)
}

pub async fn tag_single_item(
  data_dir: &str,
  image_tagging_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<()> {
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
  clear_item_image_tag_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
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
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build HTTP client: {}", e))?;
  let outcome = request_image_tagging_with_retries(&client, image_tagging_url, &candidate, &file_bytes, None).await;
  if !candidate_still_current(db.clone(), &candidate).await? {
    return Err(format!("Item '{}' was deleted or replaced while tagging was in progress.", candidate.item_id).into());
  }
  match outcome {
    TagOutcome::Success(tag_data, duration_ms) => {
      write_success_artifacts(data_dir, image_tagging_url, &candidate, &tag_data, duration_ms).await?;
      info!("Tagged image '{}' (user {}).", candidate.item_id, candidate.user_id);
    }
    TagOutcome::DocumentFailed(msg) => {
      write_failed_manifest(data_dir, image_tagging_url, &candidate, &msg).await?;
      return Err(format!("Image tagging failed for '{}': {}", candidate.item_id, msg).into());
    }
    TagOutcome::EndpointUnavailable(msg) => {
      return Err(format!("Image tagging endpoint unavailable: {}", msg).into());
    }
  }
  Ok(())
}

pub async fn item_needs_image_tagging(data_dir: &str, db: Arc<Mutex<Db>>, item_id: &str) -> InfuResult<bool> {
  let candidate = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    let Some(candidate) = ImageCandidate::from_item(item) else {
      return Err(format!("Item '{}' is not a supported taggable image.", item_id).into());
    };
    candidate
  };
  Ok(matches!(manifest_check(data_dir, &candidate).await?, ManifestCheckResult::NeedsTagging))
}

pub async fn delete_item_image_tag_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  clear_item_image_tag_dir(data_dir, user_id, item_id).await
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
  start_image_tagging_processing_loop(
    data_dir,
    image_tagging_url,
    DEFAULT_BACKGROUND_CONCURRENCY,
    Duration::ZERO,
    db,
    object_store,
  )
}

pub fn start_image_tagging_processing_loop(
  data_dir: String,
  image_tagging_url: String,
  concurrency: usize,
  request_delay: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  if PROCESSING_STATE.get().is_some() {
    return Err("Image tagging processing loop is already running in this process.".into());
  }
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build image tagging HTTP client: {}", e))?;
  let state = Arc::new(Mutex::new(ProcessingState {
    queue: vec![],
    queued_item_ids: HashSet::new(),
    scan_exhausted: false,
    refill_in_progress: false,
  }));
  PROCESSING_STATE
    .set(state.clone())
    .map_err(|_| "Image tagging processing loop is already running in this process.".to_owned())?;
  let progress =
    Arc::new(Mutex::new(TaggingProgress { processed: 0, succeeded: 0, document_failed: 0, other_failed: 0 }));

  info!(
    "Starting {} image tagging worker(s) using '{}' with a {:.3}s delay between requests.",
    concurrency,
    image_tagging_url,
    request_delay.as_secs_f64()
  );
  for worker_id in 0..concurrency {
    let worker_state = state.clone();
    let worker_db = db.clone();
    let worker_object_store = object_store.clone();
    let worker_client = client.clone();
    let worker_progress = progress.clone();
    let worker_data_dir = data_dir.clone();
    let worker_image_tagging_url = image_tagging_url.clone();
    let worker_request_delay = request_delay;
    let _worker = task::spawn(async move {
      run_image_tagging_worker(
        worker_id + 1,
        worker_data_dir,
        worker_image_tagging_url,
        worker_request_delay,
        worker_db,
        worker_object_store,
        worker_client,
        worker_state,
        worker_progress,
      )
      .await;
    });
  }

  Ok(())
}

async fn run_image_tagging_worker(
  worker_id: usize,
  data_dir: String,
  image_tagging_url: String,
  request_delay: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  client: reqwest::Client,
  state: Arc<Mutex<ProcessingState>>,
  progress: Arc<Mutex<TaggingProgress>>,
) {
  loop {
    let (candidate, queue_remaining) = {
      let mut state = state.lock().await;
      pop_candidate(&mut state)
    };

    let (candidate, queue_remaining) = match (candidate, queue_remaining) {
      (Some(candidate), remaining) => {
        if remaining <= REFILL_WHEN_QUEUE_AT_MOST {
          match refill_queue_if_needed(&data_dir, db.clone(), state.clone(), Some(&candidate.item_id)).await {
            Ok(Some(refill)) => {
              let progress_summary = {
                let progress = progress.lock().await;
                progress.summary()
              };
              info!(
                "Worker {} starting image tagging for '{}' (user {}). Pending queue: {}. Progress: {}",
                worker_id, candidate.item_id, candidate.user_id, refill.queued_candidates, progress_summary
              );
            }
            Ok(None) => {}
            Err(e) => {
              error!("Worker {} could not refill image tagging queue: {}", worker_id, e);
            }
          }
        }
        (candidate, remaining)
      }
      (None, _) => match refill_queue_if_needed(&data_dir, db.clone(), state.clone(), None).await {
        Ok(Some(refill)) if refill.found_any => {
          let progress_summary = {
            let progress = progress.lock().await;
            progress.summary()
          };
          info!(
            "Image tagging queue refill: {}/{} manifest checks (success: {}, failure: {}, none: {}). Progress: {}",
            refill.considered_candidates,
            refill.total_candidates,
            refill.already_succeeded,
            refill.already_failed,
            refill.needs_tagging,
            progress_summary
          );
          continue;
        }
        Ok(Some(refill)) => {
          let progress_summary = {
            let progress = progress.lock().await;
            progress.summary()
          };
          info!(
            "Image tagging queue refill: {}/{} manifest checks (success: {}, failure: {}, none: {}). Progress: {}",
            refill.considered_candidates,
            refill.total_candidates,
            refill.already_succeeded,
            refill.already_failed,
            refill.needs_tagging,
            progress_summary
          );
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
        Ok(None) => {
          let should_idle_sleep = {
            let state = state.lock().await;
            state.scan_exhausted
          };
          if should_idle_sleep {
            time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          } else {
            time::sleep(Duration::from_millis(REFILL_WAIT_MILLIS)).await;
          }
          continue;
        }
        Err(e) => {
          error!("Worker {} could not refill image tagging queue: {}", worker_id, e);
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
      },
    };

    let object_encryption_key = {
      let db = db.lock().await;
      match db.user.get(&candidate.user_id) {
        Some(user) => user.object_encryption_key.clone(),
        None => {
          let progress_summary = {
            let mut progress = progress.lock().await;
            progress.on_other_failed();
            progress.summary()
          };
          info!(
            "Image '{}' (user {}): user not loaded. {} remaining. {}",
            candidate.item_id, candidate.user_id, queue_remaining, progress_summary
          );
          error!(
            "Worker {} could not process image '{}' for user '{}': user is not loaded.",
            worker_id, candidate.item_id, candidate.user_id
          );
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
      }
    };

    if candidate.file_size_bytes.map_or(false, |size| size >= LARGE_IMAGE_SIZE_BYTES) {
      info!(
        "Image '{}' (user {}): large image (~{} MB); tagging may take longer and use significant memory.",
        candidate.item_id,
        candidate.user_id,
        candidate.file_size_bytes.map(|size| size / (1024 * 1024)).unwrap_or(0)
      );
    }

    info!(
      "Worker {} starting source object read/decrypt for image '{}' (user {}).",
      worker_id, candidate.item_id, candidate.user_id
    );
    let object_read_started_at = Instant::now();
    let file_bytes = match storage_object::get(
      object_store.clone(),
      candidate.user_id.clone(),
      candidate.item_id.clone(),
      &object_encryption_key,
    )
    .await
    {
      Ok(bytes) => bytes,
      Err(e) => {
        let object_read_elapsed = object_read_started_at.elapsed();
        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_other_failed();
          progress.summary()
        };
        info!(
          "Image '{}' (user {}): source object read/decrypt failed after {}: {}. {} remaining. {}",
          candidate.item_id,
          candidate.user_id,
          format_duration_for_log(object_read_elapsed),
          e,
          queue_remaining,
          progress_summary
        );
        error!(
          "Worker {} could not read image '{}' for user '{}' after {}: {}",
          worker_id,
          candidate.item_id,
          candidate.user_id,
          format_duration_for_log(object_read_elapsed),
          e
        );
        time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
        continue;
      }
    };
    let object_read_elapsed = object_read_started_at.elapsed();
    info!(
      "Worker {} completed source object read/decrypt for image '{}' (user {}) in {} ({} bytes).",
      worker_id,
      candidate.item_id,
      candidate.user_id,
      format_duration_for_log(object_read_elapsed),
      file_bytes.len()
    );

    info!(
      "Worker {} sending image tagging request for '{}' (user {}) to '{}'.",
      worker_id, candidate.item_id, candidate.user_id, image_tagging_url
    );
    let outcome =
      request_image_tagging_with_retries(&client, &image_tagging_url, &candidate, &file_bytes, Some(worker_id)).await;
    let item_is_current = match candidate_still_current(db.clone(), &candidate).await {
      Ok(current) => current,
      Err(e) => {
        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_other_failed();
          progress.summary()
        };
        error!(
          "Worker {} could not verify current state for image '{}' for user '{}': {}. {}",
          worker_id, candidate.item_id, candidate.user_id, e, progress_summary
        );
        time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
        continue;
      }
    };
    if !item_is_current {
      let progress_summary = {
        let mut progress = progress.lock().await;
        progress.on_other_failed();
        progress.summary()
      };
      info!(
        "Image '{}' (user {}): item was deleted or replaced while tagging was in progress. Skipping artifact write. {} remaining. {}",
        candidate.item_id, candidate.user_id, queue_remaining, progress_summary
      );
      if request_delay > Duration::ZERO {
        time::sleep(request_delay).await;
      }
      continue;
    }

    match outcome {
      TagOutcome::Success(tag_data, duration_ms) => {
        if let Err(e) = write_success_artifacts(&data_dir, &image_tagging_url, &candidate, &tag_data, duration_ms).await
        {
          let progress_summary = {
            let mut progress = progress.lock().await;
            progress.on_other_failed();
            progress.summary()
          };
          info!(
            "Image '{}' (user {}): write failed: {}. {} remaining. {}",
            candidate.item_id, candidate.user_id, e, queue_remaining, progress_summary
          );
          error!(
            "Worker {} could not write image tag artifacts for '{}' for user '{}': {}",
            worker_id, candidate.item_id, candidate.user_id, e
          );
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_success();
          progress.summary()
        };
        info!(
          "Image '{}' (user {}): tagged successfully. {} remaining. {}",
          candidate.item_id, candidate.user_id, queue_remaining, progress_summary
        );
      }
      TagOutcome::DocumentFailed(message) => {
        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_document_failed();
          progress.summary()
        };
        if let Err(e) = write_failed_manifest(&data_dir, &image_tagging_url, &candidate, &message).await {
          error!(
            "Worker {} could not write failed image tag manifest for '{}' for user '{}': {}",
            worker_id, candidate.item_id, candidate.user_id, e
          );
        } else {
          error!("Image tagging failed for '{}' for user '{}': {}", candidate.item_id, candidate.user_id, message);
        }
        info!(
          "Image '{}' (user {}): tagging failed: {}. {} remaining. {}",
          candidate.item_id, candidate.user_id, message, queue_remaining, progress_summary
        );
      }
      TagOutcome::EndpointUnavailable(message) => {
        error!(
          "Worker {}: retry loop returned an unexpected endpoint-unavailable outcome for image '{}' (user {}): {}",
          worker_id, candidate.item_id, candidate.user_id, message
        );
      }
    }
    if request_delay > Duration::ZERO {
      time::sleep(request_delay).await;
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

async fn request_image_tagging_with_retries(
  client: &reqwest::Client,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  file_bytes: &[u8],
  worker_id_maybe: Option<usize>,
) -> TagOutcome {
  let mut unavailable_attempt = 0usize;

  loop {
    let outcome =
      request_image_tagging(client, image_tagging_url, &candidate.title, &candidate.mime_type, file_bytes.to_vec())
        .await;
    match outcome {
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
        if unavailable_attempt > 0 {
          match worker_id_maybe {
            Some(worker_id) => {
              info!(
                "Worker {}: image tagging endpoint '{}' accepted requests again for '{}' (user {}) after {} unavailable attempt(s).",
                worker_id, image_tagging_url, candidate.item_id, candidate.user_id, unavailable_attempt
              );
            }
            None => {
              info!(
                "Image tagging endpoint '{}' accepted requests again for '{}' (user {}) after {} unavailable attempt(s).",
                image_tagging_url, candidate.item_id, candidate.user_id, unavailable_attempt
              );
            }
          }
        }
        return other;
      }
    }
  }
}

async fn refill_queue_if_needed(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ProcessingState>>,
  exclude_item_id: Option<&str>,
) -> InfuResult<Option<RefillResult>> {
  {
    let mut state = state.lock().await;
    let should_refill = !state.scan_exhausted;
    if !should_refill || state.refill_in_progress {
      return Ok(None);
    }
    state.refill_in_progress = true;
  }

  let refill = refill_queue(data_dir, db, state.clone(), exclude_item_id).await;

  {
    let mut state = state.lock().await;
    state.refill_in_progress = false;
  }

  refill.map(Some)
}

async fn refill_queue(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ProcessingState>>,
  exclude_item_id: Option<&str>,
) -> InfuResult<RefillResult> {
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

  let total = candidates.len();
  let mut refill_state = ProcessingState {
    queue: vec![],
    queued_item_ids: HashSet::new(),
    scan_exhausted: false,
    refill_in_progress: false,
  };
  let mut already_succeeded = 0usize;
  let mut already_failed = 0usize;
  let mut none = 0usize;
  let mut checked = 0usize;
  let mut excluded = 0usize;

  for candidate in candidates {
    if exclude_item_id == Some(candidate.item_id.as_str()) {
      excluded += 1;
      continue;
    }
    checked += 1;
    match manifest_check(data_dir, &candidate).await? {
      ManifestCheckResult::NeedsTagging => {
        none += 1;
        enqueue_candidate(&mut refill_state, candidate);
        if refill_state.queue.len() >= MAX_PENDING_IMAGES {
          break;
        }
      }
      ManifestCheckResult::AlreadySucceeded => already_succeeded += 1,
      ManifestCheckResult::AlreadyFailed => already_failed += 1,
    }
  }

  let mut state = state.lock().await;
  for candidate in refill_state.queue {
    enqueue_candidate(&mut state, candidate);
  }
  let queued = state.queue.len();
  state.scan_exhausted = state.queue.is_empty();
  let considered = checked + excluded;
  Ok(RefillResult {
    found_any: !state.queue.is_empty(),
    total_candidates: total,
    considered_candidates: considered,
    queued_candidates: queued,
    already_succeeded,
    already_failed,
    needs_tagging: none,
  })
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

  if state.queue.len() > MAX_PENDING_IMAGES {
    state.queue.remove(0);
  }

  state.queued_item_ids.clear();
  for queued_candidate in &state.queue {
    state.queued_item_ids.insert(queued_candidate.item_id.clone());
  }
  state.scan_exhausted = false;
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

enum ManifestCheckResult {
  NeedsTagging,
  AlreadySucceeded,
  AlreadyFailed,
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

async fn manifest_check(data_dir: &str, candidate: &ImageCandidate) -> InfuResult<ManifestCheckResult> {
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let text_path = text_path(data_dir, &candidate.user_id, &candidate.item_id)?;

  if !path_exists(&manifest_path).await {
    return Ok(ManifestCheckResult::NeedsTagging);
  }
  let manifest_bytes = fs::read(&manifest_path).await?;
  let manifest: ImageTagManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(ManifestCheckResult::NeedsTagging),
  };

  if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
    return Ok(ManifestCheckResult::NeedsTagging);
  }

  if manifest.status == "succeeded" {
    if path_exists(&text_path).await {
      return Ok(ManifestCheckResult::AlreadySucceeded);
    }
    return Ok(ManifestCheckResult::NeedsTagging);
  }

  if manifest.status == "failed" {
    return Ok(ManifestCheckResult::AlreadyFailed);
  }

  Ok(ManifestCheckResult::NeedsTagging)
}

async fn request_image_tagging(
  client: &reqwest::Client,
  image_tagging_url: &str,
  file_name: &str,
  mime_type: &str,
  file_bytes: Vec<u8>,
) -> TagOutcome {
  let part = match Part::bytes(file_bytes).file_name(file_name.to_owned()).mime_str(mime_type) {
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
    let success = parsed.get("success").and_then(|value| value.as_bool()).unwrap_or(false);
    if !success {
      return TagOutcome::EndpointUnavailable("image tagging service returned success=false".to_owned());
    }
    let duration_ms = parsed.get("duration_ms").and_then(|value| value.as_u64());
    return TagOutcome::Success(parsed, duration_ms);
  }

  if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
    return TagOutcome::DocumentFailed(format!("HTTP {}: {}", status, body));
  }

  TagOutcome::EndpointUnavailable(format!("HTTP {}: {}", status, body))
}

async fn write_success_artifacts(
  data_dir: &str,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  tag_data: &Value,
  duration_ms: Option<u64>,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = text_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::write(&text_path, serde_json::to_vec_pretty(tag_data)?).await?;
  let manifest = ImageTagManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: ImageTagManifestExtractor {
      image_tagging_url: image_tagging_url.to_owned(),
      tagged_at_unix_secs: unix_now_secs()?,
      duration_ms,
    },
    error: None,
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

async fn write_failed_manifest(
  data_dir: &str,
  image_tagging_url: &str,
  candidate: &ImageCandidate,
  error_message: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = text_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&text_path).await {
    fs::remove_file(&text_path).await?;
  }
  let manifest = ImageTagManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "failed".to_owned(),
    source_mime_type: candidate.mime_type.clone(),
    content_mime_type: JSON_CONTENT_MIME_TYPE.to_owned(),
    extractor: ImageTagManifestExtractor {
      image_tagging_url: image_tagging_url.to_owned(),
      tagged_at_unix_secs: unix_now_secs()?,
      duration_ms: None,
    },
    error: Some(error_message.to_owned()),
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

fn text_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_text", item_id));
  Ok(path)
}

fn manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = text_shard_dir(data_dir, user_id, item_id)?;
  path.push(format!("{}_manifest.json", item_id));
  Ok(path)
}

fn text_shard_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut text_dir = user_text_dir(data_dir, user_id)?;
  text_dir.push(&item_id[..2]);
  Ok(text_dir)
}

async fn clear_item_image_tag_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  let manifest_path = manifest_path(data_dir, user_id, item_id)?;
  let text_path = text_path(data_dir, user_id, item_id)?;
  if path_exists(&manifest_path).await {
    fs::remove_file(&manifest_path).await?;
  }
  if path_exists(&text_path).await {
    fs::remove_file(&text_path).await?;
  }
  Ok(())
}

fn user_text_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push("text");
  Ok(path)
}

fn unix_now_secs() -> InfuResult<i64> {
  Ok(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map_err(|e| format!("Could not determine current unix time: {}", e))?
      .as_secs() as i64,
  )
}

async fn ensure_user_text_dir(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let text_dir = user_text_dir(data_dir, user_id)?;
  if !path_exists(&text_dir).await {
    fs::create_dir_all(&text_dir).await?;
  }
  ensure_256_subdirs(&text_dir).await?;
  Ok(text_dir)
}
