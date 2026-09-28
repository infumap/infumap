//! One recovery pass before background workers and HTTP requests can change items.
//! Artifacts remain the only bookkeeping: invalidating obsolete fragments makes
//! the existing workers' startup scans discover the necessary regeneration.
//! Local text (extracted PDF text, image descriptions, copies of Markdown/text
//! originals) is trusted to reflect the original, so no originals are read here.

use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Arc;

use infusdk::item::Item;
use infusdk::util::infu::InfuResult;
use log::{info, warn};
use serde_json::Value;
use tokio::fs;
use tokio::sync::Mutex;

use crate::storage::db::Db;

use super::artifact_io::sha256;
use super::artifact_paths::{item_geo_manifest_path, item_text_content_path, item_text_manifest_path};
use super::fragment::sources::{
  artifact_fragment_input_sha256, item_title_fragment_for_item, read_local_text_copy,
  search_fragment_context_title_for_item,
};
use super::fragment::{delete_item_fragment_artifacts, fragment_inputs_are_current, read_item_fragments};
use super::fragment_indexing::{commit_user_updates, item_fragment_index_is_current, load_item_search_fragments};
use super::geo::{delete_item_geo_artifacts, extract_geo_query_coordinates, geo_manifest_is_complete};
use super::image_tagging::{ImageTagArtifactState, image_tagging_artifact_state};
use super::lexical_index::{
  LexicalFragment, open_user_document_fragment_lexical_index, open_user_item_title_lexical_index,
};
use super::search_processing::SearchContentKind;
use super::text_extraction::delete_item_text_dir;
use super::title_indexing::lexical_fragment_from_item_title_fragment;
use super::user_id_for_log;

const BATCH_SIZE: usize = 100;

pub async fn reconcile_search_at_startup(data_dir: &str, db: Arc<Mutex<Db>>) -> InfuResult<()> {
  info!("Reconciling search artifacts and indexes at startup (before background processing).");
  let mut items_by_user = {
    let db = db.lock().await;
    let mut users = db.user.all_user_ids().iter().map(|id| (id.clone(), Vec::new())).collect::<BTreeMap<_, _>>();
    for key in db.item.all_loaded_items() {
      users.entry(key.user_id).or_default().push(key.item_id);
    }
    users
  };

  for (user_id, item_ids) in &mut items_by_user {
    item_ids.sort();
    let live_ids = item_ids.iter().cloned().collect::<HashSet<_>>();
    let title_index = open_user_item_title_lexical_index(data_dir, user_id)?;
    let content_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
    // Index read/write errors stop startup instead of silently declaring repair
    // complete. A corrupt index can be removed while stopped and rebuilt here.
    let title_ids = title_index.indexed_item_ids().await?;
    let content_ids = content_index.indexed_item_ids().await?;
    let orphan_ids = title_ids.union(&content_ids).filter(|id| !live_ids.contains(*id)).cloned().collect::<Vec<_>>();
    for batch in orphan_ids.chunks(BATCH_SIZE) {
      let removals = batch.iter().map(|id| (id.clone(), Vec::<LexicalFragment>::new())).collect::<Vec<_>>();
      let refs = removals.iter().map(|(id, fragments)| (id.as_str(), fragments.as_slice())).collect::<Vec<_>>();
      title_index.replace_items_titles(&refs).await?;
      for id in batch {
        delete_item_fragment_artifacts(data_dir, user_id, id).await?;
      }
      commit_user_updates(data_dir, user_id, &removals).await?;
    }

    let mut invalidated = 0;
    let mut indexed = 0;
    let mut errors = 0;
    for (batch_number, batch) in item_ids.chunks(BATCH_SIZE).enumerate() {
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
      // Titles are inexpensive to derive again and need no separate receipts.
      let titles = snapshots
        .iter()
        .map(|(item, _, title)| (item.id.as_str(), title.as_ref().map(std::slice::from_ref).unwrap_or_default()))
        .collect::<Vec<_>>();
      title_index.replace_items_titles(&titles).await?;

      let mut updates = Vec::new();
      for (item, context, _) in &snapshots {
        let result = reconcile_item_artifacts(data_dir, item, context.as_deref()).await;
        match result {
          Ok(true) => {
            let fragments = load_item_search_fragments(data_dir, user_id, &item.id).await?;
            let membership_matches = content_ids.contains(&item.id) == !fragments.is_empty();
            if !membership_matches || !item_fragment_index_is_current(data_dir, user_id, &item.id).await? {
              updates.push((item.id.clone(), fragments));
            }
          }
          Ok(false) => {
            if delete_item_fragment_artifacts(data_dir, user_id, &item.id).await? {
              invalidated += 1;
            }
            if content_ids.contains(&item.id) {
              updates.push((item.id.clone(), vec![]));
            }
          }
          Err(error) => {
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
      info!(
        "Search startup check for user {}: {}/{} items checked.",
        user_id_for_log(user_id),
        ((batch_number + 1) * BATCH_SIZE).min(item_ids.len()),
        item_ids.len()
      );
      tokio::task::yield_now().await;
    }
    // A crash may have committed the index but missed its search metadata.
    // An empty update repairs that metadata without changing indexed content.
    if indexed == 0 && orphan_ids.is_empty() {
      content_index.replace_items_fragments(&[]).await?;
    }
    if item_ids.is_empty() && orphan_ids.is_empty() {
      title_index.replace_items_titles(&[]).await?;
    }
    // Incremental writers disable merging. Refreshing every title on each
    // restart must not accumulate an unbounded number of index segments.
    title_index.compact().await?;
    info!(
      "Search startup check for user {} complete: {} titles refreshed, {} obsolete fragment artifacts removed, {} content index updates, {} deleted items removed, {} item errors.",
      user_id_for_log(user_id),
      item_ids.len(),
      invalidated,
      indexed,
      orphan_ids.len(),
      errors
    );
  }
  info!("Search startup reconciliation finished; existing workers will process missing artifacts.");
  Ok(())
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
        if !matches!(
          image_tagging_artifact_state(data_dir, &item.owner_id, &item.id).await?,
          ImageTagArtifactState::Succeeded
        ) {
          delete_item_geo_artifacts(data_dir, &item.owner_id, &item.id).await?;
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
