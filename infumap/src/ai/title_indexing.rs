#![allow(dead_code)]

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use infusdk::util::infu::InfuResult;
use log::{debug, error, info, warn};
use once_cell::sync::OnceCell;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, mpsc};
use tokio::task;
use tokio::time::{Instant as TokioInstant, timeout_at};

use crate::ai::fragment::sources::{ItemTitleFragment, item_title_fragment_for_item};
use crate::ai::lexical_index::{
  FragmentLexicalIndexRebuildMetadata, LexicalFragment, item_title_lexical_index_temp_dir,
  open_user_item_title_lexical_index, remove_item_title_lexical_index_dirs,
};
use crate::ai::user_id_for_log;
use crate::ai::vector_db::ensure_user_index_dir;
use crate::storage::db::Db;

const ITEM_TITLE_INDEXING_DEBOUNCE_SECS: u64 = 10;
const ITEM_TITLE_INDEXING_MAX_DEBOUNCE_SECS: u64 = 60;

static ITEM_TITLE_INDEXING_QUEUE: OnceCell<mpsc::UnboundedSender<ItemTitleIndexingRequest>> = OnceCell::new();

enum ItemTitleIndexingRequest {
  Immediate(String),
  Debounced(String),
}

impl ItemTitleIndexingRequest {
  fn user_id(&self) -> &str {
    match self {
      ItemTitleIndexingRequest::Immediate(user_id) => user_id,
      ItemTitleIndexingRequest::Debounced(user_id) => user_id,
    }
  }
}

pub fn init_item_title_indexing_loop(data_dir: String, db: Arc<Mutex<Db>>) -> InfuResult<()> {
  if ITEM_TITLE_INDEXING_QUEUE.get().is_some() {
    enqueue_all_loaded_users(db);
    return Ok(());
  }

  let (sender, receiver) = mpsc::unbounded_channel();
  ITEM_TITLE_INDEXING_QUEUE
    .set(sender)
    .map_err(|_| "Item title indexing loop is already running in this process.".to_owned())?;

  info!("Starting item title lexical indexing loop with startup reconciliation and live enqueue updates.");
  let _worker = task::spawn(async move {
    run_item_title_indexing_loop(data_dir, db, receiver).await;
  });

  Ok(())
}

pub fn enqueue_item_title_index_reconcile_for_user(user_id: &str) {
  enqueue_item_title_indexing_request(ItemTitleIndexingRequest::Debounced(user_id.to_owned()));
}

fn enqueue_item_title_indexing_request(request: ItemTitleIndexingRequest) {
  let Some(sender) = ITEM_TITLE_INDEXING_QUEUE.get() else {
    return;
  };
  let user_id = request.user_id().to_owned();
  if let Err(e) = sender.send(request) {
    warn!("Could not enqueue item title lexical index reconciliation for user '{}': {}", user_id_for_log(&user_id), e);
  }
}

fn enqueue_all_loaded_users(db: Arc<Mutex<Db>>) {
  let _enqueue_task = task::spawn(async move {
    let mut user_ids = {
      let db = db.lock().await;
      db.user.all_user_ids().iter().map(|user_id| user_id.to_owned()).collect::<Vec<_>>()
    };
    user_ids.sort();
    for user_id in user_ids {
      enqueue_item_title_indexing_request(ItemTitleIndexingRequest::Immediate(user_id));
    }
  });
}

async fn run_item_title_indexing_loop(
  data_dir: String,
  db: Arc<Mutex<Db>>,
  mut receiver: mpsc::UnboundedReceiver<ItemTitleIndexingRequest>,
) {
  enqueue_all_loaded_users(db.clone());

  let mut queued_user_ids = HashSet::<String>::new();
  while let Some(request) = receiver.recv().await {
    let mut has_immediate_request = queue_item_title_indexing_request(&mut queued_user_ids, request);
    has_immediate_request |= drain_pending_item_title_indexing_requests(&mut receiver, &mut queued_user_ids);

    if !has_immediate_request {
      debug!("Debouncing item title lexical index reconciliation for {} second(s).", ITEM_TITLE_INDEXING_DEBOUNCE_SECS);
      let max_debounce_deadline = TokioInstant::now() + Duration::from_secs(ITEM_TITLE_INDEXING_MAX_DEBOUNCE_SECS);
      loop {
        let quiet_deadline = TokioInstant::now() + Duration::from_secs(ITEM_TITLE_INDEXING_DEBOUNCE_SECS);
        let next_deadline = quiet_deadline.min(max_debounce_deadline);
        match timeout_at(next_deadline, receiver.recv()).await {
          Ok(Some(request)) => {
            has_immediate_request = queue_item_title_indexing_request(&mut queued_user_ids, request);
            has_immediate_request |= drain_pending_item_title_indexing_requests(&mut receiver, &mut queued_user_ids);
            if has_immediate_request {
              break;
            }
            if TokioInstant::now() >= max_debounce_deadline {
              debug!(
                "Item title lexical index debounce reached {} second max wait with pending update(s).",
                ITEM_TITLE_INDEXING_MAX_DEBOUNCE_SECS
              );
              break;
            }
          }
          Ok(None) => break,
          Err(_) => break,
        }
      }
    }

    let mut user_ids = queued_user_ids.drain().collect::<Vec<_>>();
    user_ids.sort();
    for user_id in user_ids {
      if let Err(e) = reconcile_user_item_title_lexical_index(&data_dir, db.clone(), &user_id).await {
        error!("Item title lexical index reconciliation failed for user '{}': {}", user_id_for_log(&user_id), e);
      }
    }
  }
}

fn queue_item_title_indexing_request(queued_user_ids: &mut HashSet<String>, request: ItemTitleIndexingRequest) -> bool {
  match request {
    ItemTitleIndexingRequest::Immediate(user_id) => {
      queued_user_ids.insert(user_id);
      true
    }
    ItemTitleIndexingRequest::Debounced(user_id) => {
      queued_user_ids.insert(user_id);
      false
    }
  }
}

fn drain_pending_item_title_indexing_requests(
  receiver: &mut mpsc::UnboundedReceiver<ItemTitleIndexingRequest>,
  queued_user_ids: &mut HashSet<String>,
) -> bool {
  let mut has_immediate_request = false;
  while let Ok(request) = receiver.try_recv() {
    has_immediate_request |= queue_item_title_indexing_request(queued_user_ids, request);
  }
  has_immediate_request
}

async fn reconcile_user_item_title_lexical_index(data_dir: &str, db: Arc<Mutex<Db>>, user_id: &str) -> InfuResult<()> {
  let reconcile_started = Instant::now();
  let fragments = {
    let db = db.lock().await;
    collect_user_item_title_lexical_fragments(&db, user_id)?
  };

  if fragments.is_empty() {
    let removed = remove_item_title_lexical_index_dirs(data_dir, user_id).await?;
    if removed > 0 {
      info!(
        "User {} has no item title fragments; removed {} stale title lexical index dir(s).",
        user_id_for_log(user_id),
        removed
      );
    }
    debug!(
      "User {} item title lexical index reconciliation found no title fragments in {:.3}s.",
      user_id_for_log(user_id),
      reconcile_started.elapsed().as_secs_f64()
    );
    return Ok(());
  }

  ensure_user_index_dir(data_dir, user_id).await?;

  let source_digest = lexical_fragment_corpus_digest(&fragments);
  let final_index = open_user_item_title_lexical_index(data_dir, user_id)?;
  if let Some(status) = final_index.rebuild_status().await?
    && status.complete
    && status.source_digest == source_digest
    && status.expected_fragment_count == fragments.len()
    && status.indexed_fragment_count == fragments.len()
  {
    debug!(
      "User {} item title lexical index is already current ({} fragment(s), checked in {:.3}s).",
      user_id_for_log(user_id),
      fragments.len(),
      reconcile_started.elapsed().as_secs_f64()
    );
    return Ok(());
  }

  info!(
    "User {} starting item title lexical index rebuild: {} fragment(s).",
    user_id_for_log(user_id),
    fragments.len()
  );
  let rebuild_started = Instant::now();
  let temp_dir = item_title_lexical_index_temp_dir(data_dir, user_id)?;
  let metadata = FragmentLexicalIndexRebuildMetadata {
    source_digest: source_digest.clone(),
    expected_fragment_count: fragments.len(),
  };
  let status = final_index.rebuild_from_fragments(&temp_dir, &metadata, &fragments).await?;
  if !status.complete
    || status.source_digest != source_digest
    || status.expected_fragment_count != fragments.len()
    || status.indexed_fragment_count != fragments.len()
  {
    return Err(format!("Final item title lexical index validation failed for user {}.", user_id).into());
  }

  info!(
    "User {} finished item title lexical index rebuild: {} fragment(s), rebuild {:.3}s, total {:.3}s.",
    user_id_for_log(user_id),
    status.indexed_fragment_count,
    rebuild_started.elapsed().as_secs_f64(),
    reconcile_started.elapsed().as_secs_f64()
  );
  Ok(())
}

fn collect_user_item_title_lexical_fragments(db: &Db, user_id: &str) -> InfuResult<Vec<LexicalFragment>> {
  let mut item_ids = db
    .item
    .all_loaded_items()
    .into_iter()
    .filter(|item_key| item_key.user_id.as_str() == user_id)
    .map(|item_key| item_key.item_id)
    .collect::<Vec<_>>();
  item_ids.sort();

  let mut fragments = Vec::new();
  for item_id in item_ids {
    let item = db.item.get(&item_id).map_err(|e| e.to_string())?;
    if let Some(fragment) = item_title_fragment_for_item(db, item)? {
      fragments.push(lexical_fragment_from_item_title_fragment(fragment));
    }
  }
  fragments.sort_by(|a, b| a.item_id.cmp(&b.item_id).then(a.ordinal.cmp(&b.ordinal)));
  Ok(fragments)
}

fn lexical_fragment_from_item_title_fragment(fragment: ItemTitleFragment) -> LexicalFragment {
  LexicalFragment {
    item_id: fragment.item_id,
    ordinal: fragment.ordinal,
    source_kind: fragment.source_kind.to_owned(),
    text: fragment.text,
    page_start: None,
    page_end: None,
  }
}

fn lexical_fragment_corpus_digest(fragments: &[LexicalFragment]) -> String {
  let mut hasher = Sha256::new();
  for fragment in fragments {
    hasher.update(fragment.item_id.as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.ordinal.to_string().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.source_kind.as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.page_start.map(|v| v.to_string()).unwrap_or_default().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.page_end.map(|v| v.to_string()).unwrap_or_default().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.text.as_bytes());
    hasher.update([0xff_u8]);
  }
  format!("{:x}", hasher.finalize())
}
