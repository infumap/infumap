use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use infusdk::item::{Item, is_container_item_type};
use infusdk::util::infu::InfuResult;
use log::info;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::sleep;

use crate::ai::image_tagging::{
  LoadedImageTagging, item_needs_image_tagging, load_image_for_tagging, process_loaded_image_tagging,
  should_tag_image_item,
};
use crate::ai::text_extraction::{
  LoadedPdfExtraction, item_needs_text_extraction, load_pdf_for_extraction, process_loaded_pdf_extraction,
};
use crate::storage::db::Db;
use crate::storage::object::{self as storage_object};

#[derive(Clone)]
pub enum ExtractionBatchScope {
  Container { container_id: String },
  AllItems,
}

#[derive(Default)]
struct BatchProgress {
  processed: usize,
  succeeded: usize,
  failed: usize,
}

impl BatchProgress {
  fn summary(&self) -> String {
    format!("total={} succeeded={} failed={}", self.processed, self.succeeded, self.failed)
  }
}

struct BatchUiText {
  noun_singular: &'static str,
  noun_plural: &'static str,
  action_name: &'static str,
  action_infinitive: &'static str,
  action_past: &'static str,
  artifact_label: &'static str,
  throughput_unit_label: Option<&'static str>,
}

#[derive(Clone, Copy)]
enum InternalBatchScope<'a> {
  Container { container_id: &'a str },
  AllItems,
}

type NeedsProcessingFuture<'a> = Pin<Box<dyn Future<Output = InfuResult<bool>> + Send + 'a>>;
type NeedsProcessingFn = for<'a> fn(&'a str, Arc<Mutex<Db>>, &'a str) -> NeedsProcessingFuture<'a>;
type LoadItemFuture<'a, LoadedItem> = Pin<Box<dyn Future<Output = InfuResult<LoadedItem>> + Send + 'a>>;
type LoadItemFn<LoadedItem> = for<'a> fn(
  &'a str,
  &'a str,
  Arc<Mutex<Db>>,
  Arc<storage_object::ObjectStore>,
  &'a str,
) -> LoadItemFuture<'a, LoadedItem>;
type ProcessLoadedItemFuture<'a> = Pin<Box<dyn Future<Output = InfuResult<()>> + Send + 'a>>;
type ProcessLoadedItemFn<LoadedItem> =
  for<'a> fn(&'a str, &'a str, Arc<Mutex<Db>>, LoadedItem, bool) -> ProcessLoadedItemFuture<'a>;

pub async fn process_pdf_extraction_batch(
  data_dir: &str,
  text_extraction_url: &str,
  delay: Duration,
  scope: ExtractionBatchScope,
  overwrite: bool,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
) -> InfuResult<()> {
  let (collected_item_ids, internal_scope) = match &scope {
    ExtractionBatchScope::Container { container_id } => (
      collect_pdf_item_ids_in_container(db.clone(), container_id).await?,
      InternalBatchScope::Container { container_id },
    ),
    ExtractionBatchScope::AllItems => {
      (collect_matching_item_ids_globally(db.clone(), is_extractable_pdf_item).await?, InternalBatchScope::AllItems)
    }
  };
  let total_candidate_items = collected_item_ids.len();
  let (item_ids, skipped_existing) = if overwrite {
    (collected_item_ids, 0)
  } else {
    filter_item_ids_to_process(data_dir, db.clone(), collected_item_ids, item_needs_text_extraction_boxed).await?
  };

  log_skipped_existing(&internal_scope, skipped_existing, total_candidate_items, "PDFs", "extraction artifacts");

  process_batch(
    data_dir,
    text_extraction_url,
    delay,
    internal_scope,
    total_candidate_items,
    skipped_existing,
    item_ids,
    db,
    object_store,
    BatchUiText {
      noun_singular: "PDF",
      noun_plural: "PDFs",
      action_name: "text extraction",
      action_infinitive: "extract",
      action_past: "extracted",
      artifact_label: "extraction artifacts",
      throughput_unit_label: None,
    },
    load_pdf_for_extraction_boxed,
    process_loaded_pdf_extraction_boxed,
  )
  .await
}

pub async fn process_image_tagging_batch(
  data_dir: &str,
  image_tagging_url: &str,
  delay: Duration,
  scope: ExtractionBatchScope,
  overwrite: bool,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
) -> InfuResult<()> {
  let (collected_item_ids, internal_scope) = match &scope {
    ExtractionBatchScope::Container { container_id } => (
      collect_image_item_ids_in_container(db.clone(), container_id).await?,
      InternalBatchScope::Container { container_id },
    ),
    ExtractionBatchScope::AllItems => {
      (collect_matching_item_ids_globally(db.clone(), should_tag_image_item).await?, InternalBatchScope::AllItems)
    }
  };
  let total_candidate_items = collected_item_ids.len();
  let (item_ids, skipped_existing) = if overwrite {
    (collected_item_ids, 0)
  } else {
    filter_item_ids_to_process(data_dir, db.clone(), collected_item_ids, item_needs_image_tagging_boxed).await?
  };

  log_skipped_existing(&internal_scope, skipped_existing, total_candidate_items, "images", "image-tag artifacts");

  process_batch(
    data_dir,
    image_tagging_url,
    delay,
    internal_scope,
    total_candidate_items,
    skipped_existing,
    item_ids,
    db,
    object_store,
    BatchUiText {
      noun_singular: "image",
      noun_plural: "supported images",
      action_name: "image tagging",
      action_infinitive: "tag",
      action_past: "tagged",
      artifact_label: "image-tag artifacts",
      throughput_unit_label: Some("images/min"),
    },
    load_image_for_tagging_boxed,
    process_loaded_image_tagging_boxed,
  )
  .await
}

pub async fn collect_pdf_item_ids_in_container(db: Arc<Mutex<Db>>, container_id: &str) -> InfuResult<Vec<String>> {
  collect_matching_item_ids_in_container(db, container_id, is_extractable_pdf_item).await
}

pub async fn collect_image_item_ids_in_container(db: Arc<Mutex<Db>>, container_id: &str) -> InfuResult<Vec<String>> {
  collect_matching_item_ids_in_container(db, container_id, should_tag_image_item).await
}

pub fn is_extractable_pdf_item(item: &Item) -> bool {
  item.mime_type.as_deref() == Some("application/pdf")
}

fn log_skipped_existing(
  scope: &InternalBatchScope<'_>,
  skipped_existing: usize,
  total_candidate_items: usize,
  noun_plural: &str,
  artifact_label: &str,
) {
  if skipped_existing == 0 {
    return;
  }
  match scope {
    InternalBatchScope::Container { container_id } => {
      info!(
        "Skipping {} of {} {} under container '{}' because {} already exist. Use --overwrite to reprocess them.",
        skipped_existing, total_candidate_items, noun_plural, container_id, artifact_label
      );
    }
    InternalBatchScope::AllItems => {
      info!(
        "Skipping {} of {} {} because {} already exist.",
        skipped_existing, total_candidate_items, noun_plural, artifact_label
      );
    }
  }
}

async fn filter_item_ids_to_process(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  item_ids: Vec<String>,
  needs_processing: NeedsProcessingFn,
) -> InfuResult<(Vec<String>, usize)> {
  let mut filtered_item_ids = vec![];
  let mut skipped_existing = 0usize;

  for item_id in item_ids {
    if needs_processing(data_dir, db.clone(), &item_id).await? {
      filtered_item_ids.push(item_id);
    } else {
      skipped_existing += 1;
    }
  }

  Ok((filtered_item_ids, skipped_existing))
}

async fn collect_matching_item_ids_in_container<PredicateFn>(
  db: Arc<Mutex<Db>>,
  container_id: &str,
  predicate: PredicateFn,
) -> InfuResult<Vec<String>>
where
  PredicateFn: Fn(&Item) -> bool + Copy,
{
  let db = db.lock().await;
  let container = db.item.get(&container_id.to_owned()).map_err(|e| e.to_string())?;
  if !is_container_item_type(container.item_type) {
    return Err(format!("Item '{}' is not a container item.", container_id).into());
  }

  let mut visited_item_ids = HashSet::new();
  let mut collected_item_ids = HashSet::new();
  let mut ordered_item_ids = vec![];
  collect_matching_item_ids_recursive(
    &db,
    container_id,
    &mut visited_item_ids,
    &mut collected_item_ids,
    &mut ordered_item_ids,
    predicate,
  )?;
  Ok(ordered_item_ids)
}

async fn collect_matching_item_ids_globally<PredicateFn>(
  db: Arc<Mutex<Db>>,
  predicate: PredicateFn,
) -> InfuResult<Vec<String>>
where
  PredicateFn: Fn(&Item) -> bool + Copy,
{
  let mut items = {
    let db = db.lock().await;
    db.item
      .all_loaded_items()
      .into_iter()
      .filter_map(|item_and_user_id| db.item.get(&item_and_user_id.item_id).ok().cloned())
      .filter(predicate)
      .collect::<Vec<Item>>()
  };

  items.sort_by(|a, b| {
    let a_size = a.file_size_bytes.unwrap_or(i64::MAX);
    let b_size = b.file_size_bytes.unwrap_or(i64::MAX);
    a_size.cmp(&b_size).then(a.last_modified_date.cmp(&b.last_modified_date)).then(a.id.cmp(&b.id))
  });

  Ok(items.into_iter().map(|item| item.id).collect())
}

fn collect_matching_item_ids_recursive<PredicateFn>(
  db: &Db,
  item_id: &str,
  visited_item_ids: &mut HashSet<String>,
  collected_item_ids: &mut HashSet<String>,
  ordered_item_ids: &mut Vec<String>,
  predicate: PredicateFn,
) -> InfuResult<()>
where
  PredicateFn: Fn(&Item) -> bool + Copy,
{
  if !visited_item_ids.insert(item_id.to_owned()) {
    return Ok(());
  }

  for attachment in db.item.get_attachments(&item_id.to_owned())? {
    if predicate(attachment) && collected_item_ids.insert(attachment.id.clone()) {
      ordered_item_ids.push(attachment.id.clone());
    }
    collect_matching_item_ids_recursive(
      db,
      &attachment.id,
      visited_item_ids,
      collected_item_ids,
      ordered_item_ids,
      predicate,
    )?;
  }

  for child in db.item.get_children(&item_id.to_owned())? {
    if predicate(child) && collected_item_ids.insert(child.id.clone()) {
      ordered_item_ids.push(child.id.clone());
    }
    collect_matching_item_ids_recursive(
      db,
      &child.id,
      visited_item_ids,
      collected_item_ids,
      ordered_item_ids,
      predicate,
    )?;
  }

  Ok(())
}

async fn process_batch<'a, LoadedItem>(
  data_dir: &str,
  service_url: &str,
  delay: Duration,
  scope: InternalBatchScope<'a>,
  total_candidate_items: usize,
  skipped_existing: usize,
  item_ids: Vec<String>,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  ui_text: BatchUiText,
  load_item: LoadItemFn<LoadedItem>,
  process_loaded_item: ProcessLoadedItemFn<LoadedItem>,
) -> InfuResult<()>
where
  LoadedItem: Send + 'static,
{
  let scheduled_items = item_ids.len();

  if item_ids.is_empty() {
    match scope {
      InternalBatchScope::Container { container_id } => {
        if total_candidate_items == 0 {
          info!(
            "No {} found under container '{}'. Nothing to {}.",
            ui_text.noun_plural, container_id, ui_text.action_infinitive
          );
        } else {
          info!(
            "All {} {} under container '{}' already have {}. Nothing to {}. Use --overwrite to reprocess them.",
            total_candidate_items, ui_text.noun_plural, container_id, ui_text.artifact_label, ui_text.action_infinitive
          );
        }
      }
      InternalBatchScope::AllItems => {
        if total_candidate_items == 0 {
          info!("No {} found. Nothing to {}.", ui_text.noun_plural, ui_text.action_infinitive);
        } else if skipped_existing == total_candidate_items {
          info!(
            "All {} {} already have {}. Nothing to {}.",
            total_candidate_items, ui_text.noun_plural, ui_text.artifact_label, ui_text.action_infinitive
          );
        } else {
          info!(
            "No {} were queued for this run. total_discovered={} skipped_existing={}.",
            ui_text.noun_plural, total_candidate_items, skipped_existing
          );
        }
      }
    }
    return Ok(());
  }

  let started_at = Instant::now();
  match scope {
    InternalBatchScope::Container { container_id } => {
      info!(
        "Starting container-scoped {} for container '{}' using '{}' with pipelined source-object prefetch and delay {:.3}s. Scheduled {}: {} (existing skipped: {}, total discovered: {}).",
        ui_text.action_name,
        container_id,
        service_url,
        delay.as_secs_f64(),
        ui_text.noun_plural,
        scheduled_items,
        skipped_existing,
        total_candidate_items
      );
    }
    InternalBatchScope::AllItems => {
      info!(
        "Starting all-items {} using '{}' with pipelined source-object prefetch and delay {:.3}s. Scheduled {}: {} (existing skipped: {}, total discovered: {}).",
        ui_text.action_name,
        service_url,
        delay.as_secs_f64(),
        ui_text.noun_plural,
        scheduled_items,
        skipped_existing,
        total_candidate_items
      );
    }
  }
  let mut queue = VecDeque::from(item_ids);
  let mut progress = BatchProgress::default();
  let mut next_prefetch = queue
    .pop_front()
    .map(|item_id| spawn_prefetch(data_dir, service_url, db.clone(), object_store.clone(), item_id, load_item));
  let mut current_process = advance_prefetch_to_process(
    data_dir,
    service_url,
    db.clone(),
    object_store.clone(),
    &mut queue,
    &mut next_prefetch,
    match scope {
      InternalBatchScope::Container { .. } => "Container-scoped",
      InternalBatchScope::AllItems => "All-items",
    },
    &ui_text,
    &mut progress,
    load_item,
    process_loaded_item,
  )
  .await?;

  while let Some(current_handle) = current_process {
    let next_process = if delay == Duration::ZERO {
      advance_prefetch_to_process(
        data_dir,
        service_url,
        db.clone(),
        object_store.clone(),
        &mut queue,
        &mut next_prefetch,
        match scope {
          InternalBatchScope::Container { .. } => "Container-scoped",
          InternalBatchScope::AllItems => "All-items",
        },
        &ui_text,
        &mut progress,
        load_item,
        process_loaded_item,
      )
      .await?
    } else {
      None
    };

    let (item_id, result) = current_handle.await.map_err(|e| {
      format!(
        "{} {} request task failed: {}",
        match scope {
          InternalBatchScope::Container { .. } => "Container-scoped",
          InternalBatchScope::AllItems => "All-items",
        },
        ui_text.action_name,
        e
      )
    })?;

    match result {
      Ok(()) => {
        progress.processed += 1;
        progress.succeeded += 1;
        let throughput_suffix =
          average_throughput_suffix(&started_at, progress.processed, ui_text.throughput_unit_label);
        match scope {
          InternalBatchScope::Container { .. } => {
            info!(
              "Container-scoped {}: {} '{}' successfully ({}/{}).{}",
              ui_text.action_name, ui_text.action_past, item_id, progress.processed, scheduled_items, throughput_suffix
            );
          }
          InternalBatchScope::AllItems => {
            info!(
              "All-items {}: {} '{}' successfully ({}/{}).{}",
              ui_text.action_name, ui_text.action_past, item_id, progress.processed, scheduled_items, throughput_suffix
            );
          }
        }
      }
      Err(e) => {
        progress.processed += 1;
        progress.failed += 1;
        let throughput_suffix =
          average_throughput_suffix(&started_at, progress.processed, ui_text.throughput_unit_label);
        match scope {
          InternalBatchScope::Container { .. } => {
            info!(
              "Container-scoped {}: failed for '{}' ({}/{}): {}.{}",
              ui_text.action_name, item_id, progress.processed, scheduled_items, e, throughput_suffix
            );
          }
          InternalBatchScope::AllItems => {
            info!(
              "All-items {}: failed for '{}' ({}/{}): {}.{}",
              ui_text.action_name, item_id, progress.processed, scheduled_items, e, throughput_suffix
            );
          }
        }
      }
    }

    if delay > Duration::ZERO {
      sleep(delay).await;
      current_process = advance_prefetch_to_process(
        data_dir,
        service_url,
        db.clone(),
        object_store.clone(),
        &mut queue,
        &mut next_prefetch,
        match scope {
          InternalBatchScope::Container { .. } => "Container-scoped",
          InternalBatchScope::AllItems => "All-items",
        },
        &ui_text,
        &mut progress,
        load_item,
        process_loaded_item,
      )
      .await?;
    } else {
      current_process = next_process;
    }
  }

  match scope {
    InternalBatchScope::Container { container_id } => {
      info!(
        "Container-scoped {} finished for container '{}': scheduled={} skipped_existing={} succeeded={} failed={}.",
        ui_text.action_name, container_id, scheduled_items, skipped_existing, progress.succeeded, progress.failed
      );
    }
    InternalBatchScope::AllItems => {
      info!(
        "All-items {} finished: scheduled={} skipped_existing={} succeeded={} failed={}.",
        ui_text.action_name, scheduled_items, skipped_existing, progress.succeeded, progress.failed
      );
    }
  }

  Ok(())
}

fn spawn_prefetch<LoadedItem>(
  data_dir: &str,
  service_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  item_id: String,
  load_item: LoadItemFn<LoadedItem>,
) -> JoinHandle<(String, InfuResult<LoadedItem>)>
where
  LoadedItem: Send + 'static,
{
  let worker_data_dir = data_dir.to_owned();
  let worker_service_url = service_url.to_owned();
  tokio::spawn(async move {
    let loaded = load_item(&worker_data_dir, &worker_service_url, db, object_store, &item_id).await;
    (item_id, loaded)
  })
}

async fn advance_prefetch_to_process<LoadedItem>(
  data_dir: &str,
  service_url: &str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  queue: &mut VecDeque<String>,
  next_prefetch: &mut Option<JoinHandle<(String, InfuResult<LoadedItem>)>>,
  scope_label: &str,
  ui_text: &BatchUiText,
  progress: &mut BatchProgress,
  load_item: LoadItemFn<LoadedItem>,
  process_loaded_item: ProcessLoadedItemFn<LoadedItem>,
) -> InfuResult<Option<JoinHandle<(String, InfuResult<()>)>>>
where
  LoadedItem: Send + 'static,
{
  loop {
    let Some(current_prefetch) = next_prefetch.take() else {
      return Ok(None);
    };

    let (item_id, loaded_result) = current_prefetch
      .await
      .map_err(|e| format!("{} {} prefetch task failed: {}", scope_label, ui_text.action_name, e))?;

    *next_prefetch = queue.pop_front().map(|next_item_id| {
      spawn_prefetch(data_dir, service_url, db.clone(), object_store.clone(), next_item_id, load_item)
    });
    let pending_queue = queue.len() + usize::from(next_prefetch.is_some());

    match loaded_result {
      Ok(loaded_item) => {
        info!(
          "{} {} starting {} '{}'. Pending queue: {}. Progress: {}",
          scope_label,
          ui_text.action_name,
          ui_text.noun_singular,
          item_id,
          pending_queue,
          progress.summary()
        );
        return Ok(Some(spawn_process_loaded_item(
          data_dir,
          service_url,
          db.clone(),
          item_id,
          loaded_item,
          process_loaded_item,
        )));
      }
      Err(e) => {
        progress.processed += 1;
        progress.failed += 1;
        info!(
          "{} {}: failed during source-object load for '{}'. {} Error: {}",
          scope_label,
          ui_text.action_name,
          item_id,
          progress.summary(),
          e
        );
        if next_prefetch.is_none() {
          return Ok(None);
        }
      }
    }
  }
}

fn spawn_process_loaded_item<LoadedItem>(
  data_dir: &str,
  service_url: &str,
  db: Arc<Mutex<Db>>,
  item_id: String,
  loaded_item: LoadedItem,
  process_loaded_item: ProcessLoadedItemFn<LoadedItem>,
) -> JoinHandle<(String, InfuResult<()>)>
where
  LoadedItem: Send + 'static,
{
  let worker_data_dir = data_dir.to_owned();
  let worker_service_url = service_url.to_owned();
  tokio::spawn(async move {
    let result = process_loaded_item(&worker_data_dir, &worker_service_url, db, loaded_item, true).await;
    (item_id, result)
  })
}

fn average_throughput_suffix(
  started_at: &Instant,
  completed_requests: usize,
  throughput_unit_label: Option<&str>,
) -> String {
  let Some(unit_label) = throughput_unit_label else {
    return String::new();
  };
  if completed_requests == 0 {
    return String::new();
  }

  let elapsed_secs = started_at.elapsed().as_secs_f64().max(0.001);
  let per_minute = (completed_requests as f64) * 60.0 / elapsed_secs;
  format!(" avg_throughput={:.2} {}", per_minute, unit_label)
}

fn item_needs_text_extraction_boxed<'a>(
  data_dir: &'a str,
  db: Arc<Mutex<Db>>,
  item_id: &'a str,
) -> NeedsProcessingFuture<'a> {
  Box::pin(item_needs_text_extraction(data_dir, db, item_id))
}

fn item_needs_image_tagging_boxed<'a>(
  data_dir: &'a str,
  db: Arc<Mutex<Db>>,
  item_id: &'a str,
) -> NeedsProcessingFuture<'a> {
  Box::pin(item_needs_image_tagging(data_dir, db, item_id))
}

fn load_pdf_for_extraction_boxed<'a>(
  data_dir: &'a str,
  service_url: &'a str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  item_id: &'a str,
) -> LoadItemFuture<'a, LoadedPdfExtraction> {
  Box::pin(load_pdf_for_extraction(data_dir, service_url, db, object_store, item_id))
}

fn load_image_for_tagging_boxed<'a>(
  _data_dir: &'a str,
  _service_url: &'a str,
  db: Arc<Mutex<Db>>,
  object_store: Arc<storage_object::ObjectStore>,
  item_id: &'a str,
) -> LoadItemFuture<'a, LoadedImageTagging> {
  Box::pin(load_image_for_tagging(db, object_store, item_id))
}

fn process_loaded_pdf_extraction_boxed<'a>(
  data_dir: &'a str,
  service_url: &'a str,
  db: Arc<Mutex<Db>>,
  loaded: LoadedPdfExtraction,
  retry_endpoint_unavailable: bool,
) -> ProcessLoadedItemFuture<'a> {
  Box::pin(process_loaded_pdf_extraction(data_dir, service_url, db, loaded, retry_endpoint_unavailable))
}

fn process_loaded_image_tagging_boxed<'a>(
  data_dir: &'a str,
  service_url: &'a str,
  db: Arc<Mutex<Db>>,
  loaded: LoadedImageTagging,
  retry_endpoint_unavailable: bool,
) -> ProcessLoadedItemFuture<'a> {
  Box::pin(process_loaded_image_tagging(data_dir, service_url, db, loaded, retry_endpoint_unavailable))
}
