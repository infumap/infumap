//! One recovery pass before background workers and HTTP requests can change items.
//! Artifacts remain the only bookkeeping: invalidating obsolete fragments makes
//! the existing workers' startup scans discover the necessary regeneration.
//! Local text (extracted PDF text, image descriptions, copies of Markdown/text
//! originals) is trusted to reflect the original, so no originals are read here.
//!
//! Deliberate trade-off: originals are immutable (written once when an item is
//! added), so re-reading or re-hashing them to validate local text is pure cost.
//! Do not add original-file checks here; on S3 they made every restart download
//! the whole corpus.
//!
//! Deliberate trade-off: an item verified on a previous startup is not checked
//! in depth again while its generated files keep the same sizes and modification
//! times (and its relevant metadata is unchanged). Only a few `stat` calls are
//! made for it. A file replaced with identical size and modification time, for
//! example by a backup restore that preserves times, goes unnoticed; delete the
//! user's `search_startup_check.json` to force a full check.
//!
//! Deliberate trade-off: this runs at startup only. There is no periodic corpus
//! scan while running; manual edits to generated files and missed notifications
//! are picked up on the next restart. Repeating some work after a crash is
//! accepted; exactly-once processing is not a goal.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;
use tokio::sync::Mutex;

use crate::storage::db::Db;
use crate::util::fs::expand_tilde;

use super::artifact_io::{atomic_write_unsynced, sha256};
use super::artifact_paths::{
  item_fragments_dir, item_fragments_manifest_path, item_fragments_path, item_geo_content_path, item_geo_manifest_path,
  item_text_content_path, item_text_manifest_path,
};
use super::fragment::sources::{
  artifact_fragment_input_sha256, item_title_fragment_for_item, read_local_text_copy,
  search_fragment_context_title_for_item,
};
use super::fragment::{
  FRAGMENTER_VERSION, FRAGMENTS_SCHEMA_VERSION, delete_item_fragment_artifacts, fragment_inputs_are_current,
  read_item_fragments,
};
use super::fragment_indexing::{commit_user_updates, item_fragment_index_is_current, load_item_search_fragments};
use super::geo::{
  GeoManifestStatus, delete_item_geo_artifacts, extract_geo_query_coordinates, geo_manifest_is_complete,
  geo_manifest_status,
};
use super::image_tagging::{ImageTagArtifactState, image_tagging_artifact_state, is_supported_image_tagging_mime_type};
use super::lexical_index::{
  FragmentLexicalIndexRebuildStatus, LexicalFragment, document_fragment_lexical_index_dir,
  open_user_document_fragment_lexical_index, open_user_item_title_lexical_index, remove_outdated_lexical_indexes,
};
use super::search_processing::SearchContentKind;
use super::text_extraction::delete_item_text_dir;
use super::title_indexing::lexical_fragment_from_item_title_fragment;
use super::user_id_for_log;

const BATCH_SIZE: usize = 100;
const STARTUP_CHECK_FILENAME: &str = "search_startup_check.json";
const STARTUP_CHECK_VERSION: u32 = 2;
const PROGRESS_LOG_INTERVAL_SECS: u64 = 30;

/// Items the startup check could not confirm as complete. The background
/// workers queue only these at startup rather than re-verifying every item,
/// which would repeat this check's work far more expensively.
///
/// Deliberate trade-off: workers trust this result. Do not reintroduce
/// full-corpus worker scans at startup; they re-hashed every image and document
/// on every restart.
#[derive(Default)]
pub struct StartupWork {
  /// Items whose content (extraction, fragments or indexing) may need work.
  pub content_item_ids: HashSet<String>,
  /// Images with current content whose optional location lookup is missing or
  /// failed. Only collected when location lookup is configured.
  pub location_item_ids: HashSet<String>,
}

pub async fn reconcile_search_at_startup(
  data_dir: &str,
  db: Arc<Mutex<Db>>,
  location_enabled: bool,
) -> InfuResult<StartupWork> {
  let mut work = StartupWork::default();
  info!("Reconciling search artifacts and indexes at startup (before background processing).");
  let mut items_by_user = {
    let db = db.lock().await;
    let mut users = db.user.all_user_ids().iter().map(|id| (id.clone(), Vec::new())).collect::<BTreeMap<_, _>>();
    for key in db.item.all_loaded_items() {
      users.entry(key.user_id).or_default().push(key.item_id);
    }
    users
  };

  let started = Instant::now();
  let total_items = items_by_user.values().map(Vec::len).sum::<usize>();
  info!("Search startup check: {} user(s), {} item(s).", items_by_user.len(), total_items);
  for (user_id, item_ids) in &mut items_by_user {
    let user_started = Instant::now();
    item_ids.sort();
    let live_ids = item_ids.iter().cloned().collect::<HashSet<_>>();
    remove_outdated_lexical_indexes(data_dir, user_id).await?;
    let title_index = open_user_item_title_lexical_index(data_dir, user_id)?;
    let content_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
    // Index read/write errors stop startup instead of silently declaring repair
    // complete. A corrupt index can be removed while stopped and rebuilt here.
    let mut indexed_titles = title_index.indexed_titles().await?;
    let title_ids = indexed_titles.keys().cloned().collect::<HashSet<_>>();
    let content_ids = content_index.indexed_item_ids().await?;
    let orphan_ids = title_ids.union(&content_ids).filter(|id| !live_ids.contains(*id)).cloned().collect::<Vec<_>>();
    // Deliberate trade-off: title changes are collected and committed once per
    // user, and unchanged titles are not rewritten, so a restart without
    // changes writes nothing to the title index and creates no segments.
    let mut title_updates = orphan_ids
      .iter()
      .filter(|id| title_ids.contains(*id))
      .map(|id| (id.clone(), Vec::<LexicalFragment>::new()))
      .collect::<Vec<_>>();
    for batch in orphan_ids.chunks(BATCH_SIZE) {
      let removals = batch.iter().map(|id| (id.clone(), Vec::<LexicalFragment>::new())).collect::<Vec<_>>();
      for id in batch {
        delete_item_fragment_artifacts(data_dir, user_id, id).await?;
      }
      commit_user_updates(data_dir, user_id, &removals).await?;
    }

    let stamp_path = startup_check_path(data_dir, user_id)?;
    let previous_stamps = read_startup_check(&stamp_path).await;
    let index_identity_before = content_index_identity(data_dir, user_id).await?;
    let mut stamps = HashMap::new();
    let mut verified_in_detail = Vec::new();
    let mut invalidated = 0;
    let mut indexed = 0;
    let mut errors = 0;
    let mut checked = 0;
    let mut checked_in_detail = 0;
    let mut last_progress_log = Instant::now();
    for batch in item_ids.chunks(BATCH_SIZE) {
      let snapshots = {
        let db = db.lock().await;
        batch
          .iter()
          .map(|id| {
            let item = db.item.get(id)?;
            let context = search_fragment_context_title_for_item(&db, item);
            let title = item_title_fragment_for_item(&db, item)?.map(lexical_fragment_from_item_title_fragment);
            Ok((item.clone(), context, title))
          })
          .collect::<InfuResult<Vec<_>>>()?
      };
      for (item, _, title) in &snapshots {
        let desired = title.as_ref().map(std::slice::from_ref).unwrap_or_default();
        let indexed = indexed_titles.remove(&item.id).unwrap_or_default();
        if indexed.as_slice() != desired {
          title_updates.push((item.id.clone(), desired.to_vec()));
        }
      }

      let mut updates = Vec::new();
      for (item, context, _) in &snapshots {
        checked += 1;
        if SearchContentKind::from_mime_type(item.mime_type.as_deref()).is_some() {
          if let Ok(stamp) = item_check_stamp(data_dir, item, context.as_deref(), &index_identity_before).await {
            if let Some(previous) = previous_stamps.get(&item.id).filter(|previous| previous.stamp == stamp) {
              if previous.location_pending && location_enabled {
                work.location_item_ids.insert(item.id.clone());
              }
              stamps.insert(item.id.clone(), ItemCheck { stamp, location_pending: previous.location_pending });
              continue;
            }
          }
          checked_in_detail += 1;
        }
        let result = reconcile_item_artifacts(data_dir, item, context.as_deref()).await;
        match result {
          Ok(true) => {
            let fragments = load_item_search_fragments(data_dir, user_id, &item.id).await?;
            let membership_matches = content_ids.contains(&item.id) == !fragments.is_empty();
            if !membership_matches || !item_fragment_index_is_current(data_dir, user_id, &item.id).await? {
              updates.push((item.id.clone(), fragments));
            }
            verified_in_detail.push((item.clone(), context.clone()));
          }
          Ok(false) => {
            if SearchContentKind::from_mime_type(item.mime_type.as_deref()).is_some() {
              work.content_item_ids.insert(item.id.clone());
            }
            if delete_item_fragment_artifacts(data_dir, user_id, &item.id).await? {
              invalidated += 1;
            }
            if content_ids.contains(&item.id) {
              updates.push((item.id.clone(), vec![]));
            }
          }
          Err(error) => {
            work.content_item_ids.insert(item.id.clone());
            errors += 1;
            warn!(
              "Could not reconcile search artifacts for item '{}' (user {}): {}. Will check again on restart.",
              item.id,
              user_id_for_log(user_id),
              error
            );
          }
        }
      }
      if !updates.is_empty() {
        commit_user_updates(data_dir, user_id, &updates).await?;
        indexed += updates.len();
      }
      if last_progress_log.elapsed().as_secs() >= PROGRESS_LOG_INTERVAL_SECS {
        info!(
          "Search startup check for user {}: {}/{} items ({} content unchanged, {} checked in detail).",
          user_id_for_log(user_id),
          checked,
          item_ids.len(),
          stamps.len(),
          checked_in_detail
        );
        last_progress_log = Instant::now();
      }
      tokio::task::yield_now().await;
    }
    if !title_updates.is_empty() {
      let refs = title_updates.iter().map(|(id, titles)| (id.as_str(), titles.as_slice())).collect::<Vec<_>>();
      title_index.replace_items_titles(&refs).await?;
    }
    // A crash may have committed the index but missed its search metadata.
    // An empty update repairs that metadata without changing indexed content.
    if indexed == 0 && orphan_ids.is_empty() && search_metadata_needs_repair(content_index.rebuild_status().await) {
      content_index.replace_items_fragments(&[]).await?;
    }
    if title_updates.is_empty() && search_metadata_needs_repair(title_index.rebuild_status().await) {
      title_index.replace_items_titles(&[]).await?;
    }

    // Stamps embed the content index identity. If this pass created or replaced
    // the index, unchanged items are checked in depth next time instead.
    let unchanged = stamps.len();
    let index_identity = content_index_identity(data_dir, user_id).await?;
    if index_identity != index_identity_before {
      stamps.clear();
    }
    for (item, context) in &verified_in_detail {
      let location_pending = is_supported_image_tagging_mime_type(item.mime_type.as_deref())
        && !matches!(
          geo_manifest_status(data_dir, user_id, &item.id).await,
          Ok(Some(GeoManifestStatus::Succeeded | GeoManifestStatus::Skipped))
        );
      if location_pending && location_enabled {
        work.location_item_ids.insert(item.id.clone());
      }
      if let Ok(stamp) = item_check_stamp(data_dir, item, context.as_deref(), &index_identity).await {
        stamps.insert(item.id.clone(), ItemCheck { stamp, location_pending });
      }
    }
    if stamps != previous_stamps {
      if let Err(error) = write_startup_check(&stamp_path, &stamps).await {
        warn!("Could not save search startup check record for user {}: {}", user_id_for_log(user_id), error);
      }
    }
    info!(
      "Search startup check for user {} complete in {:.1}s: {} items ({} with content unchanged, {} content checked in detail), {} title index updates, {} obsolete fragment artifacts removed, {} content index updates, {} deleted items removed, {} item errors.",
      user_id_for_log(user_id),
      user_started.elapsed().as_secs_f64(),
      item_ids.len(),
      unchanged,
      checked_in_detail,
      title_updates.len(),
      invalidated,
      indexed,
      orphan_ids.len(),
      errors
    );
  }
  info!(
    "Search startup check finished in {:.1}s: {} item(s) need content work and {} need a location lookup; background workers will process only these.",
    started.elapsed().as_secs_f64(),
    work.content_item_ids.len(),
    work.location_item_ids.len()
  );
  Ok(work)
}

#[derive(Deserialize, Serialize)]
struct StartupCheckRecord {
  version: u32,
  items: HashMap<String, ItemCheck>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
struct ItemCheck {
  stamp: String,
  /// Whether an image's location lookup was missing or failed when checked.
  /// Its location files are part of the stamp, so this stays valid while the
  /// stamp matches.
  location_pending: bool,
}

fn startup_check_path(data_dir: &str, user_id: &str) -> InfuResult<PathBuf> {
  let mut path = expand_tilde(data_dir).ok_or("Could not interpret path.")?;
  path.push(format!("user_{}", user_id));
  path.push(STARTUP_CHECK_FILENAME);
  Ok(path)
}

/// A missing or unreadable record only means every item is checked in depth.
async fn read_startup_check(path: &Path) -> HashMap<String, ItemCheck> {
  let Ok(bytes) = fs::read(path).await else { return HashMap::new() };
  match serde_json::from_slice::<StartupCheckRecord>(&bytes) {
    Ok(record) if record.version == STARTUP_CHECK_VERSION => record.items,
    _ => HashMap::new(),
  }
}

async fn write_startup_check(path: &Path, items: &HashMap<String, ItemCheck>) -> InfuResult<()> {
  let record = StartupCheckRecord { version: STARTUP_CHECK_VERSION, items: items.clone() };
  atomic_write_unsynced(path, &serde_json::to_vec(&record)?).await
}

/// Identifies the content index instance that receipts refer to.
async fn content_index_identity(data_dir: &str, user_id: &str) -> InfuResult<String> {
  let index_dir = document_fragment_lexical_index_dir(data_dir, user_id)?;
  if !fs::try_exists(&index_dir).await? {
    return Ok("absent".to_owned());
  }
  if !fs::try_exists(index_dir.join("meta.json")).await? {
    return Ok("incomplete".to_owned());
  }
  match fs::read_to_string(index_dir.join("artifact_generation")).await {
    Ok(generation) => Ok(generation),
    Err(error) if error.kind() == ErrorKind::NotFound => Ok("unidentified".to_owned()),
    Err(error) => Err(error.into()),
  }
}

/// Everything the in-depth check depends on, using file sizes and modification
/// times instead of contents: generated text and location files, fragments,
/// the index receipt, fragment format versions, the index identity, and the
/// item metadata that feeds fragments.
async fn item_check_stamp(
  data_dir: &str,
  item: &Item,
  context: Option<&str>,
  index_identity: &str,
) -> InfuResult<String> {
  let (user_id, item_id) = (item.owner_id.as_str(), item.id.as_str());
  let paths = [
    item_text_content_path(data_dir, user_id, item_id)?,
    item_text_manifest_path(data_dir, user_id, item_id)?,
    item_geo_content_path(data_dir, user_id, item_id)?,
    item_geo_manifest_path(data_dir, user_id, item_id)?,
    item_fragments_path(data_dir, user_id, item_id)?,
    item_fragments_manifest_path(data_dir, user_id, item_id)?,
    item_fragments_dir(data_dir, user_id, item_id)?.join("index_receipt.json"),
  ];
  let mut files = Vec::with_capacity(paths.len());
  for path in paths {
    files.push(match fs::metadata(&path).await {
      Ok(metadata) => {
        let modified = metadata.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
        Some((metadata.len(), modified.as_secs(), modified.subsec_nanos()))
      }
      Err(error) if error.kind() == ErrorKind::NotFound => None,
      Err(error) => return Err(error.into()),
    });
  }
  // Only image fragments include the title and parent context.
  let image = is_supported_image_tagging_mime_type(item.mime_type.as_deref());
  let stamp = sha256(&serde_json::to_vec(&(
    "startup-check-v1",
    FRAGMENTS_SCHEMA_VERSION,
    FRAGMENTER_VERSION,
    &item.mime_type,
    if image { item.title.as_deref() } else { None },
    if image { context } else { None },
    index_identity,
    files,
  ))?);
  Ok(stamp[..32].to_owned())
}

/// Search needs complete metadata that matches the index. Unreadable metadata
/// also needs rewriting.
fn search_metadata_needs_repair(status: InfuResult<Option<FragmentLexicalIndexRebuildStatus>>) -> bool {
  match status {
    Ok(Some(status)) => !status.complete || status.expected_fragment_count != status.indexed_fragment_count,
    Ok(None) | Err(_) => true,
  }
}

/// Return true only when the fragments still describe their current inputs.
async fn reconcile_item_artifacts(data_dir: &str, item: &Item, context: Option<&str>) -> InfuResult<bool> {
  let Some(kind) = SearchContentKind::from_mime_type(item.mime_type.as_deref()) else {
    return Ok(false);
  };
  let input = match kind {
    // Without a local copy the worker must read the original once to make one.
    SearchContentKind::Markdown | SearchContentKind::Text => match read_local_text_copy(data_dir, item).await? {
      Some(bytes) => sha256(&bytes),
      None => return Ok(false),
    },
    SearchContentKind::Image | SearchContentKind::Pdf => {
      let manifest_path = item_text_manifest_path(data_dir, &item.owner_id, &item.id)?;
      if let Some(manifest) = read_json(&manifest_path).await? {
        // Metadata only: text extracted for another type of source is not reused.
        if manifest.get("source_mime_type").and_then(Value::as_str) != item.mime_type.as_deref() {
          delete_item_text_dir(data_dir, &item.owner_id, &item.id).await?;
          delete_item_geo_artifacts(data_dir, &item.owner_id, &item.id).await?;
          return Ok(false);
        }
      }
      if kind == SearchContentKind::Image {
        // Deliberate trade-off: location output is kept while the image text is
        // missing or being regenerated. Its coordinates come from the image's own
        // GPS metadata, which re-extraction of an immutable original reproduces,
        // so redoing the lookup would only spend location-service quota. The
        // coordinates are compared again once new text exists (reconcile_image_geo).
        if !matches!(
          image_tagging_artifact_state(data_dir, &item.owner_id, &item.id).await?,
          ImageTagArtifactState::Succeeded
        ) {
          return Ok(false);
        }
        if let Err(error) = reconcile_image_geo(data_dir, item).await {
          warn!("Optional location reconciliation failed for '{}': {}. Continuing with image content.", item.id, error);
        }
      }
      artifact_fragment_input_sha256(data_dir, item, context).await?
    }
  };
  if !fragment_inputs_are_current(data_dir, &item.owner_id, &item.id, &input).await? {
    return Ok(false);
  }
  // Text and Markdown both fingerprint raw bytes. A MIME change can therefore
  // require new fragments even when the bytes stayed the same.
  let fragments = read_item_fragments(data_dir, &item.owner_id, &item.id).await?;
  Ok(match kind {
    SearchContentKind::Markdown => fragments.source_kind == "markdown",
    SearchContentKind::Text => fragments.source_kind == "text",
    SearchContentKind::Pdf => matches!(fragments.source_kind.as_str(), "pdf_markdown" | "pdf_first_page_caption"),
    SearchContentKind::Image => matches!(fragments.source_kind.as_str(), "image_contents" | "image_document_contents"),
  })
}

async fn reconcile_image_geo(data_dir: &str, item: &Item) -> InfuResult<()> {
  let path = item_geo_manifest_path(data_dir, &item.owner_id, &item.id)?;
  let manifest = read_json(&path).await?;
  let current = if let Some(manifest) = manifest {
    let text = fs::read(item_text_content_path(data_dir, &item.owner_id, &item.id)?).await?;
    let coordinates = extract_geo_query_coordinates(&text)?;
    // Coordinates are also present in legacy manifests, including skipped/no-GPS.
    let stored = manifest
      .pointer("/extractor/query_latitude")
      .and_then(Value::as_f64)
      .zip(manifest.pointer("/extractor/query_longitude").and_then(Value::as_f64));
    coordinates == stored && geo_manifest_is_complete(data_dir, &item.owner_id, &item.id).await?
  } else {
    false
  };
  if !current {
    delete_item_geo_artifacts(data_dir, &item.owner_id, &item.id).await?;
  }
  Ok(())
}

async fn read_json(path: &Path) -> InfuResult<Option<Value>> {
  match fs::read(path).await {
    Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
    Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error.into()),
  }
}
