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

use crate::ai::fragment::clear_item_fragments;
use crate::ai::fragment::sources::{build_pdf_fragment_artifact, embedding_context_title_for_item};
use crate::ai::fragment_indexing::enqueue_fragment_index_rebuild_for_user;
use crate::ai::text_extraction::{PdfTextArtifactState, pdf_text_artifact_state, text_extraction_url_from_config};
use crate::ai::user_id_for_log;
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;

const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const FRAGMENT_NOT_READY_WAIT_MILLIS: u64 = 1000;
const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";

static DOCUMENT_FRAGMENT_PIPELINE_STATE: OnceCell<Arc<Mutex<DocumentFragmentPipelineState>>> = OnceCell::new();

#[derive(Clone)]
struct DocumentFragmentPipelineConfig {
  data_dir: String,
  text_extraction_enabled: bool,
}

#[derive(Clone)]
struct DocumentFragmentCandidate {
  user_id: String,
  item_id: String,
}

impl DocumentFragmentCandidate {
  fn from_item(item: &Item) -> Option<DocumentFragmentCandidate> {
    is_pdf_item(item).then(|| DocumentFragmentCandidate { user_id: item.owner_id.clone(), item_id: item.id.clone() })
  }
}

#[derive(Default)]
struct DocumentFragmentPipelineState {
  queue: VecDeque<DocumentFragmentCandidate>,
  queued_item_ids: HashSet<String>,
}

enum DocumentFragmentReadiness {
  Ready,
  Waiting,
  Unavailable,
}

pub fn init_document_fragment_pipeline_loop(config: &Config, db: Arc<Mutex<Db>>) -> InfuResult<()> {
  let pipeline_config = document_fragment_pipeline_config(config)?;
  if DOCUMENT_FRAGMENT_PIPELINE_STATE.get().is_some() {
    return Ok(());
  }

  let state = Arc::new(Mutex::new(DocumentFragmentPipelineState::default()));
  DOCUMENT_FRAGMENT_PIPELINE_STATE
    .set(state.clone())
    .map_err(|_| "Document fragment background pipeline loop is already running in this process.".to_owned())?;

  info!(
    "Starting document fragment background loop (pdf_text_extraction={}).",
    on_off(pipeline_config.text_extraction_enabled)
  );

  let _worker = task::spawn(async move {
    run_document_fragment_loop(pipeline_config, db, state).await;
  });
  Ok(())
}

pub fn enqueue_pdf_fragment_item_if_active(item: &Item) {
  let Some(candidate) = DocumentFragmentCandidate::from_item(item) else {
    return;
  };
  enqueue_candidate_if_active(candidate);
}

pub fn enqueue_pdf_fragment_ids_if_active(user_id: &str, item_id: &str) {
  enqueue_candidate_if_active(DocumentFragmentCandidate { user_id: user_id.to_owned(), item_id: item_id.to_owned() });
}

pub fn dequeue_pdf_fragment_item_if_active(item_id: &str) {
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

fn document_fragment_pipeline_config(config: &Config) -> InfuResult<DocumentFragmentPipelineConfig> {
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let text_extraction_enabled = text_extraction_url_from_config(config)?.is_some();
  Ok(DocumentFragmentPipelineConfig { data_dir, text_extraction_enabled })
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
      Ok(Some(user_id)) => {
        enqueue_fragment_index_rebuild_for_user(&user_id);
      }
      Ok(None) => {}
      Err(e) => {
        error!(
          "Document fragment pipeline failed for PDF '{}' (user '{}'): {}",
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
) -> InfuResult<Option<String>> {
  let item_snapshot = {
    let db = db.lock().await;
    match db.item.get(&candidate.item_id) {
      Ok(item) if item.owner_id == candidate.user_id && is_pdf_item(item) => item.clone(),
      _ => return Ok(None),
    }
  };

  match document_fragment_readiness(config, &item_snapshot).await? {
    DocumentFragmentReadiness::Ready => {}
    DocumentFragmentReadiness::Waiting => {
      sleep(Duration::from_millis(FRAGMENT_NOT_READY_WAIT_MILLIS)).await;
      enqueue_pdf_fragment_ids_if_active(&item_snapshot.owner_id, &item_snapshot.id);
      return Ok(None);
    }
    DocumentFragmentReadiness::Unavailable => {
      let outcome = clear_item_fragments(&config.data_dir, &item_snapshot).await?;
      if outcome.cleared_existing_fragments {
        debug!(
          "Document fragment pipeline cleared stale fragments for PDF '{}' (user {}).",
          item_snapshot.id,
          user_id_for_log(&item_snapshot.owner_id)
        );
      }
      return Ok(outcome.cleared_existing_fragments.then_some(item_snapshot.owner_id));
    }
  }

  let context_title = {
    let db = db.lock().await;
    embedding_context_title_for_item(&db, &item_snapshot)
  };
  let fragment_result = build_pdf_fragment_artifact(&config.data_dir, &item_snapshot, context_title).await?;
  let had_fragment_source = fragment_result.had_fragment_source;
  let outcome = fragment_result.outcome;

  if outcome.wrote_fragments {
    debug!(
      "Document fragment pipeline wrote {} fragment(s) for PDF '{}' (user {}).",
      outcome.fragment_count,
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  } else if outcome.cleared_existing_fragments {
    debug!(
      "Document fragment pipeline cleared stale fragments for PDF '{}' (user {}).",
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  } else if had_fragment_source {
    debug!(
      "Document fragment pipeline found PDF fragments already current for PDF '{}' (user {}).",
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  }

  Ok((outcome.wrote_fragments || outcome.cleared_existing_fragments).then_some(item_snapshot.owner_id))
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
  if !state.queued_item_ids.insert(candidate.item_id.clone()) {
    return false;
  }
  state.queue.push_back(candidate);
  true
}

fn pop_candidate(state: &mut DocumentFragmentPipelineState) -> Option<DocumentFragmentCandidate> {
  let candidate = state.queue.pop_front()?;
  state.queued_item_ids.remove(&candidate.item_id);
  Some(candidate)
}

fn remove_candidate(state: &mut DocumentFragmentPipelineState, item_id: &str) -> usize {
  let before = state.queue.len();
  state.queue.retain(|candidate| candidate.item_id != item_id);
  state.queued_item_ids.remove(item_id);
  before.saturating_sub(state.queue.len())
}

fn is_pdf_item(item: &Item) -> bool {
  item.mime_type.as_deref() == Some(PDF_SOURCE_MIME_TYPE)
}

fn on_off(value: bool) -> &'static str {
  if value { "on" } else { "off" }
}
