use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info};
use once_cell::sync::OnceCell;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;
use tokio::{task, time};

use crate::config::{CONFIG_DATA_DIR, CONFIG_TEXT_EXTRACTION_URL};
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::util::fs::{ensure_256_subdirs, expand_tilde, path_exists};

const IDLE_POLL_SECS: u64 = 60;
const DEFAULT_ENDPOINT_BACKOFF_SECS: u64 = 5 * 60;
const REQUEST_TIMEOUT_SECS: u64 = 4 * 60 * 60;
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_PENDING_PDFS: usize = 50;
const REFILL_WHEN_QUEUE_AT_MOST: usize = 25;
const LARGE_PDF_SIZE_BYTES: i64 = 25 * 1024 * 1024;
const REFILL_WAIT_MILLIS: u64 = 1000;
const DEFAULT_BACKGROUND_CONCURRENCY: usize = 1;
const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";
const MARKDOWN_CONTENT_MIME_TYPE: &str = "text/markdown";

static PROCESSING_STATE: OnceCell<Arc<Mutex<ProcessingState>>> = OnceCell::new();

#[derive(Clone)]
struct PdfCandidate {
  user_id: String,
  item_id: String,
  title: String,
  file_size_bytes: Option<i64>,
  creation_date: i64,
  last_modified_date: i64,
}

impl PdfCandidate {
  fn from_item(item: &Item) -> PdfCandidate {
    PdfCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      title: item.title.clone().unwrap_or_else(|| format!("{}.pdf", item.id)),
      file_size_bytes: item.file_size_bytes,
      creation_date: item.creation_date,
      last_modified_date: item.last_modified_date,
    }
  }
}

struct ProcessingState {
  queue: Vec<PdfCandidate>,
  queued_item_ids: HashSet<String>,
  scan_exhausted: bool,
  refill_in_progress: bool,
}

#[derive(Deserialize)]
struct PdfToMdResponse {
  success: bool,
  markdown: String,
  duration_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct TextManifest {
  schema_version: u32,
  status: String,
  source_mime_type: String,
  content_mime_type: String,
  extractor: TextManifestExtractor,
  error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct TextManifestExtractor {
  text_extraction_url: String,
  extracted_at_unix_secs: i64,
  duration_ms: Option<u64>,
}

enum ExtractOutcome {
  Success(PdfToMdResponse),
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
  needs_extraction: usize,
}

struct ExtractionProgress {
  processed: u64,
  succeeded: u64,
  document_failed: u64,
  other_failed: u64,
}

impl ExtractionProgress {
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

pub fn enqueue_pdf_item_if_active(item: &Item) {
  let Some(state) = PROCESSING_STATE.get() else {
    return;
  };

  let candidate = PdfCandidate::from_item(item);

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

pub fn dequeue_pdf_item_if_active(item_id: &str) {
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
pub struct FailedPdfInfo {
  pub user_id: String,
  pub item_id: String,
  pub file_name: String,
  pub error: Option<String>,
}

pub async fn list_failed_pdfs(data_dir: &str, db: Arc<Mutex<Db>>) -> InfuResult<Vec<FailedPdfInfo>> {
  let mut out = vec![];
  let pdf_items: Vec<(String, String, String)> = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|iu| db.item.get(&iu.item_id).ok().map(|item| (iu.user_id.clone(), item)))
      .filter(|(_, item)| item.mime_type.as_deref() == Some("application/pdf"))
      .map(|(user_id, item)| {
        (user_id, item.id.clone(), item.title.clone().unwrap_or_else(|| format!("{}.pdf", item.id)))
      })
      .collect()
  };
  for (user_id, item_id, file_name) in pdf_items {
    let path = match manifest_path(data_dir, &user_id, &item_id) {
      Ok(p) => p,
      Err(e) => {
        debug!(
          "Skipping failed PDF listing for item '{}' (user '{}'): could not build manifest path: {}",
          item_id, user_id, e
        );
        continue;
      }
    };
    if !path_exists(&path).await {
      continue;
    }
    let bytes = match fs::read(&path).await {
      Ok(b) => b,
      Err(e) => {
        debug!(
          "Skipping failed PDF listing for item '{}' (user '{}'): could not read manifest '{}': {}",
          item_id,
          user_id,
          path.display(),
          e
        );
        continue;
      }
    };
    let manifest: TextManifest = match serde_json::from_slice(&bytes) {
      Ok(m) => m,
      Err(e) => {
        debug!(
          "Skipping failed PDF listing for item '{}' (user '{}'): could not parse manifest '{}': {}",
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
    out.push(FailedPdfInfo { user_id, item_id, file_name, error: manifest.error });
  }
  Ok(out)
}

pub async fn extract_single_item(
  data_dir: &str,
  text_extraction_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<()> {
  let (candidate, object_encryption_key) = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    if item.mime_type.as_deref() != Some("application/pdf") {
      return Err(format!("Item '{}' is not a PDF (mime_type: {:?}).", item_id, item.mime_type).into());
    }
    let key =
      db.user.get(&item.owner_id).ok_or(format!("User '{}' not loaded.", item.owner_id))?.object_encryption_key.clone();
    let c = PdfCandidate::from_item(item);
    (c, key)
  };
  clear_item_text_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
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
      let error_message = e.to_string();
      if let Some(manifest_error_message) = manifest_failure_for_object_read_error(&error_message) {
        write_failed_manifest(data_dir, text_extraction_url, &candidate, &manifest_error_message).await?;
      }
      return Err(format!("Could not read source PDF object for '{}': {}", candidate.item_id, error_message).into());
    }
  };
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build HTTP client: {}", e))?;
  let outcome = request_text_extraction(&client, text_extraction_url, &candidate.title, file_bytes).await;
  if !candidate_still_current(db.clone(), &candidate).await? {
    return Err(
      format!("Item '{}' was deleted or replaced while extraction was in progress.", candidate.item_id).into(),
    );
  }
  match outcome {
    ExtractOutcome::Success(response) => {
      write_success_artifacts(data_dir, text_extraction_url, &candidate, response).await?;
      info!("Extracted text for PDF '{}' (user {}).", candidate.item_id, candidate.user_id);
    }
    ExtractOutcome::DocumentFailed(msg) => {
      write_failed_manifest(data_dir, text_extraction_url, &candidate, &msg).await?;
      return Err(format!("PDF text extraction failed for '{}': {}", candidate.item_id, msg).into());
    }
    ExtractOutcome::EndpointUnavailable(msg) => {
      return Err(format!("Text extraction endpoint unavailable: {}", msg).into());
    }
  }
  Ok(())
}

pub async fn delete_item_text_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  clear_item_text_dir(data_dir, user_id, item_id).await
}

pub fn text_extraction_url_from_config(config: &Config) -> InfuResult<Option<String>> {
  match config.get_string(CONFIG_TEXT_EXTRACTION_URL) {
    Ok(url) if !url.trim().is_empty() => Ok(Some(url)),
    Ok(_) => Ok(None),
    Err(_) => Ok(None),
  }
}

pub fn init_text_extraction_processing_loop(
  config: &Config,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  let text_extraction_url = match text_extraction_url_from_config(config)? {
    Some(url) => url,
    None => return Ok(()),
  };
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  start_text_extraction_processing_loop(
    data_dir,
    text_extraction_url,
    DEFAULT_BACKGROUND_CONCURRENCY,
    Duration::ZERO,
    Duration::from_secs(DEFAULT_ENDPOINT_BACKOFF_SECS),
    db,
    object_store,
  )
}

pub fn start_text_extraction_processing_loop(
  data_dir: String,
  text_extraction_url: String,
  concurrency: usize,
  request_delay: Duration,
  endpoint_backoff: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  if PROCESSING_STATE.get().is_some() {
    return Err("Text extraction processing loop is already running in this process.".into());
  }
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build text extraction HTTP client: {}", e))?;
  let state = Arc::new(Mutex::new(ProcessingState {
    queue: vec![],
    queued_item_ids: HashSet::new(),
    scan_exhausted: false,
    refill_in_progress: false,
  }));
  PROCESSING_STATE
    .set(state.clone())
    .map_err(|_| "Text extraction processing loop is already running in this process.".to_owned())?;
  let progress =
    Arc::new(Mutex::new(ExtractionProgress { processed: 0, succeeded: 0, document_failed: 0, other_failed: 0 }));

  info!(
    "Starting {} text extraction worker(s) using '{}' with a {:.3}s delay between requests.",
    concurrency,
    text_extraction_url,
    request_delay.as_secs_f64()
  );
  for worker_id in 0..concurrency {
    let worker_state = state.clone();
    let worker_db = db.clone();
    let worker_object_store = object_store.clone();
    let worker_client = client.clone();
    let worker_progress = progress.clone();
    let worker_data_dir = data_dir.clone();
    let worker_text_extraction_url = text_extraction_url.clone();
    let worker_request_delay = request_delay;
    let worker_endpoint_backoff = endpoint_backoff;
    let _worker = task::spawn(async move {
      run_text_extraction_worker(
        worker_id + 1,
        worker_data_dir,
        worker_text_extraction_url,
        worker_request_delay,
        worker_endpoint_backoff,
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

async fn run_text_extraction_worker(
  worker_id: usize,
  data_dir: String,
  text_extraction_url: String,
  request_delay: Duration,
  endpoint_backoff: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  client: reqwest::Client,
  state: Arc<Mutex<ProcessingState>>,
  progress: Arc<Mutex<ExtractionProgress>>,
) {
  let mut endpoint_was_unavailable = false;
  loop {
    let (candidate, queue_remaining) = {
      let mut state = state.lock().await;
      pop_candidate(&mut state)
    };

    let (candidate, queue_remaining) = match (candidate, queue_remaining) {
      (Some(c), rem) => {
        if rem <= REFILL_WHEN_QUEUE_AT_MOST {
          match refill_queue_if_needed(&data_dir, db.clone(), state.clone(), Some(&c.item_id)).await {
            Ok(Some(refill)) => {
              let progress_summary = {
                let progress = progress.lock().await;
                progress.summary()
              };
              info!(
                "Worker {} starting text extraction for PDF '{}' (user {}). Pending queue: {}. Progress: {}",
                worker_id, c.item_id, c.user_id, refill.queued_candidates, progress_summary
              );
            }
            Ok(None) => {}
            Err(e) => {
              error!("Worker {} could not refill PDF text extraction queue: {}", worker_id, e);
            }
          }
        }
        (c, rem)
      }
      (None, _) => match refill_queue_if_needed(&data_dir, db.clone(), state.clone(), None).await {
        Ok(Some(refill)) if refill.found_any => {
          let progress_summary = {
            let progress = progress.lock().await;
            progress.summary()
          };
          info!(
            "PDF text extraction queue refill: {}/{} manifest checks (succeed: {}, failure: {}, none: {}). Progress: {}",
            refill.considered_candidates,
            refill.total_candidates,
            refill.already_succeeded,
            refill.already_failed,
            refill.needs_extraction,
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
            "PDF text extraction queue refill: {}/{} manifest checks (success: {}, failure: {}, none: {}). Progress: {}",
            refill.considered_candidates,
            refill.total_candidates,
            refill.already_succeeded,
            refill.already_failed,
            refill.needs_extraction,
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
          error!("Worker {} could not refill PDF text extraction queue: {}", worker_id, e);
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
            "PDF '{}' (user {}): user not loaded. {} remaining. {}",
            candidate.item_id, candidate.user_id, queue_remaining, progress_summary
          );
          error!(
            "Worker {} could not process PDF '{}' for user '{}': user is not loaded.",
            worker_id, candidate.item_id, candidate.user_id
          );
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
      }
    };

    if candidate.file_size_bytes.map_or(false, |s| s >= LARGE_PDF_SIZE_BYTES) {
      info!(
        "PDF '{}' (user {}): large document (~{} MB); extraction may take a long time and use significant memory.",
        candidate.item_id,
        candidate.user_id,
        candidate.file_size_bytes.map(|s| s / (1024 * 1024)).unwrap_or(0)
      );
    }

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
        let error_message = e.to_string();
        if let Some(manifest_error_message) = manifest_failure_for_object_read_error(&error_message) {
          let item_is_current = match candidate_still_current(db.clone(), &candidate).await {
            Ok(current) => current,
            Err(check_error) => {
              let progress_summary = {
                let mut progress = progress.lock().await;
                progress.on_other_failed();
                progress.summary()
              };
              error!(
                "Worker {} could not verify current state after object read failure for PDF '{}' for user '{}': {}. {}",
                worker_id, candidate.item_id, candidate.user_id, check_error, progress_summary
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
              "PDF '{}' (user {}): source object read failed, but the item was deleted or replaced before failure could be recorded. {} remaining. {}",
              candidate.item_id, candidate.user_id, queue_remaining, progress_summary
            );
            if request_delay > Duration::ZERO {
              time::sleep(request_delay).await;
            }
            continue;
          }
          if let Err(write_error) =
            write_failed_manifest(&data_dir, &text_extraction_url, &candidate, &manifest_error_message).await
          {
            let progress_summary = {
              let mut progress = progress.lock().await;
              progress.on_other_failed();
              progress.summary()
            };
            info!(
              "PDF '{}' (user {}): object read failed and failed manifest write also failed: {}. {} remaining. {}",
              candidate.item_id, candidate.user_id, write_error, queue_remaining, progress_summary
            );
            error!(
              "Worker {} could not write failed text manifest after object read failure for PDF '{}' for user '{}': {}",
              worker_id, candidate.item_id, candidate.user_id, write_error
            );
            time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
          }
          let progress_summary = {
            let mut progress = progress.lock().await;
            progress.on_document_failed();
            progress.summary()
          };
          error!(
            "Worker {} could not read PDF '{}' for user '{}': {}",
            worker_id, candidate.item_id, candidate.user_id, error_message
          );
          info!(
            "PDF '{}' (user {}): extraction failed because the source object is missing. {} remaining. {}",
            candidate.item_id, candidate.user_id, queue_remaining, progress_summary
          );
          if request_delay > Duration::ZERO {
            time::sleep(request_delay).await;
          }
          continue;
        }

        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_other_failed();
          progress.summary()
        };
        info!(
          "PDF '{}' (user {}): object read failed: {}. {} remaining. {}",
          candidate.item_id, candidate.user_id, error_message, queue_remaining, progress_summary
        );
        error!(
          "Worker {} could not read PDF '{}' for user '{}': {}",
          worker_id, candidate.item_id, candidate.user_id, error_message
        );
        time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
        continue;
      }
    };

    info!(
      "Worker {} sending text extraction request for PDF '{}' (user {}) to '{}'.",
      worker_id, candidate.item_id, candidate.user_id, text_extraction_url
    );
    let outcome = request_text_extraction(&client, &text_extraction_url, &candidate.title, file_bytes).await;
    let endpoint_recovered =
      endpoint_was_unavailable && matches!(&outcome, ExtractOutcome::Success(_) | ExtractOutcome::DocumentFailed(_));
    if endpoint_recovered {
      info!(
        "Worker {}: text extraction endpoint '{}' accepted a request again for PDF '{}' (user {}).",
        worker_id, text_extraction_url, candidate.item_id, candidate.user_id
      );
      endpoint_was_unavailable = false;
    }
    let item_is_current = match candidate_still_current(db.clone(), &candidate).await {
      Ok(current) => current,
      Err(e) => {
        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_other_failed();
          progress.summary()
        };
        error!(
          "Worker {} could not verify current state for PDF '{}' for user '{}': {}. {}",
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
        "PDF '{}' (user {}): item was deleted or replaced while extraction was in progress. Skipping artifact write. {} remaining. {}",
        candidate.item_id, candidate.user_id, queue_remaining, progress_summary
      );
      if request_delay > Duration::ZERO {
        time::sleep(request_delay).await;
      }
      continue;
    }

    match outcome {
      ExtractOutcome::Success(response) => {
        if let Err(e) = write_success_artifacts(&data_dir, &text_extraction_url, &candidate, response).await {
          let progress_summary = {
            let mut progress = progress.lock().await;
            progress.on_other_failed();
            progress.summary()
          };
          info!(
            "PDF '{}' (user {}): write failed: {}. {} remaining. {}",
            candidate.item_id, candidate.user_id, e, queue_remaining, progress_summary
          );
          error!(
            "Worker {} could not write text artifacts for PDF '{}' for user '{}': {}",
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
          "PDF '{}' (user {}): extracted successfully. {} remaining. {}",
          candidate.item_id, candidate.user_id, queue_remaining, progress_summary
        );
      }
      ExtractOutcome::DocumentFailed(message) => {
        let progress_summary = {
          let mut progress = progress.lock().await;
          progress.on_document_failed();
          progress.summary()
        };
        if let Err(e) = write_failed_manifest(&data_dir, &text_extraction_url, &candidate, &message).await {
          error!(
            "Worker {} could not write failed text manifest for PDF '{}' for user '{}': {}",
            worker_id, candidate.item_id, candidate.user_id, e
          );
        } else {
          error!(
            "PDF markdown generation failed for '{}' for user '{}': {}",
            candidate.item_id, candidate.user_id, message
          );
        }
        info!(
          "PDF '{}' (user {}): extraction failed: {}. {} remaining. {}",
          candidate.item_id, candidate.user_id, message, queue_remaining, progress_summary
        );
      }
      ExtractOutcome::EndpointUnavailable(message) => {
        endpoint_was_unavailable = true;
        let progress_summary = {
          let progress = progress.lock().await;
          progress.summary()
        };
        info!(
          "Worker {}: text extraction endpoint '{}' is unavailable ({}). Pausing PDF text extraction for {}. Progress: {}",
          worker_id,
          text_extraction_url,
          message,
          format_duration_for_log(endpoint_backoff),
          progress_summary
        );
        time::sleep(endpoint_backoff).await;
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

fn manifest_failure_for_object_read_error(error_message: &str) -> Option<String> {
  if error_message.contains("Unexpected status code getting S3 object") && error_message.contains("404") {
    return Some(format!("Source PDF object is missing from S3 object storage: {}", error_message));
  }
  if error_message.contains("No such file or directory") {
    return Some(format!("Source PDF object is missing from local object storage: {}", error_message));
  }
  None
}

#[cfg(test)]
mod tests {
  use super::manifest_failure_for_object_read_error;

  #[test]
  fn classifies_s3_404_as_terminal_document_failure() {
    let message = "Unexpected status code getting S3 object 'user_item': 404";
    let classified = manifest_failure_for_object_read_error(message);
    assert!(classified.is_some());
    assert!(classified.unwrap().contains("missing"));
  }

  #[test]
  fn classifies_missing_local_file_as_terminal_document_failure() {
    let message = "No such file or directory (os error 2)";
    let classified = manifest_failure_for_object_read_error(message);
    assert!(classified.is_some());
    assert!(classified.unwrap().contains("local object storage"));
  }

  #[test]
  fn leaves_transient_storage_errors_retryable() {
    let message = "Timeout waiting for first byte from S3 for 'user_item'";
    assert!(manifest_failure_for_object_read_error(message).is_none());
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
      .filter(|item| item.mime_type.as_deref() == Some("application/pdf"))
      .map(|item| PdfCandidate::from_item(&item))
      .collect::<Vec<PdfCandidate>>();
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
      ManifestCheckResult::NeedsExtraction => {
        none += 1;
        enqueue_candidate(&mut refill_state, candidate);
        if refill_state.queue.len() >= MAX_PENDING_PDFS {
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
    needs_extraction: none,
  })
}

fn pop_candidate(state: &mut ProcessingState) -> (Option<PdfCandidate>, usize) {
  let candidate = match state.queue.pop() {
    Some(c) => {
      state.queued_item_ids.remove(&c.item_id);
      c
    }
    None => return (None, 0),
  };
  let remaining = state.queue.len();
  (Some(candidate), remaining)
}

fn enqueue_candidate(state: &mut ProcessingState, candidate: PdfCandidate) {
  if state.queued_item_ids.contains(&candidate.item_id) {
    return;
  }

  state.queue.push(candidate);
  state.queue.sort_by(compare_pdf_candidates_desc);

  if state.queue.len() > MAX_PENDING_PDFS {
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

fn compare_pdf_candidates_desc(a: &PdfCandidate, b: &PdfCandidate) -> std::cmp::Ordering {
  let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
  let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
  b_size.cmp(&a_size).then(b.last_modified_date.cmp(&a.last_modified_date)).then(b.item_id.cmp(&a.item_id))
}

enum ManifestCheckResult {
  NeedsExtraction,
  AlreadySucceeded,
  AlreadyFailed,
}

async fn candidate_still_current(db: Arc<Mutex<Db>>, candidate: &PdfCandidate) -> InfuResult<bool> {
  let db = db.lock().await;
  let item = match db.item.get(&candidate.item_id) {
    Ok(item) => item,
    Err(_) => return Ok(false),
  };
  Ok(
    item.owner_id == candidate.user_id
      && item.creation_date == candidate.creation_date
      && item.mime_type.as_deref() == Some(PDF_SOURCE_MIME_TYPE),
  )
}

async fn manifest_check(data_dir: &str, candidate: &PdfCandidate) -> InfuResult<ManifestCheckResult> {
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let text_path = text_path(data_dir, &candidate.user_id, &candidate.item_id)?;

  if !path_exists(&manifest_path).await {
    return Ok(ManifestCheckResult::NeedsExtraction);
  }
  let manifest_bytes = fs::read(&manifest_path).await?;
  let manifest: TextManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(ManifestCheckResult::NeedsExtraction),
  };

  if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
    return Ok(ManifestCheckResult::NeedsExtraction);
  }

  if manifest.status == "succeeded" {
    if path_exists(&text_path).await {
      return Ok(ManifestCheckResult::AlreadySucceeded);
    }
    return Ok(ManifestCheckResult::NeedsExtraction);
  }

  if manifest.status == "failed" {
    return Ok(ManifestCheckResult::AlreadyFailed);
  }

  Ok(ManifestCheckResult::NeedsExtraction)
}

async fn request_text_extraction(
  client: &reqwest::Client,
  text_extraction_url: &str,
  file_name: &str,
  file_bytes: Vec<u8>,
) -> ExtractOutcome {
  let part = match Part::bytes(file_bytes).file_name(file_name.to_owned()).mime_str("application/pdf") {
    Ok(part) => part,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not build multipart upload: {}", e)),
  };
  let form = Form::new().part("file", part);

  let response = match client.post(text_extraction_url).multipart(form).send().await {
    Ok(response) => response,
    Err(e) => return ExtractOutcome::EndpointUnavailable(e.to_string()),
  };

  let status = response.status();
  let body = match response.text().await {
    Ok(body) => body,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not read response body: {}", e)),
  };

  if status.is_success() {
    return match serde_json::from_str::<PdfToMdResponse>(&body) {
      Ok(parsed) => {
        if parsed.success {
          ExtractOutcome::Success(parsed)
        } else {
          ExtractOutcome::EndpointUnavailable("text extraction service returned success=false".to_owned())
        }
      }
      Err(e) => ExtractOutcome::EndpointUnavailable(format!("Could not parse success response: {}", e)),
    };
  }

  if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
    return ExtractOutcome::DocumentFailed(format!("HTTP {}: {}", status, body));
  }

  ExtractOutcome::EndpointUnavailable(format!("HTTP {}: {}", status, body))
}

async fn write_success_artifacts(
  data_dir: &str,
  text_extraction_url: &str,
  candidate: &PdfCandidate,
  response: PdfToMdResponse,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = text_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::write(&text_path, response.markdown.as_bytes()).await?;
  let manifest = TextManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
    content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
    extractor: TextManifestExtractor {
      text_extraction_url: text_extraction_url.to_owned(),
      extracted_at_unix_secs: unix_now_secs()?,
      duration_ms: Some(response.duration_ms),
    },
    error: None,
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

async fn write_failed_manifest(
  data_dir: &str,
  text_extraction_url: &str,
  candidate: &PdfCandidate,
  error_message: &str,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let text_path = text_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  if path_exists(&text_path).await {
    fs::remove_file(&text_path).await?;
  }
  let manifest = TextManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "failed".to_owned(),
    source_mime_type: PDF_SOURCE_MIME_TYPE.to_owned(),
    content_mime_type: MARKDOWN_CONTENT_MIME_TYPE.to_owned(),
    extractor: TextManifestExtractor {
      text_extraction_url: text_extraction_url.to_owned(),
      extracted_at_unix_secs: unix_now_secs()?,
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

async fn clear_item_text_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
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
