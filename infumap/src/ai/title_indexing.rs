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
use crate::ai::lexical_index::{LexicalFragment, open_user_item_title_lexical_index};
use crate::ai::search_index_paths::ensure_user_index_dir;
use crate::ai::user_id_for_log;
use crate::storage::db::Db;

const ITEM_TITLE_INDEXING_DEBOUNCE_SECS: u64 = 2;
const ITEM_TITLE_INDEXING_MAX_DEBOUNCE_SECS: u64 = 10;

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

  info!("Starting item-level title lexical indexing loop; no startup index rebuild will run.");
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
  while let Some(request) = receiver.recv().await {
    queued.insert(request);
    drain_pending(&mut receiver, &mut queued);

    let max_deadline = Instant::now() + Duration::from_secs(ITEM_TITLE_INDEXING_MAX_DEBOUNCE_SECS);
    loop {
      let deadline = (Instant::now() + Duration::from_secs(ITEM_TITLE_INDEXING_DEBOUNCE_SECS)).min(max_deadline);
      match timeout_at(deadline, receiver.recv()).await {
        Ok(Some(request)) => {
          queued.insert(request);
          drain_pending(&mut receiver, &mut queued);
          if Instant::now() >= max_deadline {
            break;
          }
        }
        Ok(None) | Err(_) => break,
      }
    }

    let mut requests = queued.drain().collect::<Vec<_>>();
    requests.sort_by(|a, b| a.user_id.cmp(&b.user_id).then(a.item_id.cmp(&b.item_id)));
    debug!("Applying {} item-level title lexical index update request(s).", requests.len());
    let mut requests_by_user = std::collections::BTreeMap::<String, Vec<String>>::new();
    for request in requests {
      requests_by_user.entry(request.user_id).or_default().push(request.item_id);
    }
    for (user_id, item_ids) in requests_by_user {
      if let Err(e) = update_title_index_for_items(&data_dir, db.clone(), &user_id, &item_ids).await {
        error!("Item-level title lexical index batch update failed for user {}: {}", user_id_for_log(&user_id), e);
      }
    }
  }
}

async fn update_title_index_for_items(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  user_id: &str,
  requested_item_ids: &[String],
) -> InfuResult<()> {
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

  ensure_user_index_dir(data_dir, user_id).await?;
  let index = open_user_item_title_lexical_index(data_dir, user_id)?;
  let update_refs = updates
    .iter()
    .map(|(item_id, fragment)| (item_id.as_str(), fragment.as_ref().map(std::slice::from_ref).unwrap_or_default()))
    .collect::<Vec<_>>();
  index.replace_items_titles(&update_refs).await?;
  Ok(())
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
