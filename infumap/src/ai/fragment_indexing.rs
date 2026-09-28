use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use config::Config;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info, warn};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::{Mutex, mpsc};
use tokio::task;
use tokio::time::{Instant, timeout_at};

use crate::ai::artifact_io::{atomic_write, sha256};
use crate::ai::artifact_paths::{item_fragments_dir, item_fragments_manifest_path, item_fragments_path};
use crate::ai::fragment::is_lexical_search_source_kind;
use crate::ai::lexical_index::{
  INDEX_MAINTENANCE_FIRST_DELAY, INDEX_MAINTENANCE_INTERVAL, LexicalFragment, open_user_document_fragment_lexical_index,
};
use crate::ai::processing_retry::RetrySchedule;
use crate::ai::search_activity::{self as activity, Stage};
use crate::ai::search_index_paths::ensure_user_index_dir;
use crate::ai::title_indexing::enqueue_item_title_index_update;
use crate::ai::user_id_for_log;
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;
use crate::util::fs::path_exists;

/// Changes are committed together at most once per window, or earlier when the
/// batch is full. Fewer commits mean fewer index segments and less disk activity;
/// search catches up within the window. Anything pending at shutdown is
/// recovered by the startup check.
///
/// Deliberate trade-off: keeping search disk and CPU activity low matters more
/// than freshness. Search lagging edits, new content and deletions by up to 10
/// minutes is accepted; do not shorten this to make search more immediate.
const FRAGMENT_INDEXING_BATCH_WINDOW_SECS: u64 = 600;
const FRAGMENT_INDEXING_MAX_BATCH_ITEMS: usize = 500;

static FRAGMENT_INDEXING_QUEUE: OnceCell<mpsc::UnboundedSender<FragmentIndexingRequest>> = OnceCell::new();

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FragmentIndexingRequest {
  user_id: String,
  item_id: String,
}

pub fn init_fragment_indexing_loop(config: &Config, db: Arc<Mutex<Db>>) -> InfuResult<()> {
  if FRAGMENT_INDEXING_QUEUE.get().is_some() {
    return Ok(());
  }

  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let (sender, receiver) = mpsc::unbounded_channel();
  FRAGMENT_INDEXING_QUEUE
    .set(sender)
    .map_err(|_| "Fragment lexical indexing loop is already running in this process.".to_owned())?;

  info!("Starting item-level fragment lexical indexing loop.");
  let _worker = task::spawn(async move {
    run_fragment_indexing_loop(data_dir, db, receiver).await;
  });
  Ok(())
}

pub fn enqueue_fragment_lexical_index_update(user_id: &str, item_id: &str) {
  let Some(sender) = FRAGMENT_INDEXING_QUEUE.get() else {
    return;
  };
  let request = FragmentIndexingRequest { user_id: user_id.to_owned(), item_id: item_id.to_owned() };
  activity::queued(user_id, item_id, Stage::ContentIndex);
  if let Err(e) = sender.send(request) {
    warn!("Could not enqueue item-level fragment lexical index update: {}", e);
  }
}

pub async fn load_item_search_fragments(
  data_dir: &str,
  user_id: &str,
  item_id: &str,
) -> InfuResult<Vec<LexicalFragment>> {
  if !path_exists(&item_fragments_manifest_path(data_dir, user_id, item_id)?).await
    || !path_exists(&item_fragments_path(data_dir, user_id, item_id)?).await
  {
    return Ok(vec![]);
  }
  let fragments = crate::ai::fragment::read_item_fragments(data_dir, user_id, item_id).await?;
  if !is_lexical_search_source_kind(&fragments.source_kind) {
    return Ok(vec![]);
  }
  Ok(
    fragments
      .records
      .into_iter()
      .map(|record| LexicalFragment {
        item_id: item_id.to_owned(),
        ordinal: record.ordinal,
        source_kind: fragments.source_kind.clone(),
        text: record.text,
        page_start: record.page_start,
        page_end: record.page_end,
      })
      .collect(),
  )
}

/// Queue removal of a deleted item's title and content entries with the next
/// index batches. Search already ignores hits for items that no longer exist.
/// Deliberate trade-off: removal is batched rather than committed immediately,
/// to avoid a commit per deletion (see the batch window).
pub fn enqueue_item_search_index_removal(user_id: &str, item_id: &str) {
  activity::forget(user_id, item_id);
  enqueue_fragment_lexical_index_update(user_id, item_id);
  enqueue_item_title_index_update(user_id, item_id);
}

#[derive(Deserialize, Serialize)]
struct FragmentIndexReceipt {
  index_generation: Option<String>,
  fragments_sha256: String,
}

fn indexed_fingerprint(fragments: &[LexicalFragment]) -> InfuResult<String> {
  Ok(sha256(&serde_json::to_vec(
    &fragments
      .iter()
      .map(|fragment| {
        (
          &fragment.item_id,
          fragment.ordinal,
          &fragment.source_kind,
          &fragment.text,
          fragment.page_start,
          fragment.page_end,
        )
      })
      .collect::<Vec<_>>(),
  )?))
}

/// Called only after index commit and search metadata writes succeed. The
/// receipt describes the bytes loaded for that commit, never a later reread.
/// Keeping this beside the fragment manifest avoids rewriting that manifest
/// while another worker publishes a replacement.
pub async fn record_indexed_fragments(
  data_dir: &str,
  user_id: &str,
  updates: &[(String, Vec<LexicalFragment>)],
  index_dir: &Path,
) -> InfuResult<()> {
  let generation_path = index_dir.join("artifact_generation");
  let generation = if !path_exists(&index_dir.to_path_buf()).await {
    // The index writer does not create an index for an all-empty update. Record
    // that no-op removal without creating a directory that looks like an index.
    if updates.iter().any(|(_, fragments)| !fragments.is_empty()) {
      return Err("Cannot acknowledge nonempty fragments without an index.".into());
    }
    None
  } else {
    if !path_exists(&index_dir.join("meta.json")).await {
      return Err("Cannot acknowledge an incomplete index.".into());
    }
    Some(match fs::read_to_string(&generation_path).await {
      Ok(value) => value,
      Err(error) if error.kind() == ErrorKind::NotFound => {
        let value = infusdk::util::uid::new_uid();
        atomic_write(&generation_path, value.as_bytes()).await?;
        value
      }
      Err(error) => return Err(error.into()),
    })
  };
  for (item_id, fragments) in updates {
    // No new directory for a deleted item or missing fragment output.
    let directory = item_fragments_dir(data_dir, user_id, item_id)?;
    if !path_exists(&item_fragments_manifest_path(data_dir, user_id, item_id)?).await {
      continue;
    }
    let receipt =
      FragmentIndexReceipt { index_generation: generation.clone(), fragments_sha256: indexed_fingerprint(fragments)? };
    atomic_write(&directory.join("index_receipt.json"), &serde_json::to_vec_pretty(&receipt)?).await?;
  }
  Ok(())
}

/// Used by startup reconciliation. Missing receipts/indexes are outstanding work,
/// including an empty fragment file whose obsolete index entries need removal.
pub async fn item_fragment_index_is_current(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<bool> {
  let index_dir = crate::ai::lexical_index::document_fragment_lexical_index_dir(data_dir, user_id)?;
  if !path_exists(&item_fragments_path(data_dir, user_id, item_id)?).await
    || !path_exists(&item_fragments_manifest_path(data_dir, user_id, item_id)?).await
  {
    return Ok(false);
  }
  let receipt_path = item_fragments_dir(data_dir, user_id, item_id)?.join("index_receipt.json");
  let receipt: FragmentIndexReceipt = match fs::read(&receipt_path).await {
    Ok(bytes) => match serde_json::from_slice(&bytes) {
      Ok(value) => value,
      Err(_) => return Ok(false),
    },
    Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
    Err(error) => return Err(error.into()),
  };
  let generation = if !path_exists(&index_dir).await {
    None
  } else {
    if !path_exists(&index_dir.join("meta.json")).await {
      return Ok(false);
    }
    Some(match fs::read_to_string(index_dir.join("artifact_generation")).await {
      Ok(value) => value,
      Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
      Err(error) => return Err(error.into()),
    })
  };
  let fragments = load_item_search_fragments(data_dir, user_id, item_id).await?;
  if generation.is_none() && !fragments.is_empty() {
    return Ok(false);
  }
  Ok(receipt.index_generation == generation && receipt.fragments_sha256 == indexed_fingerprint(&fragments)?)
}

async fn run_fragment_indexing_loop(
  data_dir: String,
  db: Arc<Mutex<Db>>,
  mut receiver: mpsc::UnboundedReceiver<FragmentIndexingRequest>,
) {
  let mut queued = HashSet::new();
  let mut retries = RetrySchedule::default();
  // Maintenance runs here, between batches, so it never overlaps a commit.
  let mut next_maintenance = Instant::now() + INDEX_MAINTENANCE_FIRST_DELAY;
  loop {
    if Instant::now() >= next_maintenance {
      maintain_content_indexes(&data_dir, &db).await;
      next_maintenance = Instant::now() + INDEX_MAINTENANCE_INTERVAL;
    }
    let request = if queued.is_empty() {
      match timeout_at(next_maintenance, receiver.recv()).await {
        Ok(request) => request,
        Err(_) => continue,
      }
    } else {
      tokio::time::timeout(Duration::from_secs(1), receiver.recv()).await.ok().flatten()
    };
    if request.is_none() && receiver.is_closed() && queued.is_empty() {
      break;
    }
    if let Some(request) = request {
      queued.insert(request);
    }
    drain_pending(&mut receiver, &mut queued);
    // Retries still waiting for their delay do not open a batch window.
    if !queued.iter().any(|request| retries.ready(request)) {
      continue;
    }

    let deadline = Instant::now() + Duration::from_secs(FRAGMENT_INDEXING_BATCH_WINDOW_SECS);
    while queued.len() < FRAGMENT_INDEXING_MAX_BATCH_ITEMS {
      match timeout_at(deadline, receiver.recv()).await {
        Ok(Some(request)) => {
          queued.insert(request);
          drain_pending(&mut receiver, &mut queued);
        }
        Ok(None) | Err(_) => break,
      }
    }

    let mut requests = queued.iter().filter(|request| retries.ready(*request)).cloned().collect::<Vec<_>>();
    for request in &requests {
      queued.remove(request);
      activity::running(&request.user_id, &request.item_id, Stage::ContentIndex);
    }
    requests.sort_by(|a, b| a.user_id.cmp(&b.user_id).then(a.item_id.cmp(&b.item_id)));
    debug!("Applying {} item-level fragment lexical index update(s).", requests.len());
    let mut item_ids_by_user = BTreeMap::<String, Vec<String>>::new();
    for request in requests {
      item_ids_by_user.entry(request.user_id).or_default().push(request.item_id);
    }
    for (user_id, item_ids) in item_ids_by_user {
      let mut updates = Vec::<(String, Vec<LexicalFragment>)>::new();
      for item_id in item_ids {
        let live = {
          let db = db.lock().await;
          db.item.get(&item_id).is_ok_and(|item| {
            item.owner_id == user_id
              && crate::ai::search_processing::SearchContentKind::from_mime_type(item.mime_type.as_deref()).is_some()
          })
        };
        let loaded = if live { load_item_search_fragments(&data_dir, &user_id, &item_id).await } else { Ok(vec![]) };
        match loaded {
          Ok(fragments) => updates.push((item_id, fragments)),
          Err(e) => {
            let request = FragmentIndexingRequest { user_id: user_id.clone(), item_id: item_id.clone() };
            let delay = retries.failed(request.clone());
            activity::retry(&request.user_id, &request.item_id, Stage::ContentIndex, &e.to_string(), delay);
            queued.insert(request);
            error!(
              "Could not load fragments for '{}' (user {}): {}. Retrying in {} seconds.",
              item_id,
              user_id_for_log(&user_id),
              e,
              delay.as_secs()
            );
          }
        }
      }
      if updates.is_empty() {
        continue;
      }
      let result = commit_user_updates(&data_dir, &user_id, &updates).await;
      for (item_id, _) in &updates {
        let request = FragmentIndexingRequest { user_id: user_id.clone(), item_id: item_id.clone() };
        if let Err(e) = &result {
          let delay = retries.failed(request.clone());
          activity::retry(&request.user_id, &request.item_id, Stage::ContentIndex, &e.to_string(), delay);
          queued.insert(request);
          debug!("Content index retry scheduled in {} seconds.", delay.as_secs());
        } else {
          retries.clear(&request);
          activity::done(&request.user_id, &request.item_id, Stage::ContentIndex);
        }
      }
      if let Err(e) = result {
        error!(
          "Content index update failed for user {}: {}. Updates remain queued for retry.",
          user_id_for_log(&user_id),
          e
        );
      }
    }
  }
}

pub(crate) async fn commit_user_updates(
  data_dir: &str,
  user_id: &str,
  updates: &[(String, Vec<LexicalFragment>)],
) -> InfuResult<()> {
  ensure_user_index_dir(data_dir, user_id).await?;
  let update_refs =
    updates.iter().map(|(item_id, fragments)| (item_id.as_str(), fragments.as_slice())).collect::<Vec<_>>();
  let count =
    open_user_document_fragment_lexical_index(data_dir, user_id)?.replace_items_fragments(&update_refs).await?;
  record_indexed_fragments(
    data_dir,
    user_id,
    updates,
    &crate::ai::lexical_index::document_fragment_lexical_index_dir(data_dir, user_id)?,
  )
  .await?;
  debug!(
    "Updated {} fragment(s) for {} item(s) in the lexical index for user {}.",
    count,
    updates.len(),
    user_id_for_log(user_id)
  );
  Ok(())
}

fn drain_pending(
  receiver: &mut mpsc::UnboundedReceiver<FragmentIndexingRequest>,
  queued: &mut HashSet<FragmentIndexingRequest>,
) {
  while let Ok(request) = receiver.try_recv() {
    queued.insert(request);
  }
}

async fn maintain_content_indexes(data_dir: &str, db: &Arc<Mutex<Db>>) {
  let user_ids = db.lock().await.user.all_user_ids();
  for user_id in user_ids {
    let result = match open_user_document_fragment_lexical_index(data_dir, &user_id) {
      Ok(index) => index.maintain().await,
      Err(e) => Err(e),
    };
    match result {
      Ok(0) => {}
      Ok(merged) => info!("Merged {} content index segments for user {}.", merged, user_id_for_log(&user_id)),
      Err(e) => warn!(
        "content index maintenance failed for user {}: {}. Will try again tomorrow.",
        user_id_for_log(&user_id),
        e
      ),
    }
  }
}
