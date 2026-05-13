use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use config::Config;
use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{debug, error, info};
use once_cell::sync::OnceCell;
use tokio::sync::Mutex;
use tokio::task;
use tokio::time::{Instant as TokioInstant, sleep};

use crate::ai::fragment::clear_item_fragments;
use crate::ai::fragment::sources::{build_image_fragment_artifact, embedding_context_title_for_item};
use crate::ai::geo::{
  GeoCandidate, GeoManifestStatus, GeoProcessOutcome, GeoRequestThrottle, geo_manifest_is_complete,
  geo_manifest_status, geoapify_api_key_from_config, geoapify_max_requests_per_minute_from_config,
  geoapify_url_from_config, reverse_geocode_candidate_if_needed,
};
use crate::ai::image_tagging::{
  ImageTagArtifactPolicy, ImageTagArtifactState, LoadedImageTagging, WebImageTagArtifactReadiness,
  image_tagging_artifact_state, image_tagging_manifest_is_successful, load_image_for_tagging,
  prepare_image_tag_artifacts_for_web_background, process_loaded_image_tagging, should_tag_image_item,
};
use crate::ai::indexing::rebuild_fragment_indexes_for_loaded_items;
use crate::ai::text_embedding::{resolve_text_embedding_service_url, text_embedding_url_from_config};
use crate::ai::{user_id_for_log, user_ids_for_log};
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;
use crate::storage::object::ObjectStore;

const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const FRAGMENT_NOT_READY_WAIT_MILLIS: u64 = 1000;
const FRAGMENT_INDEXING_DEBOUNCE_SECS: u64 = 10;
const FRAGMENT_INDEXING_MAX_DEBOUNCE_SECS: u64 = 25;
const FRAGMENT_INDEX_RETRY_DELAY_SECS: u64 = 60;
const ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE: bool = true;

static IMAGE_SEMANTIC_PIPELINE_STATE: OnceCell<Arc<Mutex<ImageSemanticPipelineState>>> = OnceCell::new();

#[derive(Clone)]
struct ImagePipelineCandidate {
  user_id: String,
  item_id: String,
  mime_type: String,
}

impl ImagePipelineCandidate {
  fn from_item(item: &Item) -> Option<ImagePipelineCandidate> {
    if !should_tag_image_item(item) {
      return None;
    }
    Some(ImagePipelineCandidate {
      user_id: item.owner_id.clone(),
      item_id: item.id.clone(),
      mime_type: item.mime_type.clone().unwrap_or_else(|| "application/octet-stream".to_owned()),
    })
  }
}

#[derive(Default)]
struct StageQueue {
  queue: VecDeque<ImagePipelineCandidate>,
  queued_item_ids: HashSet<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PipelineStage {
  Source,
  Geo,
  Fragment,
}

#[derive(Default)]
struct ImageSemanticPipelineState {
  source: StageQueue,
  geo: StageQueue,
  fragment: StageQueue,
}

#[derive(Default)]
struct DirtyFragmentIndexState {
  user_ids: HashSet<String>,
  first_dirty_at: Option<TokioInstant>,
  last_dirty_at: Option<TokioInstant>,
  last_reindex_completed_at: Option<TokioInstant>,
}

#[derive(Default)]
struct StartupReconciliationSummary {
  tag_succeeded: usize,
  tag_failed: usize,
  tag_pending: usize,
  tag_incomplete: usize,
  tag_unsupported_schema: usize,
  tag_unreadable: usize,
  geo_succeeded: usize,
  geo_failed: usize,
  geo_skipped: usize,
  geo_pending_after_successful_tag: usize,
  geo_unreadable: usize,
}

#[derive(Clone)]
struct ImageSemanticPipelineConfig {
  data_dir: String,
  image_tagging_url: Option<String>,
  embed_url: Option<reqwest::Url>,
  geo_api_key: Option<String>,
  geo_service_url: String,
  geo_max_requests_per_minute: u64,
}

enum SourceImageReconcileOutcome {
  ReadyForDownstream,
  NotReady,
}

enum SourceImagePrefetchReadiness {
  NeedsPrefetch,
  ReadyForDownstream,
  NotReady,
}

enum ImageFragmentReadiness {
  Ready,
  Waiting,
  Unavailable,
}

impl DirtyFragmentIndexState {
  fn is_empty(&self) -> bool {
    self.user_ids.is_empty()
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

type SourceImagePrefetchHandle = task::JoinHandle<(ImagePipelineCandidate, InfuResult<LoadedImageTagging>)>;

pub fn init_image_semantic_pipeline_loop(
  config: Arc<Config>,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  let pipeline_config = image_semantic_pipeline_config(config.as_ref())?;
  if IMAGE_SEMANTIC_PIPELINE_STATE.get().is_some() {
    enqueue_all_loaded_images(db, pipeline_config);
    return Ok(());
  }

  if pipeline_config.image_tagging_url.is_none()
    && pipeline_config.geo_api_key.is_none()
    && !ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE
  {
    debug!("Disabled because image tagging and reverse geo are unconfigured.");
    return Ok(());
  }

  let state = Arc::new(Mutex::new(ImageSemanticPipelineState::default()));
  IMAGE_SEMANTIC_PIPELINE_STATE
    .set(state.clone())
    .map_err(|_| "Image background pipeline loop is already running in this process.".to_owned())?;

  info!(
    "Starting image background pipeline loops (tag_source=on, image_tagging={}, reverse_geo={}, fragment_indexing={}, geo_max_requests_per_minute={}).",
    on_off(pipeline_config.image_tagging_url.is_some()),
    on_off(pipeline_config.geo_api_key.is_some()),
    on_off(ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE),
    pipeline_config.geo_max_requests_per_minute
  );

  let source_config = pipeline_config.clone();
  let source_db = db.clone();
  let source_object_store = object_store.clone();
  let source_state = state.clone();
  let _source_worker = task::spawn(async move {
    run_source_image_loop(source_config, source_db, source_object_store, source_state).await;
  });

  if pipeline_config.geo_api_key.is_some() {
    let geo_config = pipeline_config.clone();
    let geo_db = db.clone();
    let geo_state = state.clone();
    let _geo_worker = task::spawn(async move {
      run_reverse_geo_loop(geo_config, geo_db, geo_state).await;
    });
  }

  if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
    let fragment_config = pipeline_config.clone();
    let fragment_db = db.clone();
    let fragment_state = state.clone();
    let _fragment_worker = task::spawn(async move {
      run_image_fragment_loop(fragment_config, fragment_db, fragment_state).await;
    });
  }

  enqueue_all_loaded_images(db, pipeline_config);
  Ok(())
}

pub fn enqueue_image_semantic_pipeline_item_if_active(item: &Item) {
  let Some(state) = IMAGE_SEMANTIC_PIPELINE_STATE.get() else {
    return;
  };
  let Some(candidate) = ImagePipelineCandidate::from_item(item) else {
    return;
  };

  if let Ok(mut state) = state.try_lock() {
    enqueue_live_candidate_for_all_stages_with_log(&mut state, candidate);
    return;
  }

  let state = state.clone();
  let _enqueue = task::spawn(async move {
    let mut state = state.lock().await;
    enqueue_live_candidate_for_all_stages_with_log(&mut state, candidate);
  });
}

pub fn dequeue_image_semantic_pipeline_item_if_active(item_id: &str) {
  let Some(state) = IMAGE_SEMANTIC_PIPELINE_STATE.get() else {
    return;
  };
  let item_id = item_id.to_owned();

  if let Ok(mut state) = state.try_lock() {
    remove_candidate_from_all_stages_with_log(&mut state, &item_id);
    return;
  }

  let state = state.clone();
  let _dequeue = task::spawn(async move {
    let mut state = state.lock().await;
    remove_candidate_from_all_stages_with_log(&mut state, &item_id);
  });
}

fn image_semantic_pipeline_config(config: &Config) -> InfuResult<ImageSemanticPipelineConfig> {
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let image_tagging_url = crate::ai::image_tagging::image_tagging_url_from_config(config)?;
  let embed_url = if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
    match text_embedding_url_from_config(config)? {
      Some(_) => Some(resolve_text_embedding_service_url(config, None, "text_embedding_url")?),
      None => None,
    }
  } else {
    None
  };
  let geo_api_key = geoapify_api_key_from_config(config)?;
  Ok(ImageSemanticPipelineConfig {
    data_dir,
    image_tagging_url,
    embed_url,
    geo_api_key,
    geo_service_url: geoapify_url_from_config(config)?,
    geo_max_requests_per_minute: geoapify_max_requests_per_minute_from_config(config)?,
  })
}

async fn run_source_image_loop(
  config: ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ImageSemanticPipelineState>>,
) {
  let mut next_prefetch: Option<SourceImagePrefetchHandle> = None;

  loop {
    if next_prefetch.is_none() {
      next_prefetch = start_next_source_image_prefetch(&config, db.clone(), object_store.clone(), state.clone()).await;
      if next_prefetch.is_none() {
        sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
        continue;
      }
    }

    let Some(current_prefetch) = next_prefetch.take() else {
      continue;
    };
    let Some((candidate, loaded)) = await_source_image_prefetch(current_prefetch).await else {
      continue;
    };

    next_prefetch = start_next_source_image_prefetch(&config, db.clone(), object_store.clone(), state.clone()).await;

    match process_prefetched_source_image_item(&config, db.clone(), &candidate, loaded).await {
      Ok(SourceImageReconcileOutcome::ReadyForDownstream) => {
        let mut state = state.lock().await;
        enqueue_source_candidate_downstream_if_needed(&config, &mut state, candidate, "after tag");
      }
      Ok(SourceImageReconcileOutcome::NotReady) => {}
      Err(e) => {
        error!(
          "Image source pipeline failed for image '{}' (user '{}'): {}",
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
      }
    }
  }
}

async fn start_next_source_image_prefetch(
  config: &ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ImageSemanticPipelineState>>,
) -> Option<SourceImagePrefetchHandle> {
  loop {
    let candidate = {
      let mut state = state.lock().await;
      pop_candidate(&mut state, PipelineStage::Source)
    };

    let Some(candidate) = candidate else {
      return None;
    };

    match source_image_prefetch_readiness(config, db.clone(), &candidate).await {
      Ok(SourceImagePrefetchReadiness::NeedsPrefetch) => {
        let item_id = candidate.item_id.clone();
        let prefetch_db = db.clone();
        let prefetch_object_store = object_store.clone();
        return Some(task::spawn(async move {
          let loaded = load_image_for_tagging(prefetch_db, prefetch_object_store, &item_id).await;
          (candidate, loaded)
        }));
      }
      Ok(SourceImagePrefetchReadiness::ReadyForDownstream) => {
        let mut state = state.lock().await;
        enqueue_source_candidate_downstream_if_needed(config, &mut state, candidate, "after tag check");
      }
      Ok(SourceImagePrefetchReadiness::NotReady) => {}
      Err(e) => {
        error!(
          "Image source pipeline failed for image '{}' (user '{}'): {}",
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
      }
    }
  }
}

async fn await_source_image_prefetch(
  prefetch: SourceImagePrefetchHandle,
) -> Option<(ImagePipelineCandidate, LoadedImageTagging)> {
  match prefetch.await {
    Ok((candidate, Ok(loaded))) => Some((candidate, loaded)),
    Ok((candidate, Err(e))) => {
      error!(
        "Image source prefetch failed for image '{}' (user '{}'): {}",
        candidate.item_id,
        user_id_for_log(&candidate.user_id),
        e
      );
      None
    }
    Err(e) => {
      error!("Image source prefetch task failed: {}", e);
      None
    }
  }
}

async fn source_image_prefetch_readiness(
  config: &ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  candidate: &ImagePipelineCandidate,
) -> InfuResult<SourceImagePrefetchReadiness> {
  if !item_still_supported(db.clone(), candidate).await? {
    return Ok(SourceImagePrefetchReadiness::NotReady);
  }

  if config.image_tagging_url.is_none() {
    return Ok(match image_tagging_artifact_state(&config.data_dir, &candidate.user_id, &candidate.item_id).await? {
      ImageTagArtifactState::Succeeded => SourceImagePrefetchReadiness::ReadyForDownstream,
      ImageTagArtifactState::Empty
      | ImageTagArtifactState::Incomplete(_)
      | ImageTagArtifactState::UnsupportedSchemaVersion { .. }
      | ImageTagArtifactState::Failed => SourceImagePrefetchReadiness::NotReady,
    });
  }

  match prepare_image_tag_artifacts_for_web_background(&config.data_dir, &candidate.user_id, &candidate.item_id).await?
  {
    WebImageTagArtifactReadiness::CompleteSuccess => return Ok(SourceImagePrefetchReadiness::ReadyForDownstream),
    WebImageTagArtifactReadiness::CompleteFailure => return Ok(SourceImagePrefetchReadiness::NotReady),
    WebImageTagArtifactReadiness::Ready => {}
  }

  Ok(SourceImagePrefetchReadiness::NeedsPrefetch)
}

async fn process_prefetched_source_image_item(
  config: &ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  candidate: &ImagePipelineCandidate,
  loaded: LoadedImageTagging,
) -> InfuResult<SourceImageReconcileOutcome> {
  let Some(image_tagging_url) = config.image_tagging_url.as_deref() else {
    return Ok(SourceImageReconcileOutcome::NotReady);
  };
  process_loaded_image_tagging(
    &config.data_dir,
    image_tagging_url,
    db,
    loaded,
    true,
    ImageTagArtifactPolicy::web_background(),
  )
  .await?;

  if image_tagging_manifest_is_successful(&config.data_dir, &candidate.user_id, &candidate.item_id).await? {
    Ok(SourceImageReconcileOutcome::ReadyForDownstream)
  } else {
    Ok(SourceImageReconcileOutcome::NotReady)
  }
}

fn enqueue_source_candidate_downstream_if_needed(
  config: &ImageSemanticPipelineConfig,
  state: &mut ImageSemanticPipelineState,
  candidate: ImagePipelineCandidate,
  reason: &str,
) {
  if config.geo_api_key.is_some() {
    enqueue_candidate_with_log(state, PipelineStage::Geo, candidate, reason);
  } else if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
    enqueue_candidate_with_log(state, PipelineStage::Fragment, candidate, reason);
  }
}

async fn run_reverse_geo_loop(
  config: ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ImageSemanticPipelineState>>,
) {
  let geo_api_key = config.geo_api_key.clone().expect("reverse geo loop requires geo_api_key");
  let geo_client = match reqwest::ClientBuilder::new().timeout(Duration::from_secs(30)).build() {
    Ok(client) => client,
    Err(e) => {
      error!("Could not build reverse-geo HTTP client; reverse geo will be skipped: {}", e);
      reqwest::Client::new()
    }
  };
  let mut geo_cache = HashMap::new();
  let mut throttle = GeoRequestThrottle::new(config.geo_max_requests_per_minute);

  loop {
    let candidate = {
      let mut state = state.lock().await;
      pop_candidate(&mut state, PipelineStage::Geo)
    };

    let Some(candidate) = candidate else {
      sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };

    match item_still_supported(db.clone(), &candidate).await {
      Ok(true) => {}
      Ok(false) => continue,
      Err(e) => {
        error!(
          "Reverse geo pipeline could not verify image '{}' (user '{}'): {}",
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
        continue;
      }
    }

    let geo_candidate = GeoCandidate {
      user_id: candidate.user_id.clone(),
      item_id: candidate.item_id.clone(),
      mime_type: candidate.mime_type.clone(),
    };
    match reverse_geocode_candidate_if_needed(
      &config.data_dir,
      &geo_client,
      &config.geo_service_url,
      &geo_api_key,
      &geo_candidate,
      false,
      &mut geo_cache,
      Some(&mut throttle),
    )
    .await
    {
      Ok(GeoProcessOutcome::Deferred { reason, retry_after_secs }) => {
        let retry_after = Duration::from_secs(retry_after_secs.max(1));
        info!(
          "Suspending reverse geo for {} after Geoapify reported {}.",
          format_duration_for_log(retry_after),
          reason.label()
        );
        {
          let mut state = state.lock().await;
          enqueue_candidate_with_log(&mut state, PipelineStage::Geo, candidate, "after reverse geo deferral");
        }
        sleep(retry_after).await;
      }
      Ok(_) => {
        if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
          let mut state = state.lock().await;
          enqueue_candidate_with_log(&mut state, PipelineStage::Fragment, candidate, "fragmenting");
        }
      }
      Err(e) => {
        error!(
          "Reverse geo pipeline failed for image '{}' (user '{}'): {}",
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
        if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
          let mut state = state.lock().await;
          enqueue_candidate_with_log(&mut state, PipelineStage::Fragment, candidate, "after reverse geo failure");
        }
      }
    }
  }
}

async fn run_image_fragment_loop(
  config: ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ImageSemanticPipelineState>>,
) {
  let mut dirty_index_state = DirtyFragmentIndexState::default();
  loop {
    let candidate = {
      let mut state = state.lock().await;
      pop_candidate(&mut state, PipelineStage::Fragment)
    };

    let Some(candidate) = candidate else {
      if dirty_index_state.should_rebuild(TokioInstant::now()) {
        rebuild_fragment_indexes_for_dirty_users(&config, db.clone(), &mut dirty_index_state).await;
      }
      sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };

    match reconcile_image_fragment_item(&config, db.clone(), &candidate).await {
      Ok(Some(user_id)) => {
        let was_empty = dirty_index_state.is_empty();
        dirty_index_state.record_user(user_id);
        if was_empty {
          debug!(
            "Image fragment pipeline scheduled fragment index rebuild after {} quiet or {} max.",
            format_duration_for_log(Duration::from_secs(FRAGMENT_INDEXING_DEBOUNCE_SECS)),
            format_duration_for_log(Duration::from_secs(FRAGMENT_INDEXING_MAX_DEBOUNCE_SECS))
          );
        }
      }
      Ok(None) => {}
      Err(e) => {
        error!(
          "Image fragment pipeline failed for image '{}' (user '{}'): {}",
          candidate.item_id,
          user_id_for_log(&candidate.user_id),
          e
        );
      }
    }
  }
}

async fn reconcile_image_fragment_item(
  config: &ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  candidate: &ImagePipelineCandidate,
) -> InfuResult<Option<String>> {
  let item_snapshot = {
    let db = db.lock().await;
    match db.item.get(&candidate.item_id) {
      Ok(item) if item.owner_id == candidate.user_id && should_tag_image_item(item) => item.clone(),
      _ => return Ok(None),
    }
  };

  match image_fragment_readiness(config, &item_snapshot).await? {
    ImageFragmentReadiness::Ready => {}
    ImageFragmentReadiness::Waiting => {
      sleep(Duration::from_millis(FRAGMENT_NOT_READY_WAIT_MILLIS)).await;
      enqueue_image_semantic_pipeline_item_if_active(&item_snapshot);
      return Ok(None);
    }
    ImageFragmentReadiness::Unavailable => {
      let outcome = clear_item_fragments(&config.data_dir, &item_snapshot).await?;
      if outcome.cleared_existing_fragments {
        debug!(
          "Image fragment pipeline cleared stale fragments for image '{}' (user {}) because image tagging is not successful.",
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
  let fragment_result = build_image_fragment_artifact(&config.data_dir, &item_snapshot, context_title).await?;
  if fragment_result.outcome.wrote_fragments {
    debug!(
      "Image fragment pipeline wrote {} fragment(s) for image '{}' (user {}).",
      fragment_result.outcome.fragment_count,
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  } else if fragment_result.outcome.cleared_existing_fragments {
    debug!(
      "Image fragment pipeline cleared stale fragments for image '{}' (user {}).",
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  }

  Ok(
    (fragment_result.outcome.wrote_fragments || fragment_result.outcome.cleared_existing_fragments)
      .then_some(item_snapshot.owner_id),
  )
}

async fn image_fragment_readiness(
  config: &ImageSemanticPipelineConfig,
  item: &Item,
) -> InfuResult<ImageFragmentReadiness> {
  match image_tagging_artifact_state(&config.data_dir, &item.owner_id, &item.id).await? {
    ImageTagArtifactState::Succeeded => {}
    ImageTagArtifactState::Empty | ImageTagArtifactState::Incomplete(_) if config.image_tagging_url.is_some() => {
      return Ok(ImageFragmentReadiness::Waiting);
    }
    ImageTagArtifactState::Empty
    | ImageTagArtifactState::Incomplete(_)
    | ImageTagArtifactState::Failed
    | ImageTagArtifactState::UnsupportedSchemaVersion { .. } => {
      return Ok(ImageFragmentReadiness::Unavailable);
    }
  }

  if config.geo_api_key.is_some() && !geo_manifest_is_complete(&config.data_dir, &item.owner_id, &item.id).await? {
    return Ok(ImageFragmentReadiness::Waiting);
  }

  Ok(ImageFragmentReadiness::Ready)
}

async fn rebuild_fragment_indexes_for_dirty_users(
  config: &ImageSemanticPipelineConfig,
  db: Arc<Mutex<Db>>,
  dirty_index_state: &mut DirtyFragmentIndexState,
) {
  if dirty_index_state.is_empty() {
    return;
  }
  let user_ids = dirty_index_state.drain_user_ids();

  let client = if config.embed_url.is_some() {
    match reqwest::ClientBuilder::new().build() {
      Ok(client) => Some(client),
      Err(e) => {
        error!("Could not build embedding HTTP client for image background pipeline index rebuild: {}", e);
        sleep(Duration::from_secs(FRAGMENT_INDEX_RETRY_DELAY_SECS)).await;
        dirty_index_state.record_users(user_ids);
        return;
      }
    }
  } else {
    None
  };

  info!(
    "Rebuilding fragment indexes after image fragment updates for {} user(s): {}; vector_embedding={}.",
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

  match rebuild_fragment_indexes_for_loaded_items(
    &config.data_dir,
    &user_ids,
    loaded_items,
    client.as_ref(),
    config.embed_url.as_ref(),
    // Web rebuilds start from the current corpus; unchanged embeddings still reuse the completed index.
    false,
  )
  .await
  {
    Ok(summary) => {
      dirty_index_state.record_reindex_completed();
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
      error!("Fragment index rebuild failed: {}", e);
      sleep(Duration::from_secs(FRAGMENT_INDEX_RETRY_DELAY_SECS)).await;
      dirty_index_state.record_users(user_ids);
    }
  }
}

async fn item_still_supported(db: Arc<Mutex<Db>>, candidate: &ImagePipelineCandidate) -> InfuResult<bool> {
  let db = db.lock().await;
  let Ok(item) = db.item.get(&candidate.item_id) else {
    return Ok(false);
  };
  Ok(item.owner_id == candidate.user_id && should_tag_image_item(item))
}

fn enqueue_all_loaded_images(db: Arc<Mutex<Db>>, config: ImageSemanticPipelineConfig) {
  let Some(state) = IMAGE_SEMANTIC_PIPELINE_STATE.get() else {
    return;
  };
  let state = state.clone();
  let _enqueue_task = task::spawn(async move {
    let candidates = {
      let db = db.lock().await;
      db.item
        .all_loaded_items()
        .into_iter()
        .filter_map(|item_key| db.item.get(&item_key.item_id).ok())
        .filter_map(ImagePipelineCandidate::from_item)
        .collect::<Vec<_>>()
    };
    let candidate_count = candidates.len();
    let mut source_candidates = vec![];
    let mut geo_candidates = vec![];
    let mut fragment_candidates = vec![];
    let mut summary = StartupReconciliationSummary::default();
    for candidate in candidates {
      match startup_stage_for_candidate(&config, &candidate, &mut summary).await {
        Ok(Some(PipelineStage::Source)) => source_candidates.push(candidate),
        Ok(Some(PipelineStage::Geo)) => geo_candidates.push(candidate),
        Ok(Some(PipelineStage::Fragment)) => fragment_candidates.push(candidate),
        Ok(None) => {}
        Err(e) => {
          debug!(
            "Skipping image '{}' (user '{}') during image background pipeline startup reconciliation: {}",
            candidate.item_id,
            user_id_for_log(&candidate.user_id),
            e
          );
        }
      }
    }
    let mut state = state.lock().await;
    let source_candidate_count = source_candidates.len();
    let geo_candidate_count = geo_candidates.len();
    let fragment_candidate_count = fragment_candidates.len();
    let source_enqueued_count = enqueue_candidates(&mut state, PipelineStage::Source, source_candidates);
    let geo_enqueued_count = enqueue_candidates(&mut state, PipelineStage::Geo, geo_candidates);
    let fragment_enqueued_count = enqueue_candidates(&mut state, PipelineStage::Fragment, fragment_candidates);
    info!(
      "Startup reconciliation saw {} supported image item(s), queued tag={} of {}, reverse_geo={} of {}, and fragment={} of {}; image_tags: succeeded={}, failed={}, pending={}, incomplete={}, unsupported_schema={}, unreadable={}; reverse_geo: succeeded={}, failed={}, skipped={}, pending_after_successful_tag={}, unreadable={}; queues: {}.",
      candidate_count,
      source_enqueued_count,
      source_candidate_count,
      geo_enqueued_count,
      geo_candidate_count,
      fragment_enqueued_count,
      fragment_candidate_count,
      summary.tag_succeeded,
      summary.tag_failed,
      summary.tag_pending,
      summary.tag_incomplete,
      summary.tag_unsupported_schema,
      summary.tag_unreadable,
      summary.geo_succeeded,
      summary.geo_failed,
      summary.geo_skipped,
      summary.geo_pending_after_successful_tag,
      summary.geo_unreadable,
      queue_depth_summary(&state)
    );
  });
}

async fn startup_stage_for_candidate(
  config: &ImageSemanticPipelineConfig,
  candidate: &ImagePipelineCandidate,
  summary: &mut StartupReconciliationSummary,
) -> InfuResult<Option<PipelineStage>> {
  let tag_state = match image_tagging_artifact_state(&config.data_dir, &candidate.user_id, &candidate.item_id).await {
    Ok(status) => status,
    Err(e) => {
      summary.tag_unreadable += 1;
      return Err(e);
    }
  };

  let tag_succeeded = matches!(tag_state, ImageTagArtifactState::Succeeded);
  match &tag_state {
    ImageTagArtifactState::Succeeded => {
      summary.tag_succeeded += 1;
    }
    ImageTagArtifactState::Failed => {
      summary.tag_failed += 1;
    }
    ImageTagArtifactState::Empty => {
      summary.tag_pending += 1;
      if config.image_tagging_url.is_some() {
        return Ok(Some(PipelineStage::Source));
      }
    }
    ImageTagArtifactState::Incomplete(_) => {
      summary.tag_incomplete += 1;
      if config.image_tagging_url.is_some() {
        return Ok(Some(PipelineStage::Source));
      }
    }
    ImageTagArtifactState::UnsupportedSchemaVersion { .. } => {
      summary.tag_unsupported_schema += 1;
    }
  }

  if config.geo_api_key.is_none() || !tag_succeeded {
    return Ok(if tag_succeeded { startup_fragment_stage_if_enabled() } else { None });
  }

  match geo_manifest_status(&config.data_dir, &candidate.user_id, &candidate.item_id).await {
    Ok(Some(GeoManifestStatus::Succeeded)) => {
      summary.geo_succeeded += 1;
      Ok(startup_fragment_stage_if_enabled())
    }
    Ok(Some(GeoManifestStatus::Failed)) => {
      summary.geo_failed += 1;
      Ok(startup_fragment_stage_if_enabled())
    }
    Ok(Some(GeoManifestStatus::Skipped)) => {
      summary.geo_skipped += 1;
      Ok(startup_fragment_stage_if_enabled())
    }
    Ok(None) => {
      summary.geo_pending_after_successful_tag += 1;
      Ok(Some(PipelineStage::Geo))
    }
    Err(e) => {
      summary.geo_unreadable += 1;
      Err(e)
    }
  }
}

fn startup_fragment_stage_if_enabled() -> Option<PipelineStage> {
  ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE.then_some(PipelineStage::Fragment)
}

fn enqueue_candidate_for_all_stages(state: &mut ImageSemanticPipelineState, candidate: ImagePipelineCandidate) -> bool {
  enqueue_candidate(state, PipelineStage::Source, candidate)
}

fn enqueue_live_candidate_for_all_stages_with_log(
  state: &mut ImageSemanticPipelineState,
  candidate: ImagePipelineCandidate,
) {
  let item_id = candidate.item_id.clone();
  let user_id = user_id_for_log(&candidate.user_id);
  if enqueue_candidate_for_all_stages(state, candidate) {
    debug!(
      "Queued image '{}' (user {}) for tagging after item update; queues: {}.",
      item_id,
      user_id,
      queue_depth_summary(state)
    );
  }
}

fn remove_candidate_from_all_stages_with_log(state: &mut ImageSemanticPipelineState, item_id: &str) {
  let removed = remove_candidate(state, PipelineStage::Source, item_id)
    + remove_candidate(state, PipelineStage::Geo, item_id)
    + remove_candidate(state, PipelineStage::Fragment, item_id);
  if removed > 0 {
    debug!("Dequeued image '{}' from {} stage queue(s); queues: {}.", item_id, removed, queue_depth_summary(state));
  }
}

fn queue_for_stage_mut(state: &mut ImageSemanticPipelineState, stage: PipelineStage) -> &mut StageQueue {
  match stage {
    PipelineStage::Source => &mut state.source,
    PipelineStage::Geo => &mut state.geo,
    PipelineStage::Fragment => &mut state.fragment,
  }
}

fn pop_candidate(state: &mut ImageSemanticPipelineState, stage: PipelineStage) -> Option<ImagePipelineCandidate> {
  let queue = queue_for_stage_mut(state, stage);
  let candidate = queue.queue.pop_front()?;
  queue.queued_item_ids.remove(&candidate.item_id);
  Some(candidate)
}

fn enqueue_candidate_with_log(
  state: &mut ImageSemanticPipelineState,
  stage: PipelineStage,
  candidate: ImagePipelineCandidate,
  reason: &str,
) {
  let item_id = candidate.item_id.clone();
  let user_id = user_id_for_log(&candidate.user_id);
  if enqueue_candidate(state, stage, candidate) {
    if stage == PipelineStage::Fragment && reason == "fragmenting" {
      debug!("Queued image '{}' (user {}) for fragmenting; queues: {}.", item_id, user_id, queue_depth_summary(state));
    } else if reason.is_empty() {
      debug!(
        "Queued image '{}' (user {}) for {}; queues: {}.",
        item_id,
        user_id,
        stage.label(),
        queue_depth_summary(state)
      );
    } else {
      debug!(
        "Queued image '{}' (user {}) for {} {}; queues: {}.",
        item_id,
        user_id,
        stage.label(),
        reason,
        queue_depth_summary(state)
      );
    }
  }
}

fn enqueue_candidate(
  state: &mut ImageSemanticPipelineState,
  stage: PipelineStage,
  candidate: ImagePipelineCandidate,
) -> bool {
  let queue = queue_for_stage_mut(state, stage);
  if !queue.queued_item_ids.insert(candidate.item_id.clone()) {
    return false;
  }

  queue.queue.push_back(candidate);
  true
}

fn enqueue_candidates(
  state: &mut ImageSemanticPipelineState,
  stage: PipelineStage,
  candidates: Vec<ImagePipelineCandidate>,
) -> usize {
  let queue = queue_for_stage_mut(state, stage);
  let mut enqueued_count = 0usize;
  for candidate in candidates {
    if queue.queued_item_ids.insert(candidate.item_id.clone()) {
      queue.queue.push_back(candidate);
      enqueued_count += 1;
    }
  }
  enqueued_count
}

fn remove_candidate(state: &mut ImageSemanticPipelineState, stage: PipelineStage, item_id: &str) -> usize {
  let queue = queue_for_stage_mut(state, stage);
  let before = queue.queue.len();
  queue.queue.retain(|candidate| candidate.item_id != item_id);
  queue.queued_item_ids.remove(item_id);
  before.saturating_sub(queue.queue.len())
}

fn queue_depth_summary(state: &ImageSemanticPipelineState) -> String {
  format!("tag={}, geo={}, fragment={}", state.source.queue.len(), state.geo.queue.len(), state.fragment.queue.len())
}

fn on_off(value: bool) -> &'static str {
  if value { "on" } else { "off" }
}

impl PipelineStage {
  fn label(self) -> &'static str {
    match self {
      PipelineStage::Source => "source",
      PipelineStage::Geo => "reverse_geo",
      PipelineStage::Fragment => "fragment",
    }
  }
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
  if duration.subsec_nanos() == 0 {
    let seconds = duration.as_secs();
    return if seconds == 1 { "1 second".to_owned() } else { format!("{} seconds", seconds) };
  }
  format!("{:.3} seconds", duration.as_secs_f64())
}
