use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use infusdk::util::infu::InfuResult;
use log::{debug, error, info, warn};
use once_cell::sync::OnceCell;
use tokio::sync::{Mutex, mpsc};
use tokio::task;
use tokio::time::{Instant, timeout_at};

use crate::ai::fragment::sources::{ItemTitleFragment, item_title_fragment_for_item};
use crate::ai::lexical_index::{
  INDEX_MAINTENANCE_FIRST_DELAY, INDEX_MAINTENANCE_INTERVAL, LexicalFragment, open_user_item_title_lexical_index,
};
use crate::ai::processing_retry::RetrySchedule;
use crate::ai::search_activity::{self as activity, Stage};
use crate::ai::search_index_paths::ensure_user_index_dir;
use crate::ai::user_id_for_log;
use crate::storage::db::Db;

/// Changes are committed together at most once per window, or earlier when the
/// batch is full. Fewer commits mean fewer index segments and less disk activity;
/// search catches up within the window. Anything pending at shutdown is
/// recovered by the startup check.
///
/// Deliberate trade-off: keeping search disk and CPU activity low matters more
/// than freshness. Search lagging edits, new content and deletions by up to 10
/// minutes is accepted; do not shorten this to make search more immediate.
const ITEM_TITLE_INDEXING_BATCH_WINDOW_SECS: u64 = 600;
const ITEM_TITLE_INDEXING_MAX_BATCH_ITEMS: usize = 1000;

static ITEM_TITLE_INDEXING_QUEUE: OnceCell<mpsc::UnboundedSender<ItemTitleIndexingRequest>> = OnceCell::new();

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ItemTitleIndexingRequest {
  user_id: String,
  item_id: String,
}

pub fn init_item_title_indexing_loop(data_dir: String, db: Arc<Mutex<Db>>) -> InfuResult<()> {
  if ITEM_TITLE_INDEXING_QUEUE.get().is_some() {
    return Ok(());
  }

  let (sender, receiver) = mpsc::unbounded_channel();
  ITEM_TITLE_INDEXING_QUEUE
    .set(sender)
    .map_err(|_| "Item title indexing loop is already running in this process.".to_owned())?;

  info!("Starting item-level title lexical indexing loop.");
  let _worker = task::spawn(async move {
    run_item_title_indexing_loop(data_dir, db, receiver).await;
  });
  Ok(())
}

pub fn enqueue_item_title_index_update(user_id: &str, item_id: &str) {
  let Some(sender) = ITEM_TITLE_INDEXING_QUEUE.get() else {
    return;
  };
  let request = ItemTitleIndexingRequest { user_id: user_id.to_owned(), item_id: item_id.to_owned() };
  activity::queued(user_id, item_id, Stage::Title);
  if let Err(e) = sender.send(request) {
    warn!("Could not enqueue item-level title lexical index update: {}", e);
  }
}

async fn run_item_title_indexing_loop(
  data_dir: String,
  db: Arc<Mutex<Db>>,
  mut receiver: mpsc::UnboundedReceiver<ItemTitleIndexingRequest>,
) {
  let mut queued = HashSet::new();
  let mut retries = RetrySchedule::default();
  // Maintenance runs here, between batches, so it never overlaps a commit.
  let mut next_maintenance = Instant::now() + INDEX_MAINTENANCE_FIRST_DELAY;
  loop {
    if Instant::now() >= next_maintenance {
      maintain_title_indexes(&data_dir, &db).await;
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

    let deadline = Instant::now() + Duration::from_secs(ITEM_TITLE_INDEXING_BATCH_WINDOW_SECS);
    while queued.len() < ITEM_TITLE_INDEXING_MAX_BATCH_ITEMS {
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
      activity::running(&request.user_id, &request.item_id, Stage::Title);
    }
    requests.sort_by(|a, b| a.user_id.cmp(&b.user_id).then(a.item_id.cmp(&b.item_id)));
    debug!("Applying {} item-level title lexical index update request(s).", requests.len());
    let mut requests_by_user = std::collections::BTreeMap::<String, Vec<String>>::new();
    for request in requests {
      requests_by_user.entry(request.user_id).or_default().push(request.item_id);
    }
    for (user_id, item_ids) in requests_by_user {
      let commit_started = Instant::now();
      let update_count = item_ids.len();
      let result = update_title_index_for_items(&data_dir, db.clone(), &user_id, &item_ids).await;
      for item_id in item_ids {
        let request = ItemTitleIndexingRequest { user_id: user_id.clone(), item_id };
        if let Err(e) = &result {
          let delay = retries.failed(request.clone());
          activity::retry(&request.user_id, &request.item_id, Stage::Title, &e.to_string(), delay);
          queued.insert(request);
          debug!("Title index retry scheduled in {} seconds.", delay.as_secs());
        } else {
          retries.clear(&request);
          activity::done(&request.user_id, &request.item_id, Stage::Title);
        }
      }
      match result {
        Ok(0) => debug!(
          "Title index: {} requested update(s) for user {} changed nothing.",
          update_count,
          user_id_for_log(&user_id)
        ),
        Ok(changed) => info!(
          "Title index: committed {} changed title(s) for user {} in {:.1}s.",
          changed,
          user_id_for_log(&user_id),
          commit_started.elapsed().as_secs_f64()
        ),
        Err(e) => error!(
          "Title index update failed for user {}: {}. Updates remain queued for retry.",
          user_id_for_log(&user_id),
          e
        ),
      }
    }
  }
}

async fn update_title_index_for_items(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  user_id: &str,
  requested_item_ids: &[String],
) -> InfuResult<usize> {
  let updates = {
    let db = db.lock().await;
    let mut item_ids = requested_item_ids.iter().cloned().collect::<HashSet<_>>();
    for requested_item_id in requested_item_ids {
      if let Ok(item) = db.item.get(requested_item_id) {
        item_ids.extend(db.item.get_children_ids(&item.id)?);
        item_ids.extend(db.item.get_attachment_ids(&item.id)?);
        if let Some(parent_id) = item.parent_id.as_ref() {
          item_ids.insert(parent_id.clone());
        }
      }
    }

    let mut item_ids = item_ids.into_iter().collect::<Vec<_>>();
    item_ids.sort();
    item_ids
      .into_iter()
      .map(|item_id| {
        let fragment = db
          .item
          .get(&item_id)
          .ok()
          .map(|item| item_title_fragment_for_item(&db, item))
          .transpose()?
          .flatten()
          .map(lexical_fragment_from_item_title_fragment);
        Ok((item_id, fragment))
      })
      .collect::<InfuResult<Vec<_>>>()?
  };

  // Related items (children, attachments, parent) are included in case their
  // title context changed; most have not. Rewriting unchanged titles would only
  // add deleted documents and segments, so compare with what is stored first.
  let index = open_user_item_title_lexical_index(data_dir, user_id)?;
  let item_ids = updates.iter().map(|(item_id, _)| item_id.clone()).collect::<Vec<_>>();
  let mut stored = index.stored_titles_for_items(&item_ids).await?;
  let changed = updates
    .into_iter()
    .filter(|(item_id, fragment)| {
      stored.remove(item_id).unwrap_or_default().as_slice()
        != fragment.as_ref().map(std::slice::from_ref).unwrap_or_default()
    })
    .collect::<Vec<_>>();
  if changed.is_empty() {
    return Ok(0);
  }
  ensure_user_index_dir(data_dir, user_id).await?;
  let update_refs = changed
    .iter()
    .map(|(item_id, fragment)| (item_id.as_str(), fragment.as_ref().map(std::slice::from_ref).unwrap_or_default()))
    .collect::<Vec<_>>();
  index.replace_items_titles(&update_refs).await?;
  Ok(changed.len())
}

pub fn lexical_fragment_from_item_title_fragment(fragment: ItemTitleFragment) -> LexicalFragment {
  LexicalFragment {
    item_id: fragment.item_id,
    ordinal: fragment.ordinal,
    source_kind: fragment.source_kind.to_owned(),
    text: fragment.text,
    page_start: None,
    page_end: None,
  }
}

fn drain_pending(
  receiver: &mut mpsc::UnboundedReceiver<ItemTitleIndexingRequest>,
  queued: &mut HashSet<ItemTitleIndexingRequest>,
) {
  while let Ok(request) = receiver.try_recv() {
    queued.insert(request);
  }
}

async fn maintain_title_indexes(data_dir: &str, db: &Arc<Mutex<Db>>) {
  let user_ids = db.lock().await.user.all_user_ids();
  for user_id in user_ids {
    let log_label = format!("Title index maintenance for user {}", user_id_for_log(&user_id));
    let started = Instant::now();
    let result = match open_user_item_title_lexical_index(data_dir, &user_id) {
      Ok(index) => index.maintain(&log_label).await,
      Err(e) => Err(e),
    };
    match result {
      Ok(0) => {}
      Ok(merged) => info!("{}: merged {} segments in {:.1}s.", log_label, merged, started.elapsed().as_secs_f64()),
      Err(e) => warn!("{} failed: {}. Will try again tomorrow.", log_label, e),
    }
  }
}
