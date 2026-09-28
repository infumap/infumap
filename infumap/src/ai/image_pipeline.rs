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
use tokio::time::sleep;

use crate::ai::artifact_paths::{item_geo_manifest_path, item_text_manifest_path};
use crate::ai::fragment::clear_item_fragments;
use crate::ai::fragment::sources::{build_image_fragment_artifact, search_fragment_context_title_for_item};
use crate::ai::fragment_indexing::enqueue_fragment_lexical_index_update;
use crate::ai::geo::{
  GeoCandidate, GeoManifestStatus, GeoProcessOutcome, GeoRequestThrottle, geo_manifest_status,
  geoapify_api_key_from_config, geoapify_max_requests_per_minute_from_config, geoapify_url_from_config,
  reverse_geocode_candidate_if_needed,
};
use crate::ai::gpu_tools::{GPU_TOOL_IMAGE_EXTRACT, gpu_tools_url_from_config, resolve_gpu_tool_url};
use crate::ai::image_tagging::{
  ImageTagArtifactPolicy, ImageTagArtifactState, WebImageTagArtifactReadiness, image_tagging_artifact_state,
  image_tagging_manifest_is_successful, load_image_for_tagging, prepare_image_tag_artifacts_for_web_background,
  process_loaded_image_tagging, should_tag_image_item,
};
use crate::ai::metrics::{METRIC_AI_IMAGE_PIPELINE_PROCESSED_TOTAL, METRIC_AI_IMAGE_PIPELINE_QUEUE_DEPTH};
use crate::ai::processing_retry::{RetrySchedule, manifest_retry_delay, record_manifest_retry};
use crate::ai::user_id_for_log;
use crate::config::CONFIG_DATA_DIR;
use crate::storage::db::Db;
use crate::storage::object::ObjectStore;

const EMPTY_QUEUE_WAIT_MILLIS: u64 = 1000;
const ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE: bool = true;

static IMAGE_BACKGROUND_PIPELINE_STATE: OnceCell<Arc<Mutex<ImageBackgroundPipelineState>>> = OnceCell::new();

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
  retries: RetrySchedule<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PipelineStage {
  Source,
  Geo,
  Fragment,
}

#[derive(Default)]
struct ImageBackgroundPipelineState {
  source: StageQueue,
  geo: StageQueue,
  fragment: StageQueue,
}

#[derive(Clone)]
struct ImageBackgroundPipelineConfig {
  data_dir: String,
  gpu_tools_url: Option<String>,
  geo_api_key: Option<String>,
  geo_service_url: String,
  geo_max_requests_per_minute: u64,
}

enum SourceImageReconcileOutcome {
  ReadyForDownstream,
  Gone,
  Deferred(Duration),
}

pub fn init_image_background_pipeline_loop(
  config: Arc<Config>,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
) -> InfuResult<()> {
  let pipeline_config = image_background_pipeline_config(config.as_ref())?;
  if IMAGE_BACKGROUND_PIPELINE_STATE.get().is_some() {
    enqueue_all_loaded_images(db, pipeline_config);
    return Ok(());
  }

  if pipeline_config.gpu_tools_url.is_none()
    && pipeline_config.geo_api_key.is_none()
    && !ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE
  {
    debug!("Disabled because image tagging and reverse geo are unconfigured.");
    return Ok(());
  }

  let state = Arc::new(Mutex::new(ImageBackgroundPipelineState::default()));
  IMAGE_BACKGROUND_PIPELINE_STATE
    .set(state.clone())
    .map_err(|_| "Image background pipeline loop is already running in this process.".to_owned())?;

  info!(
    "Starting image background pipeline loops (tag_source=on, gpu_tools={}, reverse_geo={}, fragmenting={}, geo_max_requests_per_minute={}).",
    on_off(pipeline_config.gpu_tools_url.is_some()),
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

pub fn enqueue_image_background_pipeline_item_if_active(item: &Item) {
  let Some(state) = IMAGE_BACKGROUND_PIPELINE_STATE.get() else {
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

pub fn dequeue_image_background_pipeline_item_if_active(item_id: &str) {
  let Some(state) = IMAGE_BACKGROUND_PIPELINE_STATE.get() else {
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

fn image_background_pipeline_config(config: &Config) -> InfuResult<ImageBackgroundPipelineConfig> {
  let data_dir = config.get_string(CONFIG_DATA_DIR).map_err(|e| e.to_string())?;
  let gpu_tools_url = gpu_tools_url_from_config(config)?;
  let geo_api_key = geoapify_api_key_from_config(config)?;
  Ok(ImageBackgroundPipelineConfig {
    data_dir,
    gpu_tools_url,
    geo_api_key,
    geo_service_url: geoapify_url_from_config(config)?,
    geo_max_requests_per_minute: geoapify_max_requests_per_minute_from_config(config)?,
  })
}

async fn image_tagging_endpoint_url(config: &ImageBackgroundPipelineConfig) -> InfuResult<Option<String>> {
  Ok(resolve_gpu_tool_url(config.gpu_tools_url.as_deref(), GPU_TOOL_IMAGE_EXTRACT).await?.map(|url| url.to_string()))
}

async fn run_source_image_loop(
  config: ImageBackgroundPipelineConfig,
  db: Arc<Mutex<Db>>,
  object_store: Arc<ObjectStore>,
  state: Arc<Mutex<ImageBackgroundPipelineState>>,
) {
  loop {
    let candidate = { pop_candidate(&mut *state.lock().await, PipelineStage::Source) };
    let Some(candidate) = candidate else {
      sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };
    let result: InfuResult<SourceImageReconcileOutcome> = async {
      if !item_still_supported(db.clone(), &candidate).await? {
        return Ok(SourceImageReconcileOutcome::Gone);
      }
      if matches!(
        image_tagging_artifact_state(&config.data_dir, &candidate.user_id, &candidate.item_id).await?,
        ImageTagArtifactState::Succeeded
      ) {
        return Ok(SourceImageReconcileOutcome::ReadyForDownstream);
      }
      let delay =
        manifest_retry_delay(&item_text_manifest_path(&config.data_dir, &candidate.user_id, &candidate.item_id)?)
          .await?;
      if !delay.is_zero() {
        return Ok(SourceImageReconcileOutcome::Deferred(delay));
      }
      if config.gpu_tools_url.is_none() {
        return Err("Image processing service is not configured.".into());
      }
      let endpoint = image_tagging_endpoint_url(&config)
        .await?
        .ok_or("Configured GPU service does not advertise image extraction.")?;
      match prepare_image_tag_artifacts_for_web_background(&config.data_dir, &candidate.user_id, &candidate.item_id)
        .await?
      {
        WebImageTagArtifactReadiness::CompleteSuccess => return Ok(SourceImageReconcileOutcome::ReadyForDownstream),
        WebImageTagArtifactReadiness::CompleteFailure => {
          return Err("Image artifact schema needs attention; it will be checked again.".into());
        }
        WebImageTagArtifactReadiness::Ready => {}
      }
      let loaded = load_image_for_tagging(db.clone(), object_store.clone(), &candidate.item_id).await?;
      process_loaded_image_tagging(
        &config.data_dir,
        &endpoint,
        db.clone(),
        loaded,
        false,
        ImageTagArtifactPolicy::web_background(),
      )
      .await?;
      if !image_tagging_manifest_is_successful(&config.data_dir, &candidate.user_id, &candidate.item_id).await? {
        return Err("Image extraction did not produce a successful artifact.".into());
      }
      Ok(SourceImageReconcileOutcome::ReadyForDownstream)
    }
    .await;
    match result {
      Ok(SourceImageReconcileOutcome::ReadyForDownstream) => {
        let mut state = state.lock().await;
        state.source.retries.clear(&candidate.item_id);
        record_image_pipeline_processed(PipelineStage::Source, "success");
        enqueue_source_candidate_downstream_if_needed(&config, &mut state, candidate, "after tag");
      }
      Ok(SourceImageReconcileOutcome::Gone) => {
        state.lock().await.source.retries.clear(&candidate.item_id);
      }
      Ok(SourceImageReconcileOutcome::Deferred(delay)) => {
        let mut state = state.lock().await;
        state.source.retries.defer(candidate.item_id.clone(), delay);
        enqueue_candidate(&mut state, PipelineStage::Source, candidate);
      }
      Err(error) => {
        retry_image(&config, &state, PipelineStage::Source, candidate, &error.to_string(), Duration::ZERO).await
      }
    }
  }
}

async fn retry_image(
  config: &ImageBackgroundPipelineConfig,
  state: &Arc<Mutex<ImageBackgroundPipelineState>>,
  stage: PipelineStage,
  candidate: ImagePipelineCandidate,
  reason: &str,
  minimum_delay: Duration,
) {
  let delay = {
    let mut state = state.lock().await;
    let queue = queue_for_stage_mut(&mut state, stage);
    let delay = queue.retries.failed(candidate.item_id.clone()).max(minimum_delay);
    queue.retries.defer(candidate.item_id.clone(), delay);
    enqueue_candidate(&mut state, stage, candidate.clone());
    delay
  };
  let path = match stage {
    PipelineStage::Source => Some(item_text_manifest_path(&config.data_dir, &candidate.user_id, &candidate.item_id)),
    PipelineStage::Geo => Some(item_geo_manifest_path(&config.data_dir, &candidate.user_id, &candidate.item_id)),
    PipelineStage::Fragment => None,
  };
  if let Some(Ok(path)) = path {
    if let Err(error) = record_manifest_retry(&path, delay).await {
      error!("Could not save image retry hint for '{}': {}", candidate.item_id, error);
    }
  }
  record_image_pipeline_processed(stage, "failed");
  error!(
    "Image '{}' (user {}), {}: {} Retrying in {} seconds.",
    candidate.item_id,
    user_id_for_log(&candidate.user_id),
    stage.label(),
    reason,
    delay.as_secs()
  );
}

fn enqueue_source_candidate_downstream_if_needed(
  config: &ImageBackgroundPipelineConfig,
  state: &mut ImageBackgroundPipelineState,
  candidate: ImagePipelineCandidate,
  reason: &str,
) {
  if config.geo_api_key.is_some() {
    enqueue_candidate_with_log(state, PipelineStage::Geo, candidate.clone(), reason);
  }
  if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
    wake_image_fragments(state, candidate);
  }
}

async fn run_reverse_geo_loop(
  config: ImageBackgroundPipelineConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ImageBackgroundPipelineState>>,
) {
  let geo_api_key = config.geo_api_key.clone().expect("reverse geo loop requires geo_api_key");
  let mut client_retries = RetrySchedule::default();
  let geo_client = loop {
    match reqwest::Client::builder().timeout(Duration::from_secs(30)).build() {
      Ok(client) => break client,
      Err(error) => {
        let delay = client_retries.failed(());
        error!("Could not create location service client: {}. Retrying in {} seconds.", error, delay.as_secs());
        sleep(delay).await;
      }
    }
  };
  let mut geo_cache = HashMap::new();
  let mut throttle = GeoRequestThrottle::new(config.geo_max_requests_per_minute);
  loop {
    let candidate = { pop_candidate(&mut *state.lock().await, PipelineStage::Geo) };
    let Some(candidate) = candidate else {
      sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };
    let check: InfuResult<Option<Duration>> = async {
      if !item_still_supported(db.clone(), &candidate).await? {
        return Ok(None);
      }
      Ok(Some(
        manifest_retry_delay(&item_geo_manifest_path(&config.data_dir, &candidate.user_id, &candidate.item_id)?)
          .await?,
      ))
    }
    .await;
    match check {
      Ok(None) => {
        state.lock().await.geo.retries.clear(&candidate.item_id);
        continue;
      }
      Ok(Some(delay)) if !delay.is_zero() => {
        let mut state = state.lock().await;
        state.geo.retries.defer(candidate.item_id.clone(), delay);
        enqueue_candidate(&mut state, PipelineStage::Geo, candidate);
        continue;
      }
      Err(error) => {
        retry_image(&config, &state, PipelineStage::Geo, candidate, &error.to_string(), Duration::ZERO).await;
        continue;
      }
      Ok(Some(_)) => {}
    }
    let result: InfuResult<GeoProcessOutcome> = async {
      let overwrite = matches!(
        geo_manifest_status(&config.data_dir, &candidate.user_id, &candidate.item_id).await?,
        Some(GeoManifestStatus::Failed)
      );
      let geo_candidate = GeoCandidate {
        user_id: candidate.user_id.clone(),
        item_id: candidate.item_id.clone(),
        mime_type: candidate.mime_type.clone(),
      };
      reverse_geocode_candidate_if_needed(
        &config.data_dir,
        &geo_client,
        &config.geo_service_url,
        &geo_api_key,
        &geo_candidate,
        overwrite,
        &mut geo_cache,
        Some(&mut throttle),
      )
      .await
    }
    .await;
    match result {
      Ok(GeoProcessOutcome::Deferred { reason, retry_after_secs }) => {
        let delay = Duration::from_secs(retry_after_secs.max(1));
        retry_image(&config, &state, PipelineStage::Geo, candidate, reason.label(), delay).await;
        // Provider-wide quota/rate limit, not just a failure of this item.
        sleep(delay).await;
      }
      Ok(GeoProcessOutcome::Failed { .. } | GeoProcessOutcome::SkippedWithoutImageTagOutput) => {
        retry_image(
          &config,
          &state,
          PipelineStage::Geo,
          candidate.clone(),
          "Location lookup failed or is waiting for image extraction.",
          Duration::ZERO,
        )
        .await;
      }
      Ok(outcome) => {
        record_geo_pipeline_processed(&outcome);
        let mut state = state.lock().await;
        state.geo.retries.clear(&candidate.item_id);
        if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
          wake_image_fragments(&mut state, candidate);
        }
      }
      Err(error) => {
        retry_image(&config, &state, PipelineStage::Geo, candidate.clone(), &error.to_string(), Duration::ZERO).await;
      }
    }
  }
}

async fn run_image_fragment_loop(
  config: ImageBackgroundPipelineConfig,
  db: Arc<Mutex<Db>>,
  state: Arc<Mutex<ImageBackgroundPipelineState>>,
) {
  loop {
    let candidate = {
      let mut state = state.lock().await;
      pop_candidate(&mut state, PipelineStage::Fragment)
    };

    let Some(candidate) = candidate else {
      sleep(Duration::from_millis(EMPTY_QUEUE_WAIT_MILLIS)).await;
      continue;
    };

    match reconcile_image_fragment_item(&config, db.clone(), &candidate).await {
      Ok(Some(user_id)) => {
        state.lock().await.fragment.retries.clear(&candidate.item_id);
        enqueue_fragment_lexical_index_update(&user_id, &candidate.item_id);
      }
      Ok(None) => {
        state.lock().await.fragment.retries.clear(&candidate.item_id);
      }
      Err(e) => {
        retry_image(&config, &state, PipelineStage::Fragment, candidate, &e.to_string(), Duration::ZERO).await;
      }
    }
  }
}

async fn reconcile_image_fragment_item(
  config: &ImageBackgroundPipelineConfig,
  db: Arc<Mutex<Db>>,
  candidate: &ImagePipelineCandidate,
) -> InfuResult<Option<String>> {
  let item_snapshot = {
    let db = db.lock().await;
    match db.item.get(&candidate.item_id) {
      Ok(item) if item.owner_id == candidate.user_id && should_tag_image_item(item) => item.clone(),
      _ => {
        record_image_pipeline_processed(PipelineStage::Fragment, "skipped");
        return Ok(None);
      }
    }
  };

  if !matches!(
    image_tagging_artifact_state(&config.data_dir, &item_snapshot.owner_id, &item_snapshot.id).await?,
    ImageTagArtifactState::Succeeded
  ) {
    if clear_item_fragments(&config.data_dir, &item_snapshot).await?.cleared_existing_fragments {
      enqueue_fragment_lexical_index_update(&candidate.user_id, &candidate.item_id);
    }
    return Err("Waiting for successful image extraction.".into());
  }

  let context_title = {
    let db = db.lock().await;
    search_fragment_context_title_for_item(&db, &item_snapshot)
  };
  let fragment_result = build_image_fragment_artifact(&config.data_dir, &item_snapshot, context_title).await?;
  if fragment_result.outcome.wrote_fragments {
    record_image_pipeline_processed(PipelineStage::Fragment, "success");
    debug!(
      "Image fragment pipeline wrote {} fragment(s) for image '{}' (user {}).",
      fragment_result.outcome.fragment_count,
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  } else if fragment_result.outcome.cleared_existing_fragments {
    record_image_pipeline_processed(PipelineStage::Fragment, "success");
    debug!(
      "Image fragment pipeline cleared stale fragments for image '{}' (user {}).",
      item_snapshot.id,
      user_id_for_log(&item_snapshot.owner_id)
    );
  } else {
    record_image_pipeline_processed(PipelineStage::Fragment, "skipped");
  }

  Ok(
    (fragment_result.outcome.wrote_fragments || fragment_result.outcome.cleared_existing_fragments)
      .then_some(item_snapshot.owner_id),
  )
}

async fn item_still_supported(db: Arc<Mutex<Db>>, candidate: &ImagePipelineCandidate) -> InfuResult<bool> {
  let db = db.lock().await;
  let Ok(item) = db.item.get(&candidate.item_id) else {
    return Ok(false);
  };
  Ok(item.owner_id == candidate.user_id && should_tag_image_item(item))
}

fn enqueue_all_loaded_images(db: Arc<Mutex<Db>>, _config: ImageBackgroundPipelineConfig) {
  let Some(state) = IMAGE_BACKGROUND_PIPELINE_STATE.get() else { return };
  let state = state.clone();
  task::spawn(async move {
    let candidates = {
      let db = db.lock().await;
      db.item
        .all_loaded_items()
        .into_iter()
        .filter_map(|key| db.item.get(&key.item_id).ok())
        .filter_map(ImagePipelineCandidate::from_item)
        .collect::<Vec<_>>()
    };
    let count = candidates.len();
    let mut state = state.lock().await;
    for candidate in candidates {
      enqueue_candidate_for_all_stages(&mut state, candidate);
    }
    info!("Queued {} images for startup processing checks, including failed and unfinished work.", count);
  });
}

fn enqueue_candidate_for_all_stages(
  state: &mut ImageBackgroundPipelineState,
  candidate: ImagePipelineCandidate,
) -> bool {
  // Available image text must not wait behind another image's GPU request.
  if ENABLE_IMAGE_FRAGMENT_AND_INDEX_BACKGROUND_STAGE {
    wake_image_fragments(state, candidate.clone());
  }
  enqueue_candidate(state, PipelineStage::Source, candidate)
}

fn wake_image_fragments(state: &mut ImageBackgroundPipelineState, candidate: ImagePipelineCandidate) {
  state.fragment.retries.clear(&candidate.item_id);
  enqueue_candidate(state, PipelineStage::Fragment, candidate);
}

fn enqueue_live_candidate_for_all_stages_with_log(
  state: &mut ImageBackgroundPipelineState,
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

fn remove_candidate_from_all_stages_with_log(state: &mut ImageBackgroundPipelineState, item_id: &str) {
  let removed = remove_candidate(state, PipelineStage::Source, item_id)
    + remove_candidate(state, PipelineStage::Geo, item_id)
    + remove_candidate(state, PipelineStage::Fragment, item_id);
  if removed > 0 {
    debug!("Dequeued image '{}' from {} stage queue(s); queues: {}.", item_id, removed, queue_depth_summary(state));
  }
}

fn queue_for_stage_mut(state: &mut ImageBackgroundPipelineState, stage: PipelineStage) -> &mut StageQueue {
  match stage {
    PipelineStage::Source => &mut state.source,
    PipelineStage::Geo => &mut state.geo,
    PipelineStage::Fragment => &mut state.fragment,
  }
}

fn pop_candidate(state: &mut ImageBackgroundPipelineState, stage: PipelineStage) -> Option<ImagePipelineCandidate> {
  let queue = queue_for_stage_mut(state, stage);
  let position = queue.queue.iter().position(|candidate| queue.retries.ready(&candidate.item_id))?;
  let candidate = queue.queue.remove(position)?;
  queue.queued_item_ids.remove(&candidate.item_id);
  record_image_pipeline_queue_depths(state);
  Some(candidate)
}

fn enqueue_candidate_with_log(
  state: &mut ImageBackgroundPipelineState,
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
  state: &mut ImageBackgroundPipelineState,
  stage: PipelineStage,
  candidate: ImagePipelineCandidate,
) -> bool {
  let queue = queue_for_stage_mut(state, stage);
  if !queue.queued_item_ids.insert(candidate.item_id.clone()) {
    return false;
  }

  queue.queue.push_back(candidate);
  record_image_pipeline_queue_depths(state);
  true
}

fn remove_candidate(state: &mut ImageBackgroundPipelineState, stage: PipelineStage, item_id: &str) -> usize {
  let queue = queue_for_stage_mut(state, stage);
  queue.retries.clear(&item_id.to_owned());
  let before = queue.queue.len();
  queue.queue.retain(|candidate| candidate.item_id != item_id);
  queue.queued_item_ids.remove(item_id);
  let removed = before.saturating_sub(queue.queue.len());
  record_image_pipeline_queue_depths(state);
  removed
}

fn queue_depth_summary(state: &ImageBackgroundPipelineState) -> String {
  format!("tag={}, geo={}, fragment={}", state.source.queue.len(), state.geo.queue.len(), state.fragment.queue.len())
}

fn record_image_pipeline_queue_depths(state: &ImageBackgroundPipelineState) {
  METRIC_AI_IMAGE_PIPELINE_QUEUE_DEPTH.with_label_values(&["tag"]).set(state.source.queue.len() as i64);
  METRIC_AI_IMAGE_PIPELINE_QUEUE_DEPTH.with_label_values(&["geo"]).set(state.geo.queue.len() as i64);
  METRIC_AI_IMAGE_PIPELINE_QUEUE_DEPTH.with_label_values(&["fragment"]).set(state.fragment.queue.len() as i64);
}

fn record_image_pipeline_processed(stage: PipelineStage, outcome: &'static str) {
  METRIC_AI_IMAGE_PIPELINE_PROCESSED_TOTAL.with_label_values(&[stage.metric_label(), outcome]).inc();
}

fn record_geo_pipeline_processed(outcome: &GeoProcessOutcome) {
  let metric_outcome = match outcome {
    GeoProcessOutcome::Succeeded { .. } => "success",
    GeoProcessOutcome::Failed { .. } => "failed",
    GeoProcessOutcome::Deferred { .. } => "deferred",
    GeoProcessOutcome::SkippedExisting
    | GeoProcessOutcome::SkippedNoGps
    | GeoProcessOutcome::SkippedWithoutImageTagOutput => "skipped",
  };
  record_image_pipeline_processed(PipelineStage::Geo, metric_outcome);
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

  fn metric_label(self) -> &'static str {
    match self {
      PipelineStage::Source => "tag",
      PipelineStage::Geo => "geo",
      PipelineStage::Fragment => "fragment",
    }
  }
}
