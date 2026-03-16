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

static PROCESSING_STATE: OnceCell<Arc<Mutex<ProcessingState>>> = OnceCell::new();

#[derive(Clone)]
struct PdfCandidate {
  user_id: String,
  item_id: String,
  title: String,
  mime_type: String,
  file_size_bytes: Option<i64>,
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

pub fn enqueue_pdf_item_if_active(item: &Item) {
  let Some(state) = PROCESSING_STATE.get() else {
    return;
  };

  let Ok(mut state) = state.try_lock() else {
    return;
  };

  if !state.scan_exhausted {
    return;
  }

  let candidate = PdfCandidate {
    user_id: item.owner_id.clone(),
    item_id: item.id.clone(),
    title: item.title.clone().unwrap_or_else(|| format!("{}.pdf", item.id)),
    mime_type: item.mime_type.clone().unwrap_or_else(|| "application/pdf".to_owned()),
    file_size_bytes: item.file_size_bytes,
    last_modified_date: item.last_modified_date,
  };

  enqueue_candidate(&mut state, candidate);
}

pub fn text_extraction_url_from_config(
  config: &Config,
) -> InfuResult<Option<String>> {
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
  let state = Arc::new(Mutex::new(ProcessingState {
    queue: vec![],
    queued_item_ids: HashSet::new(),
    scan_exhausted: false,
  }));
  let _ = PROCESSING_STATE.set(state.clone());

  let _forever = task::spawn(async move {
    loop {
      let candidate = {
        let mut state = state.lock().await;
        pop_candidate(&mut state)
      };

      let candidate = match candidate {
        Some(candidate) => candidate,
        None => {
          let should_refill = {
            let state = state.lock().await;
            !state.scan_exhausted
          };

          if !should_refill {
            time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
          }

          match refill_queue(&data_dir, db.clone(), state.clone()).await {
            Ok(true) => continue,
            Ok(false) => {
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
            error!(
              "Could not process PDF '{}' for user '{}': user is not loaded.",
              candidate.item_id, candidate.user_id
            );
            time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
          }
        }
      };

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
          error!(
            "Could not read PDF '{}' for user '{}': {}",
            candidate.item_id, candidate.user_id, e
          );
          time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
          continue;
        }
      };

      match request_text_extraction(&client, &text_extraction_url, &candidate.title, file_bytes).await {
        ExtractOutcome::Success(response) => {
          if let Err(e) = write_success_artifacts(&data_dir, &text_extraction_url, &candidate, response).await {
            error!(
              "Could not write text artifacts for PDF '{}' for user '{}': {}",
              candidate.item_id, candidate.user_id, e
            );
            time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            continue;
          }
          info!(
            "Generated markdown for PDF '{}' for user '{}'.",
            candidate.item_id, candidate.user_id
          );
        }
        ExtractOutcome::DocumentFailed(message) => {
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
        }
        ExtractOutcome::EndpointUnavailable(message) => {
          info!(
            "text extraction endpoint '{}' is unavailable ({}). Pausing PDF text extraction for 5 minutes.",
            text_extraction_url, message
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
) -> InfuResult<bool> {
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
        last_modified_date: item.last_modified_date,
      })
      .collect::<Vec<PdfCandidate>>();
    candidates.sort_by(|a, b| {
      let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
      let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
      a_size
        .cmp(&b_size)
        .then(a.last_modified_date.cmp(&b.last_modified_date))
        .then(a.item_id.cmp(&b.item_id))
    });
    candidates
  };

  let mut state = state.lock().await;
  state.queue.clear();
  state.queued_item_ids.clear();

  for candidate in candidates {
    if needs_text_extraction(data_dir, &candidate).await? {
      enqueue_candidate(&mut state, candidate);
      if state.queue.len() >= MAX_PENDING_PDFS {
        break;
      }
    }
  }

  state.scan_exhausted = state.queue.is_empty();
  Ok(!state.queue.is_empty())
}

fn pop_candidate(state: &mut ProcessingState) -> Option<PdfCandidate> {
  let candidate = state.queue.pop()?;
  state.queued_item_ids.remove(&candidate.item_id);
  Some(candidate)
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

fn compare_pdf_candidates_desc(a: &PdfCandidate, b: &PdfCandidate) -> std::cmp::Ordering {
  let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
  let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
  b_size
    .cmp(&a_size)
    .then(b.last_modified_date.cmp(&a.last_modified_date))
    .then(b.item_id.cmp(&a.item_id))
}

async fn needs_text_extraction(data_dir: &str, candidate: &PdfCandidate) -> InfuResult<bool> {
  let manifest_path = manifest_path(data_dir, &candidate.user_id, &candidate.item_id)?;
  let markdown_path = markdown_path(data_dir, &candidate.user_id, &candidate.item_id)?;

  if !path_exists(&manifest_path).await {
    return Ok(true);
  }

  let manifest_bytes = fs::read(&manifest_path).await?;
  let manifest: TextManifest = match serde_json::from_slice(&manifest_bytes) {
    Ok(manifest) => manifest,
    Err(_) => return Ok(true),
  };

  let source_matches = manifest.source.item_id == candidate.item_id && manifest.source.user_id == candidate.user_id;

  if !source_matches {
    return Ok(true);
  }

  if manifest.status == "succeeded" && !path_exists(&markdown_path).await {
    return Ok(true);
  }

  Ok(false)
}

async fn request_text_extraction(
  client: &reqwest::Client,
  text_extraction_url: &str,
  file_name: &str,
  file_bytes: Vec<u8>,
) -> ExtractOutcome {
  let part = match Part::bytes(file_bytes)
    .file_name(file_name.to_owned())
    .mime_str("application/pdf")
  {
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
