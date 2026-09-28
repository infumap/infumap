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

#![allow(dead_code)]

use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info};
use once_cell::sync::OnceCell;
use reqwest::Url;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::{task, time};

use crate::ai::artifact_paths::item_text_manifest_path;
use crate::ai::document_pipeline::enqueue_pdf_fragment_ids_if_active;
use crate::ai::gpu_tools::{
  GPU_TOOL_PDF_EXTRACT, GPU_TOOL_PDF_EXTRACT_JOBS, gpu_tools_url_from_config, resolve_gpu_tool_url,
};
use crate::ai::metrics::{METRIC_AI_PDF_TEXT_EXTRACTION_PROCESSED_TOTAL, METRIC_AI_PDF_TEXT_EXTRACTION_QUEUE_DEPTH};
use crate::ai::processing_retry::{RetrySchedule, manifest_retry_delay, manifest_retry_reason, record_manifest_retry};
use crate::ai::search_activity::{self as activity, Stage};
use crate::ai::search_reconciliation::StartupWork;
use crate::ai::user_id_for_log;
use crate::config::{CONFIG_DATA_DIR, CONFIG_GPU_TOOLS_URL};
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object, ObjectStore};
use crate::util::retry::endpoint_retry_delay;

mod artifacts;

#[allow(unused_imports)]
pub use artifacts::FailedPdfInfo;
pub use artifacts::{
  PdfTextArtifactState, delete_item_text_dir, item_needs_text_extraction, list_failed_pdfs, pdf_text_artifact_state,
};

use self::artifacts::{
  ManifestCheckResult, clear_item_text_dir, manifest_check, write_failed_manifest, write_password_required_manifest,
  write_success_artifacts,
};

const REQUEST_TIMEOUT_SECS: u64 = 4 * 60 * 60;
const ASYNC_POLL_SECS: u64 = 2;
const ASYNC_PROGRESS_LOG_SECS: u64 = 60;
const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";
pub(super) const PDF_PASSWORD_REQUIRED_ERROR_CODE: &str = "pdf_password_required";
const CLI_FAILED_MANIFEST_EXTRACTOR_URL: &str = "manual://extract-cli";

static PROCESSING_STATE: OnceCell<Arc<Mutex<ProcessingState>>> = OnceCell::new();

#[derive(Clone)]
struct PdfCandidate {
  user_id: String,
  item_id: String,
  file_size_bytes: Option<i64>,
  creation_date: i64,
  last_modified_date: i64,
}

impl PdfCandidate {
  fn from_item(item: &Item) -> PdfCandidate {
    PdfCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      file_size_bytes: item.file_size_bytes,
      creation_date: item.creation_date,
      last_modified_date: item.last_modified_date,
    }
  }
}

fn pdf_candidate_for_item(item: &Item) -> Option<PdfCandidate> {
  (item.mime_type.as_deref() == Some(PDF_SOURCE_MIME_TYPE)).then(|| PdfCandidate::from_item(item))
}

pub(crate) struct LoadedPdfExtraction {
  candidate: PdfCandidate,
  file_bytes: Vec<u8>,
}

struct ProcessingState {
  queue: Vec<PdfCandidate>,
  queued_item_ids: HashSet<String>,
  retries: RetrySchedule<String>,
}

#[derive(Deserialize)]
struct PdfToMdResponse {
  success: bool,
  markdown: String,
  duration_ms: u64,
  // Kept as raw JSON so that unexpected metadata cannot fail an extraction.
  #[serde(default)]
  metadata: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct PdfErrorResponse {
  error_code: Option<String>,
  error: Option<String>,
  detail: Option<PdfErrorDetail>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PdfErrorDetail {
  Structured { error_code: Option<String>, error: Option<String> },
  Message(String),
}

struct ParsedPdfError {
  error_code: Option<String>,
  message: Option<String>,
}

#[derive(Deserialize)]
struct PdfExtractJobResponse {
  job_id: String,
  status: String,
  http_status: Option<u16>,
  error: Option<String>,
}

enum ExtractOutcome {
  Success(PdfToMdResponse),
  DocumentFailed(String),
  DocumentBlocked { error_code: String, message: String },
  EndpointUnavailable(String),
}

pub(crate) enum PdfTextExtractionProcessOutcome {
  Extracted,
  Blocked,
}

#[derive(Clone)]
struct PdfTextExtractionEndpoint {
  extract_url: String,
  async_jobs_available: bool,
}

pub fn enqueue_pdf_item_if_active(item: &Item) {
  let Some(state) = PROCESSING_STATE.get() else {
    return;
  };

  let Some(candidate) = pdf_candidate_for_item(item) else {
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

/// Queues the item again without any retry delay, e.g. for explicit reprocessing.
pub async fn requeue_pdf_item_now(item: &Item) {
  let Some(state) = PROCESSING_STATE.get() else {
    return;
  };
  let mut state = state.lock().await;
  remove_candidate(&mut state, &item.id);
  if let Some(candidate) = pdf_candidate_for_item(item) {
    enqueue_candidate(&mut state, candidate);
  }
}

pub async fn extract_single_item_no_retry(
  data_dir: &str,
  text_extraction_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<()> {
  extract_single_item_inner(data_dir, text_extraction_url, db, object_store, item_id, false).await
}

async fn extract_single_item_inner(
  data_dir: &str,
  text_extraction_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
  retry_endpoint_unavailable: bool,
) -> InfuResult<()> {
  let loaded = load_pdf_for_extraction(data_dir, text_extraction_url, db.clone(), object_store, item_id).await?;
  process_loaded_pdf_extraction(data_dir, text_extraction_url, db, loaded, retry_endpoint_unavailable).await
}

pub(crate) async fn load_pdf_for_extraction(
  data_dir: &str,
  text_extraction_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  item_id: &str,
) -> InfuResult<LoadedPdfExtraction> {
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
  debug!(
    "Starting source object read/decrypt for PDF '{}' (user {}).",
    candidate.item_id,
    user_id_for_log(&candidate.user_id)
  );
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
      debug!(
        "Could not read source PDF object for '{}' (user {}) after {}: {}",
        candidate.item_id,
        user_id_for_log(&candidate.user_id),
        format_duration_for_log(elapsed),
        error_message
      );
      if let Some(manifest_error_message) = manifest_failure_for_object_read_error(&error_message) {
        clear_item_text_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
        write_failed_manifest(data_dir, text_extraction_url, &candidate, &manifest_error_message).await?;
      }
      return Err(format!("Could not read source PDF object for '{}': {}", candidate.item_id, error_message).into());
    }
  };
  let object_read_elapsed = object_read_started_at.elapsed();
  debug!(
    "Completed source object read/decrypt for PDF '{}' (user {}) in {} ({} bytes).",
    candidate.item_id,
    user_id_for_log(&candidate.user_id),
    format_duration_for_log(object_read_elapsed),
    file_bytes.len()
  );
  Ok(LoadedPdfExtraction { candidate, file_bytes })
}

pub(crate) async fn process_loaded_pdf_extraction(
  data_dir: &str,
  text_extraction_url: &str,
  db: Arc<Mutex<Db>>,
  loaded: LoadedPdfExtraction,
  retry_endpoint_unavailable: bool,
) -> InfuResult<()> {
  let LoadedPdfExtraction { candidate, file_bytes } = loaded;
  clear_item_text_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
  let client = reqwest::ClientBuilder::new()
    .connect_timeout(Duration::from_secs(10))
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build HTTP client: {}", e))?;
  let started_at = Instant::now();
  let outcome = if retry_endpoint_unavailable {
    request_text_extraction_with_retries(&client, text_extraction_url, &candidate, &file_bytes, None).await
  } else {
    request_text_extraction_once(&client, text_extraction_url, &candidate, &file_bytes).await
  };
  if !candidate_still_current(db.clone(), &candidate).await? {
    return Err(
      format!("Item '{}' was deleted or replaced while extraction was in progress.", candidate.item_id).into(),
    );
  }
  match outcome {
    ExtractOutcome::Success(response) => {
      let markdown_bytes = response.markdown.len();
      let backend = write_success_artifacts(data_dir, text_extraction_url, &candidate, response, &file_bytes).await?;
      enqueue_pdf_fragment_ids_if_active(&candidate.user_id, &candidate.item_id);
      log_pdf_extracted(&candidate, backend.as_deref(), started_at.elapsed(), markdown_bytes);
    }
    ExtractOutcome::DocumentFailed(msg) => {
      write_failed_manifest(data_dir, text_extraction_url, &candidate, &msg).await?;
      enqueue_pdf_fragment_ids_if_active(&candidate.user_id, &candidate.item_id);
      return Err(format!("PDF text extraction failed for '{}': {}", candidate.item_id, msg).into());
    }
    ExtractOutcome::DocumentBlocked { error_code, message } => {
      write_password_required_manifest(data_dir, text_extraction_url, &candidate, &message).await?;
      info!(
        "PDF text extraction blocked for '{}' (user {}): {} ({})",
        candidate.item_id,
        user_id_for_log(&candidate.user_id),
        message,
        error_code
      );
    }
    ExtractOutcome::EndpointUnavailable(msg) => {
      return Err(format!("Text extraction endpoint unavailable: {}", msg).into());
    }
  }
  Ok(())
}

pub(crate) async fn process_loaded_pdf_extraction_web_background(
  data_dir: &str,
  text_extraction_url: &str,
  async_jobs_available: bool,
  db: Arc<Mutex<Db>>,
  loaded: LoadedPdfExtraction,
) -> InfuResult<PdfTextExtractionProcessOutcome> {
  let LoadedPdfExtraction { candidate, file_bytes } = loaded;
  let client = reqwest::ClientBuilder::new()
    .connect_timeout(Duration::from_secs(10))
    .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
    .build()
    .map_err(|e| format!("Could not build HTTP client: {}", e))?;
  let started_at = Instant::now();
  let outcome = if async_jobs_available {
    match time::timeout(
      Duration::from_secs(REQUEST_TIMEOUT_SECS),
      request_text_extraction_async_polling(&client, text_extraction_url, &candidate, &file_bytes),
    )
    .await
    {
      Ok(outcome) => outcome,
      Err(_) => ExtractOutcome::EndpointUnavailable("Async PDF extraction timed out.".to_owned()),
    }
  } else {
    request_text_extraction_once(&client, text_extraction_url, &candidate, &file_bytes).await
  };
  if !candidate_still_current(db.clone(), &candidate).await? {
    return Err(
      format!("Item '{}' was deleted or replaced while extraction was in progress.", candidate.item_id).into(),
    );
  }
  match outcome {
    ExtractOutcome::Success(response) => {
      let markdown_bytes = response.markdown.len();
      let backend = write_success_artifacts(data_dir, text_extraction_url, &candidate, response, &file_bytes).await?;
      enqueue_pdf_fragment_ids_if_active(&candidate.user_id, &candidate.item_id);
      log_pdf_extracted(&candidate, backend.as_deref(), started_at.elapsed(), markdown_bytes);
      Ok(PdfTextExtractionProcessOutcome::Extracted)
    }
    ExtractOutcome::DocumentFailed(msg) => {
      write_failed_manifest(data_dir, text_extraction_url, &candidate, &msg).await?;
      enqueue_pdf_fragment_ids_if_active(&candidate.user_id, &candidate.item_id);
      Err(format!("PDF text extraction failed for '{}': {}", candidate.item_id, msg).into())
    }
    ExtractOutcome::DocumentBlocked { error_code, message } => {
      write_password_required_manifest(data_dir, text_extraction_url, &candidate, &message).await?;
      debug!(
        "PDF text extraction blocked for '{}' (user {}): {} ({})",
        candidate.item_id,
        user_id_for_log(&candidate.user_id),
        message,
        error_code
      );
      Ok(PdfTextExtractionProcessOutcome::Blocked)
    }
    ExtractOutcome::EndpointUnavailable(msg) => Err(format!("Text extraction endpoint unavailable: {}", msg).into()),
  }
}

pub async fn mark_item_text_extraction_failed(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  item_id: &str,
  reason_maybe: Option<&str>,
) -> InfuResult<()> {
  let candidate = {
    let db = db.lock().await;
    let id = item_id.to_string();
    let item = db.item.get(&id).map_err(|e| e.to_string())?;
    if item.mime_type.as_deref() != Some("application/pdf") {
      return Err(format!("Item '{}' is not a PDF (mime_type: {:?}).", item_id, item.mime_type).into());
    }
    PdfCandidate::from_item(item)
  };
  clear_item_text_dir(data_dir, &candidate.user_id, &candidate.item_id).await?;
  let error_message = match reason_maybe.map(|reason| reason.trim()).filter(|reason| !reason.is_empty()) {
    Some(reason) => format!("Marked failed via CLI: {}", reason),
    None => "Marked failed via CLI.".to_owned(),
  };
  write_failed_manifest(data_dir, CLI_FAILED_MANIFEST_EXTRACTOR_URL, &candidate, &error_message).await?;
  info!(
    "Marked PDF '{}' (user {}) as failed for text extraction via CLI.",
    candidate.item_id,
    user_id_for_log(&candidate.user_id)
  );
  Ok(())
}

pub fn init_text_extraction_processing_loop(
  config: &Config,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  startup_work: Arc<StartupWork>,
) -> InfuResult<()> {
  let gpu_tools_url = gpu_tools_url_from_config(config)?.unwrap_or_default();
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  start_text_extraction_processing_loop(data_dir, gpu_tools_url, Duration::ZERO, db, object_store, startup_work)
}

pub fn start_text_extraction_processing_loop(
  data_dir: String,
  gpu_tools_url: String,
  request_delay: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  startup_work: Arc<StartupWork>,
) -> InfuResult<()> {
  if let Some(state) = PROCESSING_STATE.get() {
    enqueue_all_loaded_pdfs(data_dir, db, state.clone(), startup_work);
    return Ok(());
  }
  let state = Arc::new(Mutex::new(ProcessingState {
    queue: vec![],
    queued_item_ids: HashSet::new(),
    retries: RetrySchedule::default(),
  }));
  PROCESSING_STATE
    .set(state.clone())
    .map_err(|_| "Text extraction processing loop is already running in this process.".to_owned())?;

  if request_delay.is_zero() {
    info!("Starting PDF text extraction loop from GPU tools URL '{}'.", gpu_tools_url);
  } else {
    info!(
      "Starting PDF text extraction loop from GPU tools URL '{}' (delay {:.3}s).",
      gpu_tools_url,
      request_delay.as_secs_f64()
    );
  }
  activity::begin_startup_scan();
  let _worker = task::spawn(async move {
    run_text_extraction_loop(data_dir, gpu_tools_url, request_delay, db, object_store, state, startup_work).await;
  });

  Ok(())
}

fn enqueue_all_loaded_pdfs(
  data_dir: String,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ProcessingState>>,
  startup_work: Arc<StartupWork>,
) {
  activity::begin_startup_scan();
  let _enqueue_task = task::spawn(async move {
    populate_initial_pdf_queue(&data_dir, db, state, &startup_work).await;
  });
}

async fn discover_pdf_text_extraction_endpoint(gpu_tools_url: &str) -> InfuResult<Option<PdfTextExtractionEndpoint>> {
  let Some(extract_url) = resolve_gpu_tool_url(Some(gpu_tools_url), GPU_TOOL_PDF_EXTRACT).await? else {
    return Ok(None);
  };
  let async_jobs_available = resolve_gpu_tool_url(Some(gpu_tools_url), GPU_TOOL_PDF_EXTRACT_JOBS).await?.is_some();
  Ok(Some(PdfTextExtractionEndpoint { extract_url: extract_url.to_string(), async_jobs_available }))
}

async fn run_text_extraction_loop(
  data_dir: String,
  gpu_tools_url: String,
  request_delay: Duration,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ProcessingState>>,
  startup_work: Arc<StartupWork>,
) {
  populate_initial_pdf_queue(&data_dir, db.clone(), state.clone(), &startup_work).await;
  loop {
    let candidate = { pop_candidate(&mut *state.lock().await).0 };
    let Some(candidate) = candidate else {
      time::sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };
    let result: InfuResult<bool> = async {
      if !candidate_still_current(db.clone(), &candidate).await? {
        return Ok(false);
      }
      // Deliberate trade-off: accepted output is kept when GPU tools or models
      // change; reprocessing is manual (see handle_reprocess_item).
      if matches!(manifest_check(&data_dir, &candidate).await?, ManifestCheckResult::AlreadySucceeded) {
        enqueue_pdf_fragment_ids_if_active(&candidate.user_id, &candidate.item_id);
        return Ok(false);
      }
      let path = item_text_manifest_path(&data_dir, &candidate.user_id, &candidate.item_id)?;
      let delay = manifest_retry_delay(&path).await?;
      if !delay.is_zero() {
        let reason = manifest_retry_reason(&path)
          .await?
          .unwrap_or_else(|| "A previous attempt failed; another attempt is scheduled.".to_owned());
        activity::retry(&candidate.user_id, &candidate.item_id, Stage::PdfExtraction, &reason, delay);
        let mut state = state.lock().await;
        state.retries.defer(candidate.item_id.clone(), delay);
        enqueue_candidate(&mut state, candidate.clone());
        return Ok(false);
      }
      if gpu_tools_url.trim().is_empty() {
        return Err(format!("PDF processing service is not configured ({}).", CONFIG_GPU_TOOLS_URL).into());
      }
      let endpoint = discover_pdf_text_extraction_endpoint(&gpu_tools_url)
        .await?
        .ok_or("Configured GPU service does not advertise PDF extraction.")?;
      let loaded =
        load_pdf_for_extraction(&data_dir, &endpoint.extract_url, db.clone(), object_store.clone(), &candidate.item_id)
          .await?;
      match process_loaded_pdf_extraction_web_background(
        &data_dir,
        &endpoint.extract_url,
        endpoint.async_jobs_available,
        db.clone(),
        loaded,
      )
      .await?
      {
        PdfTextExtractionProcessOutcome::Extracted => Ok(true),
        PdfTextExtractionProcessOutcome::Blocked => {
          Err("PDF is password protected; extraction will be revisited.".into())
        }
      }
    }
    .await;
    match result {
      Ok(extracted) => {
        let mut state = state.lock().await;
        // A deferred retry re-queued the item; keep its reported reason.
        if !state.queued_item_ids.contains(&candidate.item_id) {
          state.retries.clear(&candidate.item_id);
          activity::done(&candidate.user_id, &candidate.item_id, Stage::PdfExtraction);
        }
        record_pdf_text_extraction_processed(if extracted { "success" } else { "skipped" });
      }
      Err(error) => {
        let (delay, attempt) = {
          let mut state = state.lock().await;
          let delay = state.retries.failed(candidate.item_id.clone());
          enqueue_candidate(&mut state, candidate.clone());
          (delay, state.retries.attempts(&candidate.item_id))
        };
        let reason = error.to_string();
        activity::retry(&candidate.user_id, &candidate.item_id, Stage::PdfExtraction, &reason, delay);
        if let Ok(path) = item_text_manifest_path(&data_dir, &candidate.user_id, &candidate.item_id) {
          if let Err(error) = record_manifest_retry(&path, delay).await {
            error!("Could not save PDF retry hint for '{}': {}", candidate.item_id, error);
          }
        }
        record_pdf_text_extraction_processed("failed");
        log::log!(
          activity::failure_log_level(&reason, attempt),
          "PDF extraction failed for '{}' (user {}): {} Retrying in {}.",
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          reason,
          format_duration_for_log(delay)
        );
      }
    }
    if !request_delay.is_zero() {
      time::sleep(request_delay).await;
    }
  }
}

fn log_pdf_extracted(candidate: &PdfCandidate, backend: Option<&str>, elapsed: Duration, markdown_bytes: usize) {
  info!(
    "Extracted text for PDF '{}' (user {}) using {} in {} ({} bytes of markdown).",
    candidate.item_id,
    user_id_for_log(&candidate.user_id),
    backend.unwrap_or("unknown backend"),
    format_duration_for_log(elapsed),
    markdown_bytes
  );
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

async fn request_text_extraction_with_retries(
  client: &reqwest::Client,
  text_extraction_url: &str,
  candidate: &PdfCandidate,
  file_bytes: &[u8],
  worker_id_maybe: Option<usize>,
) -> ExtractOutcome {
  let mut unavailable_attempt = 0usize;

  loop {
    let outcome = request_text_extraction(client, text_extraction_url, file_bytes.to_vec()).await;
    match outcome {
      ExtractOutcome::EndpointUnavailable(message) => {
        let delay = endpoint_retry_delay(unavailable_attempt);
        unavailable_attempt += 1;
        match worker_id_maybe {
          Some(worker_id) => {
            info!(
              "Worker {}: text extraction endpoint '{}' is unavailable for PDF '{}' (user {}) ({}). Retrying in {}.",
              worker_id,
              text_extraction_url,
              candidate.item_id,
              user_id_for_log(&candidate.user_id),
              message,
              format_duration_for_log(delay)
            );
          }
          None => {
            info!(
              "Text extraction endpoint '{}' is unavailable for PDF '{}' (user {}) ({}). Retrying in {}.",
              text_extraction_url,
              candidate.item_id,
              user_id_for_log(&candidate.user_id),
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
                "Worker {}: text extraction endpoint '{}' accepted requests again for PDF '{}' (user {}) after {} unavailable attempt(s).",
                worker_id,
                text_extraction_url,
                candidate.item_id,
                user_id_for_log(&candidate.user_id),
                unavailable_attempt
              );
            }
            None => {
              info!(
                "Text extraction endpoint '{}' accepted requests again for PDF '{}' (user {}) after {} unavailable attempt(s).",
                text_extraction_url,
                candidate.item_id,
                user_id_for_log(&candidate.user_id),
                unavailable_attempt
              );
            }
          }
        }
        return other;
      }
    }
  }
}

async fn request_text_extraction_once(
  client: &reqwest::Client,
  text_extraction_url: &str,
  _candidate: &PdfCandidate,
  file_bytes: &[u8],
) -> ExtractOutcome {
  request_text_extraction(client, text_extraction_url, file_bytes.to_vec()).await
}

async fn request_text_extraction_async_polling(
  client: &reqwest::Client,
  text_extraction_url: &str,
  candidate: &PdfCandidate,
  file_bytes: &[u8],
) -> ExtractOutcome {
  let jobs_url = match text_extraction_jobs_url(text_extraction_url) {
    Ok(url) => url,
    Err(e) => return ExtractOutcome::EndpointUnavailable(e),
  };
  let part = match Part::bytes(file_bytes.to_vec()).mime_str("application/pdf") {
    Ok(part) => part,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not build multipart upload: {}", e)),
  };
  let form = Form::new().part("file", part);
  let response = match client
    .post(jobs_url.as_str())
    .header(
      "Idempotency-Key",
      format!("{}:{}", pdf_extraction_idempotency_key(candidate), infusdk::util::uid::new_uid()),
    )
    .multipart(form)
    .send()
    .await
  {
    Ok(response) => response,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not submit async job: {}", e)),
  };
  let status = response.status();
  let body = match response.text().await {
    Ok(body) => body,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not read async submit response body: {}", e)),
  };
  if !status.is_success() {
    return ExtractOutcome::EndpointUnavailable(format!("Async submit returned HTTP {}: {}", status, body));
  }
  let mut job = match serde_json::from_str::<PdfExtractJobResponse>(&body) {
    Ok(job) => job,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not parse async submit response: {}", e)),
  };
  let job_status_url = format!("{}/{}", jobs_url.as_str().trim_end_matches('/'), job.job_id);
  let job_result_url = format!("{}/result", job_status_url);
  let poll_started_at = Instant::now();
  let mut last_progress_log_at = Instant::now();
  info!(
    "Submitted async text extraction job '{}' for PDF '{}' (user {}).",
    job.job_id,
    candidate.item_id,
    user_id_for_log(&candidate.user_id)
  );

  loop {
    match job.status.as_str() {
      "queued" | "running" => {
        if poll_started_at.elapsed() >= Duration::from_secs(REQUEST_TIMEOUT_SECS) {
          return ExtractOutcome::EndpointUnavailable("Async PDF job exceeded the processing time limit.".to_owned());
        }
        if last_progress_log_at.elapsed() >= Duration::from_secs(ASYNC_PROGRESS_LOG_SECS) {
          info!(
            "Async text extraction job '{}' for PDF '{}' (user {}) is still {} after {}.",
            job.job_id,
            candidate.item_id,
            user_id_for_log(&candidate.user_id),
            job.status,
            format_duration_for_log(poll_started_at.elapsed())
          );
          last_progress_log_at = Instant::now();
        }
        time::sleep(Duration::from_secs(ASYNC_POLL_SECS)).await;
        job = match poll_text_extraction_job(client, &job_status_url).await {
          Ok(job) => job,
          Err(outcome) => return outcome,
        };
      }
      "succeeded" | "failed" => {
        return fetch_text_extraction_job_result(client, &job_result_url).await;
      }
      other => {
        return ExtractOutcome::EndpointUnavailable(format!(
          "Async job '{}' returned unknown status '{}' (http_status={:?}, error={:?})",
          job.job_id, other, job.http_status, job.error
        ));
      }
    }
  }
}

async fn poll_text_extraction_job(
  client: &reqwest::Client,
  job_status_url: &str,
) -> Result<PdfExtractJobResponse, ExtractOutcome> {
  let response = client
    .get(job_status_url)
    .send()
    .await
    .map_err(|e| ExtractOutcome::EndpointUnavailable(format!("Could not poll async job: {}", e)))?;
  let status = response.status();
  let body = response
    .text()
    .await
    .map_err(|e| ExtractOutcome::EndpointUnavailable(format!("Could not read async poll response body: {}", e)))?;
  if !status.is_success() {
    return Err(ExtractOutcome::EndpointUnavailable(format!("Async poll returned HTTP {}: {}", status, body)));
  }
  serde_json::from_str::<PdfExtractJobResponse>(&body)
    .map_err(|e| ExtractOutcome::EndpointUnavailable(format!("Could not parse async poll response: {}", e)))
}

async fn fetch_text_extraction_job_result(client: &reqwest::Client, job_result_url: &str) -> ExtractOutcome {
  let response = match client.get(job_result_url).send().await {
    Ok(response) => response,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not fetch async job result: {}", e)),
  };
  let status = response.status();
  let body = match response.text().await {
    Ok(body) => body,
    Err(e) => return ExtractOutcome::EndpointUnavailable(format!("Could not read async result response body: {}", e)),
  };
  parse_text_extraction_response(status, body)
}

fn pop_candidate(state: &mut ProcessingState) -> (Option<PdfCandidate>, usize) {
  let Some(position) = state.queue.iter().rposition(|candidate| state.retries.ready(&candidate.item_id)) else {
    return (None, state.queue.len());
  };
  let candidate = state.queue.remove(position);
  state.queued_item_ids.remove(&candidate.item_id);
  activity::running(&candidate.user_id, &candidate.item_id, Stage::PdfExtraction);
  let remaining = state.queue.len();
  record_pdf_text_extraction_queue_depth(state);
  (Some(candidate), remaining)
}

fn enqueue_candidate(state: &mut ProcessingState, candidate: PdfCandidate) {
  if state.queued_item_ids.contains(&candidate.item_id) {
    return;
  }

  activity::queued(&candidate.user_id, &candidate.item_id, Stage::PdfExtraction);
  state.queue.push(candidate);
  state.queue.sort_by(compare_pdf_candidates_desc);

  state.queued_item_ids.clear();
  for queued_candidate in &state.queue {
    state.queued_item_ids.insert(queued_candidate.item_id.clone());
  }
  record_pdf_text_extraction_queue_depth(state);
}

fn remove_candidate(state: &mut ProcessingState, item_id: &str) {
  state.retries.clear(&item_id.to_owned());
  for candidate in state.queue.iter().filter(|candidate| candidate.item_id == item_id) {
    activity::forget_stage(&candidate.user_id, &candidate.item_id, Stage::PdfExtraction);
  }
  state.queue.retain(|candidate| candidate.item_id != item_id);
  state.queued_item_ids.remove(item_id);
  record_pdf_text_extraction_queue_depth(state);
}

fn record_pdf_text_extraction_queue_depth(state: &ProcessingState) {
  METRIC_AI_PDF_TEXT_EXTRACTION_QUEUE_DEPTH.set(state.queue.len() as i64);
}

fn record_pdf_text_extraction_processed(outcome: &'static str) {
  METRIC_AI_PDF_TEXT_EXTRACTION_PROCESSED_TOTAL.with_label_values(&[outcome]).inc();
}

fn compare_pdf_candidates_desc(a: &PdfCandidate, b: &PdfCandidate) -> std::cmp::Ordering {
  let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
  let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
  b_size.cmp(&a_size).then(b.last_modified_date.cmp(&a.last_modified_date)).then(b.item_id.cmp(&a.item_id))
}

/// Only PDFs the startup check could not confirm as complete are considered;
/// PDFs with current fragments necessarily have successful extraction.
async fn populate_initial_pdf_queue(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ProcessingState>>,
  startup_work: &StartupWork,
) {
  let candidates = {
    let db = db.lock().await;
    let mut candidates = db
      .item
      .all_loaded_items()
      .into_iter()
      .filter(|item_and_user_id| startup_work.content_item_ids.contains(&item_and_user_id.item_id))
      .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().and_then(pdf_candidate_for_item))
      .collect::<Vec<PdfCandidate>>();
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
  let mut already_blocked = 0usize;
  let mut artifact_errors = 0usize;

  for candidate in candidates {
    match manifest_check(data_dir, &candidate).await {
      Ok(ManifestCheckResult::NeedsExtraction) => pending_candidates.push(candidate),
      Ok(ManifestCheckResult::AlreadySucceeded) => already_succeeded += 1,
      Ok(ManifestCheckResult::AlreadyFailed) => {
        already_failed += 1;
        pending_candidates.push(candidate);
      }
      Ok(ManifestCheckResult::AlreadyBlocked) => {
        already_blocked += 1;
        pending_candidates.push(candidate);
      }
      Err(e) => {
        artifact_errors += 1;
        error!(
          "Queueing PDF '{}' (user {}) despite startup artifact error: {}",
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
        pending_candidates.push(candidate);
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
  activity::end_startup_scan();

  info!(
    "Initialized PDF text extraction queue with {} pending item(s) from {} PDF(s) the startup check found unfinished (already succeeded: {}, already failed: {}, already blocked: {}, queued despite artifact errors: {}).",
    scheduled, total_candidates, already_succeeded, already_failed, already_blocked, artifact_errors
  );
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

async fn request_text_extraction(
  client: &reqwest::Client,
  text_extraction_url: &str,
  file_bytes: Vec<u8>,
) -> ExtractOutcome {
  let part = match Part::bytes(file_bytes).mime_str("application/pdf") {
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

  parse_text_extraction_response(status, body)
}

fn parse_text_extraction_response(status: reqwest::StatusCode, body: String) -> ExtractOutcome {
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

  if is_terminal_document_response(status) {
    let parsed_error = parse_pdf_error_response(&body);
    if parsed_error.error_code.as_deref() == Some(PDF_PASSWORD_REQUIRED_ERROR_CODE) {
      return ExtractOutcome::DocumentBlocked {
        error_code: PDF_PASSWORD_REQUIRED_ERROR_CODE.to_owned(),
        message: parsed_error
          .message
          .unwrap_or_else(|| "The PDF is password protected and cannot be processed without a password.".to_owned()),
      };
    }

    let message = parsed_error.message.unwrap_or(body);
    return ExtractOutcome::DocumentFailed(format!("HTTP {}: {}", status, message));
  }

  ExtractOutcome::EndpointUnavailable(format!("HTTP {}: {}", status, body))
}

fn parse_pdf_error_response(body: &str) -> ParsedPdfError {
  let Ok(parsed) = serde_json::from_str::<PdfErrorResponse>(body) else {
    return ParsedPdfError { error_code: None, message: None };
  };

  let mut error_code = parsed.error_code;
  let mut message = parsed.error;
  if let Some(detail) = parsed.detail {
    match detail {
      PdfErrorDetail::Structured { error_code: detail_error_code, error: detail_error } => {
        if error_code.is_none() {
          error_code = detail_error_code;
        }
        if message.is_none() {
          message = detail_error;
        }
      }
      PdfErrorDetail::Message(detail_message) => {
        if message.is_none() {
          message = Some(detail_message);
        }
      }
    }
  }

  ParsedPdfError { error_code, message }
}

fn text_extraction_jobs_url(text_extraction_url: &str) -> Result<Url, String> {
  let mut url = Url::parse(text_extraction_url)
    .map_err(|e| format!("Could not parse text extraction URL '{}': {}", text_extraction_url, e))?;
  let path = url.path().trim_end_matches('/');
  let jobs_path = if path.ends_with("/pdf-extract") {
    format!("{}/jobs", path)
  } else if let Some(prefix) = path.strip_suffix("/convert") {
    format!("{}/pdf-extract/jobs", prefix.trim_end_matches('/'))
  } else {
    format!("{}/pdf-extract/jobs", path)
  };
  url.set_path(&jobs_path);
  url.set_query(None);
  Ok(url)
}

fn pdf_extraction_idempotency_key(candidate: &PdfCandidate) -> String {
  format!(
    "infumap-pdf-extract:{}:{}:{}:{}:{}",
    candidate.user_id,
    candidate.item_id,
    candidate.creation_date,
    candidate.last_modified_date,
    candidate.file_size_bytes.unwrap_or(-1)
  )
}

fn is_terminal_document_response(status: reqwest::StatusCode) -> bool {
  matches!(status, reqwest::StatusCode::UNPROCESSABLE_ENTITY | reqwest::StatusCode::PAYLOAD_TOO_LARGE)
}

fn on_off(value: bool) -> &'static str {
  if value { "on" } else { "off" }
}
