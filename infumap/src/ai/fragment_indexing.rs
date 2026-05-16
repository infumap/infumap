use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use config::Config;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info};
use once_cell::sync::OnceCell;
use tokio::sync::Mutex;
use tokio::task;
use tokio::time::{Instant as TokioInstant, sleep};

use crate::ai::indexing::{EmbedRebuildSummary, reconcile_fragment_indexes_for_loaded_items};
use crate::ai::metrics::{METRIC_AI_FRAGMENT_INDEX_REBUILD_DURATION_SECONDS, METRIC_AI_FRAGMENT_INDEX_REBUILDS_TOTAL};
use crate::ai::text_embedding::{resolve_text_embedding_service_url, text_embedding_url_from_config};
use crate::ai::{user_id_for_log, user_ids_for_log};
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;

const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const FRAGMENT_INDEXING_DEBOUNCE_SECS: u64 = 10;
const FRAGMENT_INDEXING_MAX_DEBOUNCE_SECS: u64 = 25;
const FRAGMENT_INDEX_RETRY_DELAY_SECS: u64 = 60;
const BACKGROUND_EMBEDDING_REQUEST_TIMEOUT_SECS: u64 = 60;

static FRAGMENT_INDEXING_STATE: OnceCell<Arc<Mutex<DirtyFragmentIndexState>>> = OnceCell::new();

#[derive(Clone)]
struct FragmentIndexingConfig {
  data_dir: String,
  embed_url: Option<reqwest::Url>,
}

#[derive(Default)]
struct DirtyFragmentIndexState {
  user_ids: HashSet<String>,
  first_dirty_at: Option<TokioInstant>,
  last_dirty_at: Option<TokioInstant>,
  last_reindex_completed_at: Option<TokioInstant>,
}

impl DirtyFragmentIndexState {
  fn is_empty(&self) -> bool {
    self.user_ids.is_empty()
  }

  fn record_users_immediate(&mut self, user_ids: Vec<String>) {
    if user_ids.is_empty() {
      return;
    }
    self.first_dirty_at = None;
    self.last_dirty_at = None;
    self.user_ids.extend(user_ids);
  }

  fn record_user(&mut self, user_id: String) {
    let now = TokioInstant::now();
    if self.user_ids.is_empty() {
      self.first_dirty_at = Some(now);
    }
    self.last_dirty_at = Some(now);
    self.user_ids.insert(user_id);
  }

  fn record_users(&mut self, user_ids: Vec<String>) {
    for user_id in user_ids {
      self.record_user(user_id);
    }
  }

  fn should_rebuild(&self, now: TokioInstant) -> bool {
    if self.user_ids.is_empty() {
      return false;
    }
    let Some(first_dirty_at) = self.first_dirty_at else {
      return true;
    };
    let Some(last_dirty_at) = self.last_dirty_at else {
      return true;
    };
    let max_debounce_anchor = self.last_reindex_completed_at.unwrap_or(first_dirty_at);
    now.duration_since(last_dirty_at) >= Duration::from_secs(FRAGMENT_INDEXING_DEBOUNCE_SECS)
      || now.duration_since(max_debounce_anchor) >= Duration::from_secs(FRAGMENT_INDEXING_MAX_DEBOUNCE_SECS)
  }

  fn drain_user_ids(&mut self) -> Vec<String> {
    self.first_dirty_at = None;
    self.last_dirty_at = None;
    self.user_ids.drain().collect()
  }

  fn record_reindex_completed(&mut self) {
    self.last_reindex_completed_at = Some(TokioInstant::now());
  }
}

pub fn init_fragment_indexing_loop(config: &Config, db: Arc<Mutex<Db>>) -> InfuResult<()> {
  let indexing_config = fragment_indexing_config(config)?;
  if FRAGMENT_INDEXING_STATE.get().is_some() {
    enqueue_all_loaded_users_for_fragment_index_rebuild(db);
    return Ok(());
  }

  let state = Arc::new(Mutex::new(DirtyFragmentIndexState::default()));
  FRAGMENT_INDEXING_STATE
    .set(state.clone())
    .map_err(|_| "Fragment index reconciliation loop is already running in this process.".to_owned())?;

  info!(
    "Starting fragment index reconciliation loop (vector_embedding={}).",
    on_off(indexing_config.embed_url.is_some())
  );

  let _worker = task::spawn(async move {
    run_fragment_indexing_loop(indexing_config, db, state).await;
  });
  Ok(())
}

pub fn enqueue_fragment_index_rebuild_for_user(user_id: &str) {
  let Some(state) = FRAGMENT_INDEXING_STATE.get() else {
    return;
  };
  let user_id = user_id.to_owned();

  if let Ok(mut state) = state.try_lock() {
    record_dirty_user_with_log(&mut state, user_id);
    return;
  }

  let state = state.clone();
  let _enqueue = task::spawn(async move {
    let mut state = state.lock().await;
    record_dirty_user_with_log(&mut state, user_id);
  });
}

fn fragment_indexing_config(config: &Config) -> InfuResult<FragmentIndexingConfig> {
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let embed_url = match text_embedding_url_from_config(config)? {
    Some(_) => Some(resolve_text_embedding_service_url(config, None, "text_embedding_url")?),
    None => None,
  };
  Ok(FragmentIndexingConfig { data_dir, embed_url })
}

async fn run_fragment_indexing_loop(
  config: FragmentIndexingConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<DirtyFragmentIndexState>>,
) {
  enqueue_all_loaded_users_for_fragment_index_rebuild_inner(db.clone(), state.clone()).await;

  loop {
    if should_rebuild_dirty_users(state.clone()).await {
      rebuild_fragment_indexes_for_dirty_users(&config, db.clone(), state.clone()).await;
    }
    sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
  }
}

fn enqueue_all_loaded_users_for_fragment_index_rebuild(db: Arc<Mutex<Db>>) {
  let Some(state) = FRAGMENT_INDEXING_STATE.get() else {
    return;
  };
  let state = state.clone();
  let _enqueue_task = task::spawn(async move {
    enqueue_all_loaded_users_for_fragment_index_rebuild_inner(db, state).await;
  });
}

async fn enqueue_all_loaded_users_for_fragment_index_rebuild_inner(
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<DirtyFragmentIndexState>>,
) {
  let mut user_ids = {
    let db = db.lock().await;
    db.user.all_user_ids().iter().map(|user_id| user_id.to_owned()).collect::<Vec<_>>()
  };
  user_ids.sort();
  if user_ids.is_empty() {
    return;
  }

  {
    let mut state = state.lock().await;
    state.record_users_immediate(user_ids.clone());
  }
  info!(
    "Scheduled startup fragment index reconciliation for {} user(s): {}.",
    user_ids.len(),
    user_ids_for_log(&user_ids)
  );
}

async fn should_rebuild_dirty_users(state: Arc<Mutex<DirtyFragmentIndexState>>) -> bool {
  let state = state.lock().await;
  state.should_rebuild(TokioInstant::now())
}

async fn rebuild_fragment_indexes_for_dirty_users(
  config: &FragmentIndexingConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<DirtyFragmentIndexState>>,
) {
  let user_ids = {
    let mut state = state.lock().await;
    if !state.should_rebuild(TokioInstant::now()) {
      return;
    }
    state.drain_user_ids()
  };

  if user_ids.is_empty() {
    return;
  }

  let client = if config.embed_url.is_some() {
    match reqwest::ClientBuilder::new().timeout(Duration::from_secs(BACKGROUND_EMBEDDING_REQUEST_TIMEOUT_SECS)).build()
    {
      Ok(client) => Some(client),
      Err(e) => {
        error!("Could not build embedding HTTP client for fragment index rebuild: {}", e);
        sleep(Duration::from_secs(FRAGMENT_INDEX_RETRY_DELAY_SECS)).await;
        record_dirty_users(state, user_ids).await;
        return;
      }
    }
  } else {
    None
  };

  info!(
    "Rebuilding fragment indexes for {} user(s): {}; vector_embedding={}.",
    user_ids.len(),
    user_ids_for_log(&user_ids),
    on_off(config.embed_url.is_some())
  );

  let user_id_set = user_ids.iter().cloned().collect::<HashSet<_>>();
  let loaded_items = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter(|item_key| user_id_set.contains(&item_key.user_id))
      .collect::<Vec<_>>()
  };
  debug!("Fragment index rebuild using {} loaded item id(s) for {} user(s).", loaded_items.len(), user_ids.len());

  let rebuild_started = Instant::now();
  let rebuild_result = reconcile_fragment_indexes_for_loaded_items(
    &config.data_dir,
    &user_ids,
    loaded_items,
    client.as_ref(),
    config.embed_url.as_ref(),
  )
  .await;
  let rebuild_elapsed_secs = rebuild_started.elapsed().as_secs_f64();
  match rebuild_result {
    Ok(summary) => {
      let metric_outcome = fragment_index_rebuild_metric_outcome(&summary);
      METRIC_AI_FRAGMENT_INDEX_REBUILDS_TOTAL.with_label_values(&[metric_outcome]).inc();
      METRIC_AI_FRAGMENT_INDEX_REBUILD_DURATION_SECONDS
        .with_label_values(&[metric_outcome])
        .observe(rebuild_elapsed_secs);
      {
        let mut state = state.lock().await;
        state.record_reindex_completed();
      }
      info!(
        "Fragment index rebuild complete: users_seen={} rebuilt={} skipped_current={} embedded={} lexical_indexed={} reused={} removed_empty={}.",
        summary.users_seen,
        summary.users_rebuilt,
        summary.users_skipped_current,
        summary.fragments_embedded,
        summary.lexical_fragments_indexed,
        summary.fragments_reused,
        summary.empty_index_files_removed
      );
    }
    Err(e) => {
      METRIC_AI_FRAGMENT_INDEX_REBUILDS_TOTAL.with_label_values(&["failed"]).inc();
      METRIC_AI_FRAGMENT_INDEX_REBUILD_DURATION_SECONDS.with_label_values(&["failed"]).observe(rebuild_elapsed_secs);
      error!("Fragment index rebuild failed: {}", e);
      sleep(Duration::from_secs(FRAGMENT_INDEX_RETRY_DELAY_SECS)).await;
      record_dirty_users(state, user_ids).await;
    }
  }
}

async fn record_dirty_users(state: Arc<Mutex<DirtyFragmentIndexState>>, user_ids: Vec<String>) {
  let mut state = state.lock().await;
  state.record_users(user_ids);
}

fn record_dirty_user_with_log(state: &mut DirtyFragmentIndexState, user_id: String) {
  let was_empty = state.is_empty();
  let short_user_id = user_id_for_log(&user_id);
  state.record_user(user_id);
  if was_empty {
    debug!(
      "Scheduled fragment index rebuild after {} quiet or {} max for user {}.",
      format_duration_for_log(Duration::from_secs(FRAGMENT_INDEXING_DEBOUNCE_SECS)),
      format_duration_for_log(Duration::from_secs(FRAGMENT_INDEXING_MAX_DEBOUNCE_SECS)),
      short_user_id
    );
  }
}

fn fragment_index_rebuild_metric_outcome(summary: &EmbedRebuildSummary) -> &'static str {
  if summary.users_rebuilt > 0 {
    "success"
  } else if summary.users_skipped_current == summary.users_seen {
    "skipped_current"
  } else {
    "success"
  }
}

fn on_off(value: bool) -> &'static str {
  if value { "on" } else { "off" }
}

fn format_duration_for_log(duration: Duration) -> String {
  if duration.as_secs() >= 24 * 60 * 60 && duration.as_secs() % (24 * 60 * 60) == 0 {
    let days = duration.as_secs() / (24 * 60 * 60);
    return if days == 1 { "1 day".to_owned() } else { format!("{} days", days) };
  }
  if duration.as_secs() >= 60 * 60 && duration.as_secs() % (60 * 60) == 0 {
    let hours = duration.as_secs() / (60 * 60);
    return if hours == 1 { "1 hour".to_owned() } else { format!("{} hours", hours) };
  }
  if duration.as_secs() >= 60 && duration.as_secs() % 60 == 0 {
    let minutes = duration.as_secs() / 60;
    return if minutes == 1 { "1 minute".to_owned() } else { format!("{} minutes", minutes) };
  }
  if duration.as_secs() > 0 && duration.subsec_nanos() == 0 {
    let seconds = duration.as_secs();
    return if seconds == 1 { "1 second".to_owned() } else { format!("{} seconds", seconds) };
  }
  format!("{:.3} seconds", duration.as_secs_f64())
}
