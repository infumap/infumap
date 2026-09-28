#![allow(dead_code)]

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info};
use once_cell::sync::OnceCell;
use tokio::sync::Mutex;
use tokio::task;
use tokio::time::sleep;

use crate::ai::fragment::sources::{
  build_markdown_fragment_artifact, build_pdf_fragment_artifact, build_text_fragment_artifact,
  pdf_fragment_source_for_item,
};
use crate::ai::fragment::{FragmentBuildOutcome, item_fragment_artifact_files_exist};
use crate::ai::fragment_indexing::enqueue_fragment_lexical_index_update;
use crate::ai::gpu_tools::{GPU_TOOL_PDF_EXTRACT_CAPTION_ONLY, gpu_tools_url_from_config, resolve_gpu_tool_url};
use crate::ai::metrics::{METRIC_AI_DOCUMENT_FRAGMENT_PROCESSED_TOTAL, METRIC_AI_DOCUMENT_FRAGMENT_QUEUE_DEPTH};
use crate::ai::processing_retry::RetrySchedule;
use crate::ai::search_activity::{self as activity, Stage};
use crate::ai::text_extraction::{PdfTextArtifactState, pdf_text_artifact_state};
use crate::ai::user_id_for_log;
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;
use crate::storage::object::ObjectStore;

const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";
const MARKDOWN_SOURCE_MIME_TYPE: &str = "text/markdown";
const TEXT_SOURCE_MIME_TYPE: &str = "text/plain";

static DOCUMENT_FRAGMENT_PIPELINE_STATE: OnceCell<Arc<Mutex<DocumentFragmentPipelineState>>> = OnceCell::new();

#[derive(Clone)]
struct DocumentFragmentPipelineConfig {
  data_dir: String,
  gpu_tools_url: Option<String>,
  object_store: Arc<ObjectStore>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum DocumentFragmentKind {
  Pdf,
  Markdown,
  Text,
}

impl DocumentFragmentKind {
  fn from_item(item: &Item) -> Option<DocumentFragmentKind> {
    match item.mime_type.as_deref()? {
      PDF_SOURCE_MIME_TYPE => Some(DocumentFragmentKind::Pdf),
      MARKDOWN_SOURCE_MIME_TYPE => Some(DocumentFragmentKind::Markdown),
      TEXT_SOURCE_MIME_TYPE => Some(DocumentFragmentKind::Text),
      _ => None,
    }
  }

  fn label(self) -> &'static str {
    match self {
      DocumentFragmentKind::Pdf => "PDF",
      DocumentFragmentKind::Markdown => "Markdown",
      DocumentFragmentKind::Text => "text",
    }
  }

  fn needs_source_object(self) -> bool {
    matches!(self, DocumentFragmentKind::Markdown | DocumentFragmentKind::Text)
  }
}

#[derive(Clone)]
struct DocumentFragmentCandidate {
  user_id: String,
  item_id: String,
  kind: DocumentFragmentKind,
  caption_fallback: bool,
}

impl DocumentFragmentCandidate {
  fn from_item(item: &Item) -> Option<DocumentFragmentCandidate> {
    Some(DocumentFragmentCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      kind: DocumentFragmentKind::from_item(item)?,
      caption_fallback: false,
    })
  }

  fn pdf(user_id: &str, item_id: &str) -> DocumentFragmentCandidate {
    DocumentFragmentCandidate {
      user_id: user_id.to_owned(),
      item_id: item_id.to_owned(),
      kind: DocumentFragmentKind::Pdf,
      caption_fallback: false,
    }
  }

  fn activity_stage(&self) -> Stage {
    if self.caption_fallback { Stage::PdfCaption } else { Stage::Fragments }
  }

  fn key(&self) -> DocumentFragmentCandidateKey {
    DocumentFragmentCandidateKey {
      item_id: self.item_id.clone(),
      kind: self.kind,
      caption_fallback: self.caption_fallback,
    }
  }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct DocumentFragmentCandidateKey {
  item_id: String,
  kind: DocumentFragmentKind,
  caption_fallback: bool,
}

#[derive(Default)]
struct DocumentFragmentPipelineState {
  queue: VecDeque<DocumentFragmentCandidate>,
  queued_candidate_keys: HashSet<DocumentFragmentCandidateKey>,
  retries: RetrySchedule<DocumentFragmentCandidateKey>,
}

enum DocumentFragmentReconcileOutcome {
  Changed(String),
  Skipped,
  NeedsCaption,
}

pub fn init_document_fragment_pipeline_loop(
  config: &Config,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  let pipeline_config = document_fragment_pipeline_config(config, object_store)?;
  if DOCUMENT_FRAGMENT_PIPELINE_STATE.get().is_some() {
    enqueue_all_loaded_document_fragments(db, pipeline_config);
    return Ok(());
  }

  let state = Arc::new(Mutex::new(DocumentFragmentPipelineState::default()));
  METRIC_AI_DOCUMENT_FRAGMENT_QUEUE_DEPTH.set(0);
  DOCUMENT_FRAGMENT_PIPELINE_STATE
    .set(state.clone())
    .map_err(|_| "Document fragment background pipeline loop is already running in this process.".to_owned())?;

  info!(
    "Starting separate local document and PDF caption workers (gpu_tools={}).",
    on_off(pipeline_config.gpu_tools_url.is_some())
  );

  for caption_worker in [false, true] {
    let worker_config = pipeline_config.clone();
    let worker_db = db.clone();
    let worker_state = state.clone();
    task::spawn(async move {
      run_document_fragment_loop(worker_config, worker_db, worker_state, caption_worker).await;
    });
  }

  enqueue_all_loaded_document_fragments(db, pipeline_config);
  Ok(())
}

pub fn enqueue_document_fragment_item_if_active(item: &Item) {
  let Some(candidate) = DocumentFragmentCandidate::from_item(item) else {
    return;
  };
  enqueue_candidate_if_active(candidate);
}

pub fn enqueue_pdf_fragment_item_if_active(item: &Item) {
  if is_pdf_item(item) {
    enqueue_document_fragment_item_if_active(item);
  }
}

pub fn enqueue_pdf_fragment_ids_if_active(user_id: &str, item_id: &str) {
  enqueue_candidate_if_active(DocumentFragmentCandidate::pdf(user_id, item_id));
}

pub fn dequeue_document_fragment_item_if_active(item_id: &str) {
  let Some(state) = DOCUMENT_FRAGMENT_PIPELINE_STATE.get() else {
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
pub async fn requeue_document_fragment_item_now(item: &Item) {
  let Some(state) = DOCUMENT_FRAGMENT_PIPELINE_STATE.get() else {
    return;
  };
  let mut state = state.lock().await;
  remove_candidate(&mut state, &item.id);
  if let Some(candidate) = DocumentFragmentCandidate::from_item(item) {
    enqueue_due_candidate(&mut state, candidate);
  }
}

pub fn dequeue_pdf_fragment_item_if_active(item_id: &str) {
  dequeue_document_fragment_item_if_active(item_id);
}

pub fn is_document_fragment_item(item: &Item) -> bool {
  DocumentFragmentKind::from_item(item).is_some()
}

fn document_fragment_pipeline_config(
  config: &Config,
  object_store: Arc<ObjectStore>,
) -> InfuResult<DocumentFragmentPipelineConfig> {
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let gpu_tools_url = gpu_tools_url_from_config(config)?;
  Ok(DocumentFragmentPipelineConfig { data_dir, gpu_tools_url, object_store })
}

async fn run_document_fragment_loop(
  config: DocumentFragmentPipelineConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<DocumentFragmentPipelineState>>,
  caption_worker: bool,
) {
  loop {
    let candidate = {
      let mut state = state.lock().await;
      pop_candidate(&mut state, caption_worker)
    };

    let Some(candidate) = candidate else {
      sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };

    match reconcile_document_fragment_item(&config, db.clone(), &candidate).await {
      Ok(DocumentFragmentReconcileOutcome::Changed(user_id)) => {
        state.lock().await.retries.clear(&candidate.key());
        activity::done(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
        record_document_fragment_processed("success");
        enqueue_fragment_lexical_index_update(&user_id, &candidate.item_id);
      }
      Ok(DocumentFragmentReconcileOutcome::Skipped) => {
        state.lock().await.retries.clear(&candidate.key());
        activity::done(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
        record_document_fragment_processed("skipped");
      }
      Ok(DocumentFragmentReconcileOutcome::NeedsCaption) => {
        let mut state = state.lock().await;
        state.retries.clear(&candidate.key());
        activity::done(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
        let mut candidate = candidate;
        candidate.caption_fallback = true;
        enqueue_candidate(&mut state, candidate);
      }
      Err(e) => {
        let delay = {
          let mut state = state.lock().await;
          let delay = state.retries.failed(candidate.key());
          enqueue_candidate(&mut state, candidate.clone());
          delay
        };
        activity::retry(&candidate.user_id, &candidate.item_id, candidate.activity_stage(), &e.to_string(), delay);
        info!("Document fragment retry for '{}' in {} seconds.", candidate.item_id, delay.as_secs());
        record_document_fragment_processed("failed");
        error!(
          "Document fragment pipeline failed for {} '{}' (user '{}'): {}",
          candidate.kind.label(),
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
      }
    }
  }
}

async fn reconcile_document_fragment_item(
  config: &DocumentFragmentPipelineConfig,
  db: Arc<Mutex<Db>>,
  candidate: &DocumentFragmentCandidate,
) -> InfuResult<DocumentFragmentReconcileOutcome> {
  let item_snapshot = {
    let db = db.lock().await;
    match db.item.get(&candidate.item_id) {
      Ok(item)
        if item.owner_id == candidate.user_id && DocumentFragmentKind::from_item(item) == Some(candidate.kind) =>
      {
        item.clone()
      }
      _ => return Ok(DocumentFragmentReconcileOutcome::Skipped),
    }
  };

  if item_fragment_artifact_files_exist(&config.data_dir, &item_snapshot.owner_id, &item_snapshot.id).await? {
    return Ok(DocumentFragmentReconcileOutcome::Skipped);
  }

  if candidate.kind == DocumentFragmentKind::Pdf {
    match pdf_text_artifact_state(&config.data_dir, &candidate.user_id, &candidate.item_id).await? {
      PdfTextArtifactState::Succeeded => {}
      PdfTextArtifactState::Blocked => {
        return Err("PDF is password protected; waiting for successful extraction.".into());
      }
      PdfTextArtifactState::Failed => return Err("PDF extraction failed; waiting for its retry to succeed.".into()),
      PdfTextArtifactState::Pending => return Err("Waiting for PDF text extraction.".into()),
    }
  }

  // Read existing PDF text locally first. Only the separate caption worker may
  // discover/call GPU tools, so an outage cannot hold up local fragment work.
  let needs_caption = candidate.kind == DocumentFragmentKind::Pdf
    && pdf_fragment_source_for_item(&config.data_dir, &item_snapshot).await?.is_none();
  if needs_caption && !candidate.caption_fallback {
    return Ok(DocumentFragmentReconcileOutcome::NeedsCaption);
  }
  let pdf_caption_url = if needs_caption {
    resolve_gpu_tool_url(config.gpu_tools_url.as_deref(), GPU_TOOL_PDF_EXTRACT_CAPTION_ONLY)
      .await
      .map_err(|e| format!("Could not discover PDF first-page caption fallback endpoint: {}", e))?
      .map(|url| url.to_string())
  } else {
    None
  };
  let object_encryption_key = {
    let db = db.lock().await;
    let needs_source_object = candidate.kind.needs_source_object()
      || (candidate.kind == DocumentFragmentKind::Pdf && pdf_caption_url.is_some());
    if needs_source_object {
      Some(
        db.user
          .get(&item_snapshot.owner_id)
          .ok_or(format!("User '{}' not loaded.", item_snapshot.owner_id))?
          .object_encryption_key
          .clone(),
      )
    } else {
      None
    }
  };
  let outcome =
    build_document_fragment_artifact(config, &item_snapshot, candidate.kind, object_encryption_key, pdf_caption_url)
      .await?;

  if outcome.wrote_fragments {
    debug!(
      "Document fragment pipeline wrote {} fragment(s) for {} '{}' (user {}).",
      outcome.fragment_count,
      candidate.kind.label(),
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  } else if outcome.cleared_existing_fragments {
    debug!(
      "Document fragment pipeline cleared stale fragments for {} '{}' (user {}).",
      candidate.kind.label(),
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  }

  Ok(if outcome.wrote_fragments || outcome.cleared_existing_fragments {
    DocumentFragmentReconcileOutcome::Changed(item_snapshot.owner_id)
  } else {
    DocumentFragmentReconcileOutcome::Skipped
  })
}

async fn build_document_fragment_artifact(
  config: &DocumentFragmentPipelineConfig,
  item: &Item,
  kind: DocumentFragmentKind,
  object_encryption_key: Option<String>,
  pdf_caption_url: Option<String>,
) -> InfuResult<FragmentBuildOutcome> {
  match kind {
    DocumentFragmentKind::Pdf => Ok(
      build_pdf_fragment_artifact(
        &config.data_dir,
        config.object_store.clone(),
        item,
        object_encryption_key.as_deref(),
        pdf_caption_url.as_deref(),
      )
      .await?
      .outcome,
    ),
    DocumentFragmentKind::Markdown => {
      let object_encryption_key =
        object_encryption_key.as_deref().ok_or("Markdown fragmenting requires a source object encryption key.")?;
      Ok(
        build_markdown_fragment_artifact(&config.data_dir, config.object_store.clone(), item, object_encryption_key)
          .await?
          .outcome,
      )
    }
    DocumentFragmentKind::Text => {
      let object_encryption_key =
        object_encryption_key.as_deref().ok_or("Text fragmenting requires a source object encryption key.")?;
      Ok(
        build_text_fragment_artifact(&config.data_dir, config.object_store.clone(), item, object_encryption_key)
          .await?
          .outcome,
      )
    }
  }
}

fn enqueue_all_loaded_document_fragments(db: Arc<Mutex<Db>>, config: DocumentFragmentPipelineConfig) {
  let Some(state) = DOCUMENT_FRAGMENT_PIPELINE_STATE.get() else {
    return;
  };
  let state = state.clone();
  activity::begin_startup_scan();
  let _enqueue_task = task::spawn(async move {
    populate_initial_document_fragment_queue(&config, db, state).await;
  });
}

async fn populate_initial_document_fragment_queue(
  _config: &DocumentFragmentPipelineConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<DocumentFragmentPipelineState>>,
) {
  let candidates = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|item_key| db.item.get(&item_key.item_id).ok())
      .filter_map(DocumentFragmentCandidate::from_item)
      .collect::<Vec<_>>()
  };

  let count = candidates.len();
  let mut state = state.lock().await;
  for candidate in candidates {
    enqueue_candidate(&mut state, candidate.clone());
    activity::checking(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
  }
  activity::end_startup_scan();
  info!("Queued {} document items for startup fragment checks, including unfinished and failed work.", count);
}

fn enqueue_candidate_if_active(candidate: DocumentFragmentCandidate) {
  let Some(state) = DOCUMENT_FRAGMENT_PIPELINE_STATE.get() else {
    return;
  };

  if let Ok(mut state) = state.try_lock() {
    enqueue_due_candidate(&mut state, candidate);
    return;
  }

  let state = state.clone();
  let _enqueue = task::spawn(async move {
    let mut state = state.lock().await;
    enqueue_due_candidate(&mut state, candidate);
  });
}

fn enqueue_due_candidate(state: &mut DocumentFragmentPipelineState, candidate: DocumentFragmentCandidate) {
  state.retries.clear(&candidate.key());
  activity::due(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
  enqueue_candidate(state, candidate);
}

fn enqueue_candidate(state: &mut DocumentFragmentPipelineState, candidate: DocumentFragmentCandidate) -> bool {
  if !state.queued_candidate_keys.insert(candidate.key()) {
    return false;
  }
  activity::queued(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
  state.queue.push_back(candidate);
  record_document_fragment_queue_depth(state);
  true
}

fn pop_candidate(state: &mut DocumentFragmentPipelineState, caption_worker: bool) -> Option<DocumentFragmentCandidate> {
  let position = state
    .queue
    .iter()
    .position(|candidate| candidate.caption_fallback == caption_worker && state.retries.ready(&candidate.key()))?;
  let candidate = state.queue.remove(position)?;
  state.queued_candidate_keys.remove(&candidate.key());
  activity::running(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
  record_document_fragment_queue_depth(state);
  Some(candidate)
}

fn remove_candidate(state: &mut DocumentFragmentPipelineState, item_id: &str) -> usize {
  let before = state.queue.len();
  for candidate in state.queue.iter().filter(|candidate| candidate.item_id == item_id) {
    state.retries.clear(&candidate.key());
    activity::forget_stage(&candidate.user_id, &candidate.item_id, candidate.activity_stage());
  }
  state.queue.retain(|candidate| candidate.item_id != item_id);
  state.queued_candidate_keys.retain(|candidate_key| candidate_key.item_id != item_id);
  let removed = before.saturating_sub(state.queue.len());
  record_document_fragment_queue_depth(state);
  removed
}

fn record_document_fragment_queue_depth(state: &DocumentFragmentPipelineState) {
  METRIC_AI_DOCUMENT_FRAGMENT_QUEUE_DEPTH.set(state.queue.len() as i64);
}

fn record_document_fragment_processed(outcome: &'static str) {
  METRIC_AI_DOCUMENT_FRAGMENT_PROCESSED_TOTAL.with_label_values(&[outcome]).inc();
}

fn is_pdf_item(item: &Item) -> bool {
  DocumentFragmentKind::from_item(item) == Some(DocumentFragmentKind::Pdf)
}

fn on_off(value: bool) -> &'static str {
  if value { "on" } else { "off" }
}
