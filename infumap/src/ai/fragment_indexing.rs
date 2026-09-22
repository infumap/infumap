use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use config::Config;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info, warn};
use once_cell::sync::OnceCell;
use tokio::sync::{Mutex, mpsc};
use tokio::task;
use tokio::time::{Instant, timeout_at};

use crate::ai::indexing::load_item_lexical_fragments;
use crate::ai::lexical_index::{LexicalFragment, open_user_document_fragment_lexical_index};
use crate::ai::user_id_for_log;
use crate::ai::vector_db::ensure_user_index_dir;
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;

const FRAGMENT_INDEXING_DEBOUNCE_SECS: u64 = 2;
const FRAGMENT_INDEXING_MAX_DEBOUNCE_SECS: u64 = 10;

static FRAGMENT_INDEXING_QUEUE: OnceCell<mpsc::UnboundedSender<FragmentIndexingRequest>> = OnceCell::new();

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct FragmentIndexingRequest {
  user_id: String,
  item_id: String,
}

pub fn init_fragment_indexing_loop(config: &Config, _db: Arc<Mutex<Db>>) -> InfuResult<()> {
  if FRAGMENT_INDEXING_QUEUE.get().is_some() {
    return Ok(());
  }

  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let (sender, receiver) = mpsc::unbounded_channel();
  FRAGMENT_INDEXING_QUEUE
    .set(sender)
    .map_err(|_| "Fragment lexical indexing loop is already running in this process.".to_owned())?;

  info!("Starting item-level fragment lexical indexing loop; no startup index rebuild will run.");
  let _worker = task::spawn(async move {
    run_fragment_indexing_loop(data_dir, receiver).await;
  });
  Ok(())
}

pub fn enqueue_fragment_lexical_index_update(user_id: &str, item_id: &str) {
  let Some(sender) = FRAGMENT_INDEXING_QUEUE.get() else {
    return;
  };
  let request = FragmentIndexingRequest { user_id: user_id.to_owned(), item_id: item_id.to_owned() };
  if let Err(e) = sender.send(request) {
    warn!("Could not enqueue item-level fragment lexical index update: {}", e);
  }
}

async fn run_fragment_indexing_loop(data_dir: String, mut receiver: mpsc::UnboundedReceiver<FragmentIndexingRequest>) {
  let mut queued = HashSet::new();
  while let Some(request) = receiver.recv().await {
    queued.insert(request);
    drain_pending(&mut receiver, &mut queued);

    let max_deadline = Instant::now() + Duration::from_secs(FRAGMENT_INDEXING_MAX_DEBOUNCE_SECS);
    loop {
      let deadline = (Instant::now() + Duration::from_secs(FRAGMENT_INDEXING_DEBOUNCE_SECS)).min(max_deadline);
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
    debug!("Applying {} item-level fragment lexical index update(s).", requests.len());
    let mut item_ids_by_user = BTreeMap::<String, Vec<String>>::new();
    for request in requests {
      item_ids_by_user.entry(request.user_id).or_default().push(request.item_id);
    }
    for (user_id, item_ids) in item_ids_by_user {
      let mut updates = Vec::<(String, Vec<LexicalFragment>)>::new();
      for item_id in item_ids {
        match load_item_lexical_fragments(&data_dir, &user_id, &item_id).await {
          Ok(fragments) => updates.push((item_id, fragments)),
          Err(e) => error!(
            "Could not load lexical fragments for item '{}' (user {}): {}",
            item_id,
            user_id_for_log(&user_id),
            e
          ),
        }
      }
      if updates.is_empty() {
        continue;
      }
      if let Err(e) = commit_user_updates(&data_dir, &user_id, &updates).await {
        error!("Fragment lexical index batch update failed for user {}: {}", user_id_for_log(&user_id), e);
      }
    }
  }
}

async fn commit_user_updates(
  data_dir: &str,
  user_id: &str,
  updates: &[(String, Vec<LexicalFragment>)],
) -> InfuResult<()> {
  ensure_user_index_dir(data_dir, user_id).await?;
  let update_refs =
    updates.iter().map(|(item_id, fragments)| (item_id.as_str(), fragments.as_slice())).collect::<Vec<_>>();
  let count =
    open_user_document_fragment_lexical_index(data_dir, user_id)?.replace_items_fragments(&update_refs).await?;
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
