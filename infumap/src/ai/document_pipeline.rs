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

use crate::ai::fragment::sources::{build_pdf_fragment_artifact, embedding_context_title_for_item};
use crate::ai::fragment::{clear_item_fragments, item_fragment_artifact_files_exist};
use crate::ai::fragment_indexing::enqueue_fragment_index_rebuild_for_user;
use crate::ai::metrics::{METRIC_AI_DOCUMENT_FRAGMENT_PROCESSED_TOTAL, METRIC_AI_DOCUMENT_FRAGMENT_QUEUE_DEPTH};
use crate::ai::text_extraction::{PdfTextArtifactState, pdf_text_artifact_state, text_extraction_url_from_config};
use crate::ai::user_id_for_log;
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;
use crate::storage::object::ObjectStore;

const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const FRAGMENT_NOT_READY_WAIT_MILLIS: u64 = 1000;
const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";
const MARKDOWN_SOURCE_MIME_TYPE: &str = "text/markdown";
const TEXT_SOURCE_MIME_TYPE: &str = "text/plain";

static DOCUMENT_FRAGMENT_PIPELINE_STATE: OnceCell<Arc<Mutex<DocumentFragmentPipelineState>>> = OnceCell::new();

#[derive(Clone)]
struct DocumentFragmentPipelineConfig {
  data_dir: String,
  text_extraction_enabled: bool,
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

  fn has_background_builder(self) -> bool {
    matches!(self, DocumentFragmentKind::Pdf)
  }
}

#[derive(Clone)]
struct DocumentFragmentCandidate {
  user_id: String,
  item_id: String,
  kind: DocumentFragmentKind,
}

impl DocumentFragmentCandidate {
  fn from_item(item: &Item) -> Option<DocumentFragmentCandidate> {
    Some(DocumentFragmentCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      kind: DocumentFragmentKind::from_item(item)?,
    })
  }

  fn pdf(user_id: &str, item_id: &str) -> DocumentFragmentCandidate {
    DocumentFragmentCandidate {
      user_id: user_id.to_owned(),
      item_id: item_id.to_owned(),
      kind: DocumentFragmentKind::Pdf,
    }
  }

  fn key(&self) -> DocumentFragmentCandidateKey {
    DocumentFragmentCandidateKey { item_id: self.item_id.clone(), kind: self.kind }
  }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct DocumentFragmentCandidateKey {
  item_id: String,
  kind: DocumentFragmentKind,
}

#[derive(Default)]
struct DocumentFragmentPipelineState {
  queue: VecDeque<DocumentFragmentCandidate>,
  queued_candidate_keys: HashSet<DocumentFragmentCandidateKey>,
}

enum DocumentFragmentReadiness {
  Ready,
  Waiting,
  Unavailable,
}

enum DocumentFragmentReconcileOutcome {
  Changed(String),
  Skipped,
  Waiting,
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
    "Starting document fragment background loop (pdf_text_extraction={}).",
    on_off(pipeline_config.text_extraction_enabled)
  );

  let worker_config = pipeline_config.clone();
  let worker_db = db.clone();
  let worker_state = state.clone();
  let _worker = task::spawn(async move {
    run_document_fragment_loop(worker_config, worker_db, worker_state).await;
  });

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
  let text_extraction_enabled = text_extraction_url_from_config(config)?.is_some();
  Ok(DocumentFragmentPipelineConfig { data_dir, text_extraction_enabled, object_store })
}

async fn run_document_fragment_loop(
  config: DocumentFragmentPipelineConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<DocumentFragmentPipelineState>>,
) {
  loop {
    let candidate = {
      let mut state = state.lock().await;
      pop_candidate(&mut state)
    };

    let Some(candidate) = candidate else {
      sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };

    match reconcile_document_fragment_item(&config, db.clone(), &candidate).await {
      Ok(DocumentFragmentReconcileOutcome::Changed(user_id)) => {
        record_document_fragment_processed("success");
        enqueue_fragment_index_rebuild_for_user(&user_id);
      }
      Ok(DocumentFragmentReconcileOutcome::Skipped) => {
        record_document_fragment_processed("skipped");
      }
      Ok(DocumentFragmentReconcileOutcome::Waiting) => {}
      Err(e) => {
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

  if !candidate.kind.has_background_builder() {
    return Ok(DocumentFragmentReconcileOutcome::Skipped);
  }

  if item_fragment_artifact_files_exist(&config.data_dir, &item_snapshot.owner_id, &item_snapshot.id).await? {
    return Ok(DocumentFragmentReconcileOutcome::Skipped);
  }

  match document_fragment_readiness(config, &item_snapshot).await? {
    DocumentFragmentReadiness::Ready => {}
    DocumentFragmentReadiness::Waiting => {
      sleep(Duration::from_millis(FRAGMENT_NOT_READY_WAIT_MILLIS)).await;
      enqueue_pdf_fragment_ids_if_active(&item_snapshot.owner_id, &item_snapshot.id);
      return Ok(DocumentFragmentReconcileOutcome::Waiting);
    }
    DocumentFragmentReadiness::Unavailable => {
      let outcome = clear_item_fragments(&config.data_dir, &item_snapshot).await?;
      if outcome.cleared_existing_fragments {
        debug!(
          "Document fragment pipeline cleared stale fragments for {} '{}' (user {}).",
          candidate.kind.label(),
          item_snapshot.id,
          user_id_for_log(&item_snapshot.owner_id)
        );
      }
      return Ok(if outcome.cleared_existing_fragments {
        DocumentFragmentReconcileOutcome::Changed(item_snapshot.owner_id)
      } else {
        DocumentFragmentReconcileOutcome::Skipped
      });
    }
  }

  let context_title = {
    let db = db.lock().await;
    embedding_context_title_for_item(&db, &item_snapshot)
  };
  let fragment_result = build_pdf_fragment_artifact(&config.data_dir, &item_snapshot, context_title).await?;
  let outcome = fragment_result.outcome;

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

async fn document_fragment_readiness(
  config: &DocumentFragmentPipelineConfig,
  item: &Item,
) -> InfuResult<DocumentFragmentReadiness> {
  match pdf_text_artifact_state(&config.data_dir, &item.owner_id, &item.id).await? {
    PdfTextArtifactState::Succeeded => Ok(DocumentFragmentReadiness::Ready),
    PdfTextArtifactState::Failed => Ok(DocumentFragmentReadiness::Unavailable),
    PdfTextArtifactState::Pending if config.text_extraction_enabled => Ok(DocumentFragmentReadiness::Waiting),
    PdfTextArtifactState::Pending => Ok(DocumentFragmentReadiness::Unavailable),
  }
}

fn enqueue_all_loaded_document_fragments(db: Arc<Mutex<Db>>, config: DocumentFragmentPipelineConfig) {
  let Some(state) = DOCUMENT_FRAGMENT_PIPELINE_STATE.get() else {
    return;
  };
  let state = state.clone();
  let _enqueue_task = task::spawn(async move {
    populate_initial_document_fragment_queue(&config, db, state).await;
  });
}

async fn populate_initial_document_fragment_queue(
  config: &DocumentFragmentPipelineConfig,
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

  let total_candidates = candidates.len();
  let mut pdf_candidates = 0usize;
  let mut markdown_candidates = 0usize;
  let mut text_candidates = 0usize;
  let mut waiting_for_builder = 0usize;
  let mut queued_candidates = Vec::new();
  let mut already_fragmented = 0usize;
  let mut already_succeeded = 0usize;
  let mut already_failed = 0usize;
  let mut pending_waiting_for_extraction = 0usize;
  let mut pending_unavailable = 0usize;
  let mut skipped_errors = 0usize;

  for candidate in candidates {
    match candidate.kind {
      DocumentFragmentKind::Pdf => pdf_candidates += 1,
      DocumentFragmentKind::Markdown => markdown_candidates += 1,
      DocumentFragmentKind::Text => text_candidates += 1,
    }

    if !candidate.kind.has_background_builder() {
      waiting_for_builder += 1;
      continue;
    }

    match item_fragment_artifact_files_exist(&config.data_dir, &candidate.user_id, &candidate.item_id).await {
      Ok(true) => {
        already_fragmented += 1;
        continue;
      }
      Ok(false) => {}
      Err(e) => {
        skipped_errors += 1;
        debug!(
          "Skipping {} '{}' (user {}) during document fragment startup artifact check: {}",
          candidate.kind.label(),
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
        continue;
      }
    }

    match pdf_text_artifact_state(&config.data_dir, &candidate.user_id, &candidate.item_id).await {
      Ok(PdfTextArtifactState::Succeeded) => {
        already_succeeded += 1;
        queued_candidates.push(candidate);
      }
      Ok(PdfTextArtifactState::Failed) => {
        already_failed += 1;
        queued_candidates.push(candidate);
      }
      Ok(PdfTextArtifactState::Pending) if config.text_extraction_enabled => {
        pending_waiting_for_extraction += 1;
      }
      Ok(PdfTextArtifactState::Pending) => {
        pending_unavailable += 1;
        queued_candidates.push(candidate);
      }
      Err(e) => {
        skipped_errors += 1;
        debug!(
          "Skipping {} '{}' (user {}) during document fragment startup reconciliation: {}",
          candidate.kind.label(),
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
      }
    }
  }

  let queued_candidate_count = queued_candidates.len();
  let enqueued_count = {
    let mut state = state.lock().await;
    let mut enqueued_count = 0usize;
    for candidate in queued_candidates {
      if enqueue_candidate(&mut state, candidate) {
        enqueued_count += 1;
      }
    }
    enqueued_count
  };

  info!(
    "Startup document fragment reconciliation saw {} document item(s) (pdf={}, markdown={}, text={}), queued {} of {}; fragments: already_present={}; text artifacts checked for missing fragments: succeeded={}, failed={}, pending_waiting_for_extraction={}, pending_unavailable={}; waiting_for_builder={}; skipped_errors={}.",
    total_candidates,
    pdf_candidates,
    markdown_candidates,
    text_candidates,
    enqueued_count,
    queued_candidate_count,
    already_fragmented,
    already_succeeded,
    already_failed,
    pending_waiting_for_extraction,
    pending_unavailable,
    waiting_for_builder,
    skipped_errors
  );
}

fn enqueue_candidate_if_active(candidate: DocumentFragmentCandidate) {
  let Some(state) = DOCUMENT_FRAGMENT_PIPELINE_STATE.get() else {
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

fn enqueue_candidate(state: &mut DocumentFragmentPipelineState, candidate: DocumentFragmentCandidate) -> bool {
  if !state.queued_candidate_keys.insert(candidate.key()) {
    return false;
  }
  state.queue.push_back(candidate);
  record_document_fragment_queue_depth(state);
  true
}

fn pop_candidate(state: &mut DocumentFragmentPipelineState) -> Option<DocumentFragmentCandidate> {
  let candidate = state.queue.pop_front()?;
  state.queued_candidate_keys.remove(&candidate.key());
  record_document_fragment_queue_depth(state);
  Some(candidate)
}

fn remove_candidate(state: &mut DocumentFragmentPipelineState, item_id: &str) -> usize {
  let before = state.queue.len();
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
