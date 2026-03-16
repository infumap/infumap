use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{error, info};
use once_cell::sync::OnceCell;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
const ENDPOINT_BACKOFF_SECS: u64 = 5 * 60;
const REQUEST_TIMEOUT_SECS: u64 = 4 * 60 * 60;
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_PENDING_PDFS: usize = 50;
const REFILL_WHEN_QUEUE_AT_MOST: usize = 25;
const LARGE_PDF_SIZE_BYTES: i64 = 25 * 1024 * 1024;

static PROCESSING_STATE: OnceCell<Arc<Mutex<ProcessingState>>> = OnceCell::new();

#[derive(Clone)]
struct PdfCandidate {
  user_id: String,
  item_id: String,
  title: String,
  mime_type: String,
  file_size_bytes: Option<i64>,
  creation_date: i64,
  last_modified_date: i64,
}

struct ProcessingState {
  queue: Vec<PdfCandidate>,
  queued_item_ids: HashSet<String>,
  scan_exhausted: bool,
}

#[derive(Deserialize)]
struct PdfToMdResponse {
  success: bool,
  markdown: String,
  metadata: Value,
  duration_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct TextManifest {
  schema_version: u32,
  status: String,
  source: TextManifestSource,
  extractor: TextManifestExtractor,
  error: Option<String>,
  metadata: Option<Value>,
}

#[derive(Serialize, Deserialize)]
struct TextManifestSource {
  user_id: String,
  item_id: String,
  file_name: String,
  mime_type: String,
  file_size_bytes: Option<i64>,
  last_modified_date: i64,
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

  let candidate = PdfCandidate {
    user_id: item.owner_id.clone(),
    item_id: item.id.clone(),
    title: item.title.clone().unwrap_or_else(|| format!("{}.pdf", item.id)),
    mime_type: item.mime_type.clone().unwrap_or_else(|| "application/pdf".to_owned()),
    file_size_bytes: item.file_size_bytes,
    creation_date: item.creation_date,
    last_modified_date: item.last_modified_date,
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
  let pdf_item_ids: Vec<(String, String)> = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|iu| db.item.get(&iu.item_id).ok().map(|item| (iu.user_id.clone(), item)))
      .filter(|(_, item)| item.mime_type.as_deref() == Some("application/pdf"))
      .map(|(user_id, item)| (user_id, item.id.clone()))
      .collect()
  };
  for (user_id, item_id) in pdf_item_ids {
    let path = match manifest_path(data_dir, &user_id, &item_id) {
      Ok(p) => p,
      Err(_) => continue,
    };
    if !path_exists(&path).await {
      continue;
    }
    let bytes = match fs::read(&path).await {
      Ok(b) => b,
      Err(_) => continue,
    };
    let manifest: TextManifest = match serde_json::from_slice(&bytes) {
      Ok(m) => m,
      Err(_) => continue,
    };
    if manifest.status != "failed" {
      continue;
    }
    out.push(FailedPdfInfo { user_id, item_id, file_name: manifest.source.file_name, error: manifest.error });
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
    let c = PdfCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      title: item.title.clone().unwrap_or_else(|| format!("{}.pdf", item.id)),
      mime_type: item.mime_type.clone().unwrap_or_else(|| "application/pdf".to_owned()),
      file_size_bytes: item.file_size_bytes,
      creation_date: item.creation_date,
      last_modified_date: item.last_modified_date,
    };
    (c, key)
  };
  clear_item_text_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
  let file_bytes = storage_object::get(
    object_store.clone(),
    candidate.user_id.clone(),
    candidate.item_id.clone(),
    &object_encryption_key,
  )
  .await?;
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
  start_text_extraction_processing_loop(data_dir, text_extraction_url, db, object_store)
}

pub fn start_text_extraction_processing_loop(
  data_dir: String,
  text_extraction_url: String,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  let client = reqwest::ClientBuilder::new()
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build text extraction HTTP client: {}", e))?;
  let state =
    Arc::new(Mutex::new(ProcessingState { queue: vec![], queued_item_ids: HashSet::new(), scan_exhausted: false }));
  let _ = PROCESSING_STATE.set(state.clone());

  let _forever = task::spawn(async move {
    let mut progress = ExtractionProgress { processed: 0, succeeded: 0, document_failed: 0, other_failed: 0 };
    loop {
      let (candidate, queue_remaining) = {
        let mut state = state.lock().await;
        pop_candidate(&mut state)
      };

      let (candidate, queue_remaining) = match (candidate, queue_remaining) {
        (Some(c), rem) => {
          if rem <= REFILL_WHEN_QUEUE_AT_MOST {
            let should_refill = {
              let state = state.lock().await;
              !state.scan_exhausted
            };
            if should_refill {
              match refill_queue(&data_dir, db.clone(), state.clone(), Some(&c.item_id)).await {
                Ok((true, _total, _checked, queued, _already_succeeded, _already_failed, _none)) => {
                  info!(
                    "Starting text extraction for PDF '{}' (user {}). Queued {} additional PDFs while this item is in progress. Progress: {}",
                    c.item_id,
                    c.user_id,
                    queued,
                    progress.summary()
                  );
                }
                Ok((false, _total, _checked, _queued, _already_succeeded, _already_failed, _none)) => {
                  info!(
                    "Starting text extraction for PDF '{}' (user {}). No additional PDFs were queued while this item is in progress. Progress: {}",
                    c.item_id,
                    c.user_id,
                    progress.summary()
                  );
                }
                Err(e) => {
                  error!("Could not refill PDF text extraction queue: {}", e);
                }
              }
            }
          }
          (c, rem)
        }
        (None, _) => {
          let should_refill = {
            let state = state.lock().await;
            !state.scan_exhausted
          };

          if !should_refill {
            time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
          }

          match refill_queue(&data_dir, db.clone(), state.clone(), None).await {
            Ok((true, total, checked, _queued, already_succeeded, already_failed, none)) => {
              info!(
                "PDF text extraction queue refill: {}/{} manifest checks (succeed: {}, failure: {}, none: {}). Progress: {}",
                checked,
                total,
                already_succeeded,
                already_failed,
                none,
                progress.summary()
              );
              continue;
            }
            Ok((false, total, checked, _queued, already_succeeded, already_failed, none)) => {
              info!(
                "PDF text extraction queue refill: {}/{} manifest checks (success: {}, failure: {}, none: {}). Progress: {}",
                checked,
                total,
                already_succeeded,
                already_failed,
                none,
                progress.summary()
              );
              time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
              continue;
            }
            Err(e) => {
              error!("Could not refill PDF text extraction queue: {}", e);
              time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
              continue;
            }
          }
        }
      };

      let object_encryption_key = {
        let db = db.lock().await;
        match db.user.get(&candidate.user_id) {
          Some(user) => user.object_encryption_key.clone(),
          None => {
            progress.on_other_failed();
            info!(
              "PDF '{}' (user {}): user not loaded. {} remaining. {}",
              candidate.item_id,
              candidate.user_id,
              queue_remaining,
              progress.summary()
            );
            error!(
              "Could not process PDF '{}' for user '{}': user is not loaded.",
              candidate.item_id, candidate.user_id
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
          progress.on_other_failed();
          info!(
            "PDF '{}' (user {}): object read failed: {}. {} remaining. {}",
            candidate.item_id,
            candidate.user_id,
            e,
            queue_remaining,
            progress.summary()
          );
          error!("Could not read PDF '{}' for user '{}': {}", candidate.item_id, candidate.user_id, e);
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
      };

      let outcome = request_text_extraction(&client, &text_extraction_url, &candidate.title, file_bytes).await;
      let item_is_current = match candidate_still_current(db.clone(), &candidate).await {
        Ok(current) => current,
        Err(e) => {
          progress.on_other_failed();
          error!(
            "Could not verify current state for PDF '{}' for user '{}': {}",
            candidate.item_id, candidate.user_id, e
          );
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
      };
      if !item_is_current {
        progress.on_other_failed();
        info!(
          "PDF '{}' (user {}): item was deleted or replaced while extraction was in progress. Skipping artifact write. {} remaining. {}",
          candidate.item_id,
          candidate.user_id,
          queue_remaining,
          progress.summary()
        );
        continue;
      }

      match outcome {
        ExtractOutcome::Success(response) => {
          if let Err(e) = write_success_artifacts(&data_dir, &text_extraction_url, &candidate, response).await {
            progress.on_other_failed();
            info!(
              "PDF '{}' (user {}): write failed: {}. {} remaining. {}",
              candidate.item_id,
              candidate.user_id,
              e,
              queue_remaining,
              progress.summary()
            );
            error!(
              "Could not write text artifacts for PDF '{}' for user '{}': {}",
              candidate.item_id, candidate.user_id, e
            );
            time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
          }
          progress.on_success();
          info!(
            "PDF '{}' (user {}): extracted successfully. {} remaining. {}",
            candidate.item_id,
            candidate.user_id,
            queue_remaining,
            progress.summary()
          );
        }
        ExtractOutcome::DocumentFailed(message) => {
          progress.on_document_failed();
          if let Err(e) = write_failed_manifest(&data_dir, &text_extraction_url, &candidate, &message).await {
            error!(
              "Could not write failed text manifest for PDF '{}' for user '{}': {}",
              candidate.item_id, candidate.user_id, e
            );
          } else {
            error!(
              "PDF markdown generation failed for '{}' for user '{}': {}",
              candidate.item_id, candidate.user_id, message
            );
          }
          info!(
            "PDF '{}' (user {}): extraction failed: {}. {} remaining. {}",
            candidate.item_id,
            candidate.user_id,
            message,
            queue_remaining,
            progress.summary()
          );
        }
        ExtractOutcome::EndpointUnavailable(message) => {
          info!(
            "text extraction endpoint '{}' is unavailable ({}). Pausing PDF text extraction for 5 minutes. Progress: {}",
            text_extraction_url,
            message,
            progress.summary()
          );
          time::sleep(Duration::from_secs(ENDPOINT_BACKOFF_SECS)).await;
        }
      }
    }
  });

  Ok(())
}

async fn refill_queue(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ProcessingState>>,
  exclude_item_id: Option<&str>,
) -> InfuResult<(bool, usize, usize, usize, usize, usize, usize)> {
  let candidates = {
    let db = db.lock().await;
    let mut candidates = db
      .item
      .all_loaded_items()
      .into_iter()
      .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().map(Item::clone))
      .filter(|item| item.mime_type.as_deref() == Some("application/pdf"))
      .map(|item| PdfCandidate {
        user_id: item.owner_id.clone(),
        item_id: item.id.clone(),
        title: item.title.clone().unwrap_or_else(|| format!("{}.pdf", item.id)),
        mime_type: item.mime_type.clone().unwrap_or_else(|| "application/pdf".to_owned()),
        file_size_bytes: item.file_size_bytes,
        creation_date: item.creation_date,
        last_modified_date: item.last_modified_date,
      })
      .collect::<Vec<PdfCandidate>>();
    candidates.sort_by(|a, b| {
      let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
      let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
      a_size.cmp(&b_size).then(a.last_modified_date.cmp(&b.last_modified_date)).then(a.item_id.cmp(&b.item_id))
    });
    candidates
  };

  let total = candidates.len();
  let mut refill_state = ProcessingState { queue: vec![], queued_item_ids: HashSet::new(), scan_exhausted: false };
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
  Ok((!state.queue.is_empty(), total, considered, queued, already_succeeded, already_failed, none))
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
      && item.mime_type.as_deref() == Some("application/pdf"),
  )
}

async fn manifest_check(data_dir: &str, candidate: &PdfCandidate) -> InfuResult<ManifestCheckResult> {
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let markdown_path = markdown_path(data_dir, &candidate.user_id, &candidate.item_id)?;

  if !path_exists(&manifest_path).await {
    return Ok(ManifestCheckResult::NeedsExtraction);
  }

  let manifest_bytes = fs::read(&manifest_path).await?;
  let manifest: TextManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(ManifestCheckResult::NeedsExtraction),
  };

  let source_matches = manifest.source.item_id == candidate.item_id && manifest.source.user_id == candidate.user_id;

  if !source_matches {
    return Ok(ManifestCheckResult::NeedsExtraction);
  }

  if manifest.status == "succeeded" {
    if path_exists(&markdown_path).await {
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
    Err(e) => return ExtractOutcome::DocumentFailed(format!("Could not build multipart upload: {}", e)),
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
          ExtractOutcome::DocumentFailed("text extraction service returned success=false".to_owned())
        }
      }
      Err(e) => ExtractOutcome::EndpointUnavailable(format!("Could not parse success response: {}", e)),
    };
  }

  if status.is_server_error() {
    return ExtractOutcome::EndpointUnavailable(format!("HTTP {}: {}", status, body));
  }

  ExtractOutcome::DocumentFailed(format!("HTTP {}: {}", status, body))
}

async fn write_success_artifacts(
  data_dir: &str,
  text_extraction_url: &str,
  candidate: &PdfCandidate,
  response: PdfToMdResponse,
) -> InfuResult<()> {
  ensure_user_text_dir(data_dir, &candidate.user_id).await?;
  let markdown_path = markdown_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let item_dir = item_text_dir(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::create_dir_all(&item_dir).await?;
  fs::write(&markdown_path, response.markdown.as_bytes()).await?;
  let manifest = TextManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "succeeded".to_owned(),
    source: TextManifestSource {
      user_id: candidate.user_id.clone(),
      item_id: candidate.item_id.clone(),
      file_name: candidate.title.clone(),
      mime_type: candidate.mime_type.clone(),
      file_size_bytes: candidate.file_size_bytes,
      last_modified_date: candidate.last_modified_date,
    },
    extractor: TextManifestExtractor {
      text_extraction_url: text_extraction_url.to_owned(),
      extracted_at_unix_secs: unix_now_secs()?,
      duration_ms: Some(response.duration_ms),
    },
    error: None,
    metadata: Some(response.metadata),
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
  let item_dir = item_text_dir(data_dir, &candidate.user_id, &candidate.item_id)?;
  let markdown_path = markdown_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  fs::create_dir_all(&item_dir).await?;
  if path_exists(&markdown_path).await {
    fs::remove_file(&markdown_path).await?;
  }
  let manifest = TextManifest {
    schema_version: MANIFEST_SCHEMA_VERSION,
    status: "failed".to_owned(),
    source: TextManifestSource {
      user_id: candidate.user_id.clone(),
      item_id: candidate.item_id.clone(),
      file_name: candidate.title.clone(),
      mime_type: candidate.mime_type.clone(),
      file_size_bytes: candidate.file_size_bytes,
      last_modified_date: candidate.last_modified_date,
    },
    extractor: TextManifestExtractor {
      text_extraction_url: text_extraction_url.to_owned(),
      extracted_at_unix_secs: unix_now_secs()?,
      duration_ms: None,
    },
    error: Some(error_message.to_owned()),
    metadata: None,
  };
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
  Ok(())
}

fn markdown_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_text_dir(data_dir, user_id, item_id)?;
  path.push("stage1.md");
  Ok(path)
}

fn manifest_path(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  let mut path = item_text_dir(data_dir, user_id, item_id)?;
  path.push("manifest.json");
  Ok(path)
}

fn item_text_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<PathBuf> {
  if item_id.len() < 2 {
    return Err(format!("Item id '{}' is too short.", item_id).into());
  }
  let mut text_dir = user_text_dir(data_dir, user_id)?;
  text_dir.push(&item_id[..2]);
  text_dir.push(item_id);
  Ok(text_dir)
}

async fn clear_item_text_dir(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<()> {
  let dir = item_text_dir(data_dir, user_id, item_id)?;
  if path_exists(&dir).await {
    fs::remove_dir_all(&dir).await?;
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
