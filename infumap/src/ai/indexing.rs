use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::ErrorKind;
use std::path::Path;
use std::time::Instant;

use infusdk::util::infu::InfuResult;
use infusdk::util::uid::Uid;
use log::{debug, info};
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::task::JoinSet;

use crate::ai::artifact_paths::{item_fragments_manifest_path, item_fragments_path, user_fragments_dir};
use crate::ai::fragment::is_lexical_search_source_kind;
use crate::ai::image_tagging::{
  ImageTagArtifactState, image_tagging_artifact_state, is_supported_image_tagging_mime_type,
};
use crate::ai::lexical_index::{
  FragmentLexicalIndexRebuildMetadata, LexicalFragment, document_fragment_lexical_index_temp_dir,
  open_user_document_fragment_lexical_index, remove_document_fragment_lexical_index_dirs,
  user_document_fragment_lexical_index_exists,
};
use crate::ai::search_status::{SearchStatusArtifact, write_search_status_artifact};
use crate::ai::text_embedding::{
  DEFAULT_TEXT_EMBEDDING_BATCH_SIZE, TextEmbeddingBatch, TextEmbeddingInput, embed_texts,
  validate_text_embedding_vector,
};
use crate::ai::text_extraction::{PdfTextArtifactState, pdf_text_artifact_state};
use crate::ai::user_id_for_log;
use crate::ai::vector_db::{
  EmbeddedFragment, FragmentVectorDb, FragmentVectorDbBackend, FragmentVectorDbFragmentKey,
  FragmentVectorDbRebuildMetadata, ensure_user_index_dir, fragment_vector_db_path, fragment_vector_db_temp_path,
  open_fragment_vector_db, open_user_fragment_vector_db, user_fragment_vector_db_exists,
};
use crate::storage::db::Db;
use crate::storage::db::item_db::ItemAndUserId;
use crate::util::fs::path_exists;

const UNKNOWN_FRAGMENT_SOURCE_KIND: &str = "unknown";
const FRAGMENT_MANIFEST_LOAD_CONCURRENCY: usize = 64;
const PDF_SOURCE_MIME_TYPE: &str = "application/pdf";
const MARKDOWN_SOURCE_MIME_TYPE: &str = "text/markdown";
const TEXT_SOURCE_MIME_TYPE: &str = "text/plain";

#[derive(Clone)]
pub struct LoadedFragmentIndexItem {
  pub user_id: Uid,
  pub item_id: Uid,
  pub mime_type: Option<String>,
}

#[derive(Clone, Copy)]
struct FragmentIndexRebuildPolicy {
  continue_rebuild: bool,
  skip_current: bool,
}

impl FragmentIndexRebuildPolicy {
  fn manual(continue_rebuild: bool) -> FragmentIndexRebuildPolicy {
    FragmentIndexRebuildPolicy { continue_rebuild, skip_current: continue_rebuild }
  }

  fn background() -> FragmentIndexRebuildPolicy {
    FragmentIndexRebuildPolicy { continue_rebuild: false, skip_current: true }
  }
}

pub async fn rebuild_all_fragment_indexes(
  data_dir: &str,
  client: Option<&reqwest::Client>,
  embed_url: Option<&Url>,
  continue_rebuild: bool,
) -> InfuResult<EmbedRebuildSummary> {
  let plans = load_fragment_index_plans(data_dir).await?;
  rebuild_fragment_index_plans(data_dir, plans, client, embed_url, FragmentIndexRebuildPolicy::manual(continue_rebuild))
    .await
}

pub async fn reconcile_fragment_indexes_for_loaded_items(
  data_dir: &str,
  user_ids: &[String],
  loaded_items: Vec<LoadedFragmentIndexItem>,
  client: Option<&reqwest::Client>,
  embed_url: Option<&Url>,
) -> InfuResult<EmbedRebuildSummary> {
  let plans = load_fragment_index_plans_for_loaded_items(data_dir, user_ids, loaded_items).await?;
  rebuild_fragment_index_plans(data_dir, plans, client, embed_url, FragmentIndexRebuildPolicy::background()).await
}

async fn rebuild_fragment_index_plans(
  data_dir: &str,
  plans: Vec<UserFragmentIndexPlan>,
  client: Option<&reqwest::Client>,
  embed_url: Option<&Url>,
  policy: FragmentIndexRebuildPolicy,
) -> InfuResult<EmbedRebuildSummary> {
  let mut summary = EmbedRebuildSummary { users_seen: plans.len(), ..Default::default() };

  for plan in plans {
    let outcome = rebuild_user_fragment_index(data_dir, &plan, client, embed_url, policy).await?;
    let search_status_outcome = write_search_status_for_plan(data_dir, &plan, embed_url.is_some()).await?;
    summary.record(&outcome);
    summary.record_search_status(&search_status_outcome);
  }

  Ok(summary)
}

pub async fn delete_item_fragment_index_entries(data_dir: &str, user_id: &str, item_id: &str) -> InfuResult<usize> {
  let mut deleted = 0;
  if user_fragment_vector_db_exists(data_dir, user_id).await? {
    let vector_db = open_user_fragment_vector_db(data_dir, user_id, FragmentVectorDbBackend::SqliteVec)?;
    deleted += vector_db.delete_item_fragments(item_id).await?;
  }
  if user_document_fragment_lexical_index_exists(data_dir, user_id).await? {
    let lexical_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
    deleted += lexical_index.delete_item_fragments(item_id).await?;
  }
  Ok(deleted)
}

async fn load_fragment_index_plans(data_dir: &str) -> InfuResult<Vec<UserFragmentIndexPlan>> {
  let mut db = Db::new(data_dir).await.map_err(|e| format!("Failed to initialize database: {}", e))?;
  let mut user_ids = db.user.all_user_ids();
  user_ids.sort();
  load_fragment_index_plans_for_user_ids(&mut db, data_dir, user_ids).await
}

async fn load_fragment_index_plans_for_user_ids(
  db: &mut Db,
  data_dir: &str,
  user_ids: Vec<String>,
) -> InfuResult<Vec<UserFragmentIndexPlan>> {
  for user_id in &user_ids {
    db.item.load_user_items(user_id, false).await?;
  }

  let loaded_items = db
    .item
    .all_loaded_items()
    .into_iter()
    .filter_map(|item_key| loaded_fragment_index_item_from_key(db, item_key))
    .collect::<Vec<_>>();
  load_fragment_index_plans_for_loaded_items(data_dir, &user_ids, loaded_items).await
}

fn loaded_fragment_index_item_from_key(db: &Db, item_key: ItemAndUserId) -> Option<LoadedFragmentIndexItem> {
  db.item.get(&item_key.item_id).ok().map(|item| LoadedFragmentIndexItem {
    user_id: item.owner_id.clone(),
    item_id: item.id.clone(),
    mime_type: item.mime_type.clone(),
  })
}

async fn load_fragment_index_plans_for_loaded_items(
  data_dir: &str,
  requested_user_ids: &[String],
  loaded_items: Vec<LoadedFragmentIndexItem>,
) -> InfuResult<Vec<UserFragmentIndexPlan>> {
  let load_started = Instant::now();
  let mut user_ids = requested_user_ids.to_vec();
  user_ids.sort();
  user_ids.dedup();

  let mut items_by_user_id = user_ids
    .iter()
    .map(|user_id| (user_id.clone(), Vec::new()))
    .collect::<BTreeMap<String, Vec<LoadedFragmentIndexItem>>>();
  for item in loaded_items {
    if let Some(items) = items_by_user_id.get_mut(&item.user_id) {
      items.push(item);
    }
  }

  let mut plans = Vec::new();
  for (user_id, mut loaded_items) in items_by_user_id {
    let user_started = Instant::now();
    loaded_items.sort_by(|a, b| a.item_id.cmp(&b.item_id));
    loaded_items.dedup_by(|a, b| a.item_id == b.item_id);
    let loaded_item_ids = loaded_items.iter().map(|item| item.item_id.clone()).collect::<HashSet<String>>();
    let loaded_item_count = loaded_item_ids.len();
    info!("User {} scanning fragment artifacts for {} loaded item(s).", user_id_for_log(&user_id), loaded_item_count);

    let artifact_scan_started = Instant::now();
    let item_ids = fragment_item_ids_for_loaded_user(data_dir, &user_id, &loaded_item_ids).await?;
    let artifact_scan_elapsed = artifact_scan_started.elapsed();
    info!(
      "User {} found {} loaded item(s) with fragment artifact dirs in {:.3}s.",
      user_id_for_log(&user_id),
      item_ids.len(),
      artifact_scan_elapsed.as_secs_f64()
    );

    let manifest_load_started = Instant::now();
    let (mut fragment_items, manifest_complete_count) =
      load_fragment_items_from_manifests(data_dir, &user_id, &item_ids, manifest_load_started).await?;

    fragment_items.sort_by(|a, b| a.item_id.cmp(&b.item_id));
    let summary = FragmentCorpusSummary::from_items(&fragment_items);
    info!(
      "User {} loaded fragment manifest plan: {} item(s), complete_manifests={}, lexical_document={} semantic_image={}, scan {:.3}s, manifest_load {:.3}s, total {:.3}s.",
      user_id_for_log(&user_id),
      fragment_items.len(),
      manifest_complete_count,
      summary.lexical_fragment_count,
      summary.vector_fragment_count,
      artifact_scan_elapsed.as_secs_f64(),
      manifest_load_started.elapsed().as_secs_f64(),
      user_started.elapsed().as_secs_f64()
    );
    plans.push(UserFragmentIndexPlan { user_id, loaded_items, fragment_items, summary });
  }

  info!(
    "Prepared {} fragment lexical/semantic index manifest plan(s) in {:.3}s.",
    plans.len(),
    load_started.elapsed().as_secs_f64()
  );
  Ok(plans)
}

async fn fragment_item_ids_for_loaded_user(
  data_dir: &str,
  user_id: &str,
  loaded_item_ids: &HashSet<String>,
) -> InfuResult<Vec<String>> {
  let fragments_dir = user_fragments_dir(data_dir, user_id)?;
  let mut shard_entries = match fs::read_dir(&fragments_dir).await {
    Ok(entries) => entries,
    Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => {
      return Err(format!("Could not read fragment directory '{}': {}", fragments_dir.display(), e).into());
    }
  };

  let mut item_ids = Vec::new();
  let scan_started = Instant::now();
  let mut shard_dir_count = 0;
  let mut artifact_item_dir_count = 0;
  let mut last_progress_log = Instant::now();
  while let Some(shard_entry) = shard_entries
    .next_entry()
    .await
    .map_err(|e| format!("Could not read entry in fragment directory '{}': {}", fragments_dir.display(), e))?
  {
    let shard_file_type = shard_entry
      .file_type()
      .await
      .map_err(|e| format!("Could not read file type for '{}': {}", shard_entry.path().display(), e))?;
    if !shard_file_type.is_dir() {
      continue;
    }
    shard_dir_count += 1;

    let shard_path = shard_entry.path();
    let mut item_entries = fs::read_dir(&shard_path)
      .await
      .map_err(|e| format!("Could not read fragment shard directory '{}': {}", shard_path.display(), e))?;
    while let Some(item_entry) = item_entries
      .next_entry()
      .await
      .map_err(|e| format!("Could not read entry in fragment shard directory '{}': {}", shard_path.display(), e))?
    {
      let item_file_type = item_entry
        .file_type()
        .await
        .map_err(|e| format!("Could not read file type for '{}': {}", item_entry.path().display(), e))?;
      if !item_file_type.is_dir() {
        continue;
      }
      artifact_item_dir_count += 1;

      let item_id = match item_entry.file_name().into_string() {
        Ok(item_id) => item_id,
        Err(_) => continue,
      };
      if !loaded_item_ids.contains(&item_id) {
        continue;
      }

      item_ids.push(item_id);

      if last_progress_log.elapsed().as_secs() >= 10 {
        info!(
          "User {} scanning fragment artifacts: {} shard dir(s), {} artifact item dir(s), {} loaded item dir match(es) so far ({:.3}s elapsed).",
          user_id_for_log(user_id),
          shard_dir_count,
          artifact_item_dir_count,
          item_ids.len(),
          scan_started.elapsed().as_secs_f64()
        );
        last_progress_log = Instant::now();
      }
    }
  }

  item_ids.sort();
  item_ids.dedup();
  Ok(item_ids)
}

async fn load_fragment_items_from_manifests(
  data_dir: &str,
  user_id: &str,
  item_ids: &[String],
  load_started: Instant,
) -> InfuResult<(Vec<FragmentItemForIndex>, usize)> {
  if item_ids.is_empty() {
    return Ok((Vec::new(), 0));
  }

  info!(
    "User {} loading {} fragment manifest(s) with concurrency {}.",
    user_id_for_log(user_id),
    item_ids.len(),
    FRAGMENT_MANIFEST_LOAD_CONCURRENCY
  );

  let mut set = JoinSet::new();
  let mut next_index = 0;
  let mut in_flight = 0;
  let mut completed_count = 0;
  let mut complete_manifest_count = 0;
  let mut fragment_items = Vec::with_capacity(item_ids.len());
  let mut last_progress_log = Instant::now();

  loop {
    while next_index < item_ids.len() && in_flight < FRAGMENT_MANIFEST_LOAD_CONCURRENCY {
      let data_dir = data_dir.to_owned();
      let user_id = user_id.to_owned();
      let item_id = item_ids[next_index].clone();
      set.spawn(async move { load_fragment_item_from_manifest(&data_dir, &user_id, item_id).await });
      next_index += 1;
      in_flight += 1;
    }

    if in_flight == 0 {
      break;
    }

    let join_result =
      set.join_next().await.ok_or("Fragment manifest load task set ended while work was still in flight.")?;
    in_flight -= 1;
    let fragment_item = join_result.map_err(|e| format!("Fragment manifest load task failed: {}", e))??;
    completed_count += 1;
    if fragment_item.has_complete_manifest() {
      complete_manifest_count += 1;
    }
    fragment_items.push(fragment_item);

    if last_progress_log.elapsed().as_secs() >= 10 {
      info!(
        "User {} loading fragment manifests: {}/{} item(s), {} complete manifest(s) so far ({:.3}s elapsed, concurrency {}).",
        user_id_for_log(user_id),
        completed_count,
        item_ids.len(),
        complete_manifest_count,
        load_started.elapsed().as_secs_f64(),
        FRAGMENT_MANIFEST_LOAD_CONCURRENCY
      );
      last_progress_log = Instant::now();
    }
  }

  Ok((fragment_items, complete_manifest_count))
}

async fn load_fragment_item_from_manifest(
  data_dir: &str,
  user_id: &str,
  item_id: String,
) -> InfuResult<FragmentItemForIndex> {
  let manifest_path = item_fragments_manifest_path(data_dir, user_id, &item_id)?;
  let manifest = load_fragments_manifest(&manifest_path).await?;
  Ok(FragmentItemForIndex::from_manifest(item_id, manifest))
}

async fn skip_current_lexical_index_from_manifest(
  data_dir: &str,
  plan: &UserFragmentIndexPlan,
  policy: FragmentIndexRebuildPolicy,
) -> InfuResult<Option<LexicalRebuildOutcome>> {
  if !policy.skip_current {
    return Ok(None);
  }
  if !plan.summary.manifest_complete {
    info!(
      "User {} fragment manifest plan has incomplete metadata; loading document-lexical fragment text before current check.",
      user_id_for_log(&plan.user_id)
    );
    return Ok(None);
  }

  let lexical_current =
    document_fragment_lexical_index_current_from_manifest(data_dir, &plan.user_id, &plan.summary).await?;
  let Some(lexical_current) = lexical_current else {
    return Ok(None);
  };

  if plan.summary.lexical_fragment_count == 0 {
    let removed = remove_document_fragment_lexical_index_dirs(data_dir, &plan.user_id).await?;
    if removed > 0 {
      info!(
        "User {} has no document-lexical fragments; removed {} stale document fragment lexical index dir(s).",
        user_id_for_log(&plan.user_id),
        removed
      );
    }
    return Ok(Some(LexicalRebuildOutcome {
      skipped_current: removed == 0,
      empty_index_files_removed: removed,
      ..Default::default()
    }));
  }

  info!(
    "User {} document fragment lexical index is already current from manifests ({} fragment(s), {}).",
    user_id_for_log(&plan.user_id),
    plan.summary.lexical_fragment_count,
    lexical_current.reason
  );
  Ok(Some(LexicalRebuildOutcome { skipped_current: true, ..Default::default() }))
}

async fn skip_current_vector_index_from_manifest(
  data_dir: &str,
  plan: &UserFragmentIndexPlan,
  policy: FragmentIndexRebuildPolicy,
) -> InfuResult<Option<VectorRebuildOutcome>> {
  if !policy.skip_current {
    return Ok(None);
  }
  if !plan.summary.manifest_complete {
    info!(
      "User {} fragment manifest plan has incomplete metadata; loading image-semantic fragment text before current check.",
      user_id_for_log(&plan.user_id)
    );
    return Ok(None);
  }

  let vector_current = fragment_vector_index_current_from_manifest(data_dir, &plan.user_id, &plan.summary).await?;
  let Some(vector_current) = vector_current else {
    return Ok(None);
  };

  if plan.summary.vector_fragment_count == 0 {
    let final_path = fragment_vector_db_path(data_dir, &plan.user_id)?;
    let temp_path = fragment_vector_db_temp_path(data_dir, &plan.user_id)?;
    let removed = remove_stale_empty_index_files(&final_path, &temp_path).await?;
    if removed > 0 {
      info!(
        "User {} has no image-semantic fragments; removed {} stale image semantic index file(s).",
        user_id_for_log(&plan.user_id),
        removed
      );
    }
    return Ok(Some(VectorRebuildOutcome {
      skipped_current: removed == 0,
      empty_index_files_removed: removed,
      ..Default::default()
    }));
  }

  info!(
    "User {} image semantic index is already current from manifests ({} fragment(s), model '{}', {} dims, {}).",
    user_id_for_log(&plan.user_id),
    plan.summary.vector_fragment_count,
    vector_current.model.as_deref().unwrap_or("unknown"),
    vector_current.dimensions.unwrap_or(0),
    vector_current.reason
  );
  Ok(Some(VectorRebuildOutcome { skipped_current: true, ..Default::default() }))
}

async fn document_fragment_lexical_index_current_from_manifest(
  data_dir: &str,
  user_id: &str,
  summary: &FragmentCorpusSummary,
) -> InfuResult<Option<ManifestCurrentStatus>> {
  if summary.lexical_fragment_count == 0 {
    return Ok(Some(ManifestCurrentStatus::empty()));
  }

  let final_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
  let Some(status) = final_index.rebuild_status().await? else {
    return Ok(None);
  };
  if !status.complete
    || status.expected_fragment_count != summary.lexical_fragment_count
    || status.indexed_fragment_count != summary.lexical_fragment_count
  {
    return Ok(None);
  }

  Ok(Some(ManifestCurrentStatus::from_digest_match(
    summary.lexical_source_digest.as_ref().is_some_and(|digest| status.source_digest == *digest),
  )))
}

async fn fragment_vector_index_current_from_manifest(
  data_dir: &str,
  user_id: &str,
  summary: &FragmentCorpusSummary,
) -> InfuResult<Option<ManifestCurrentStatus>> {
  if summary.vector_fragment_count == 0 {
    return Ok(Some(ManifestCurrentStatus::empty()));
  }

  let temp_path = fragment_vector_db_temp_path(data_dir, user_id)?;
  if path_exists(&temp_path).await {
    return Ok(None);
  }

  let final_path = fragment_vector_db_path(data_dir, user_id)?;
  let final_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, final_path);
  let Some(status) = final_db.rebuild_status().await? else {
    return Ok(None);
  };
  if !status.complete
    || status.expected_fragment_count != summary.vector_fragment_count
    || status.embedded_fragment_count != summary.vector_fragment_count
    || status.embedding_row_count != summary.vector_fragment_count
  {
    return Ok(None);
  }

  let mut current_status = ManifestCurrentStatus::from_digest_match(
    summary.vector_source_digest.as_ref().is_some_and(|digest| status.source_digest == *digest),
  );
  current_status.model = Some(status.model);
  current_status.dimensions = Some(status.embedding_dimensions);
  Ok(Some(current_status))
}

async fn load_fragment_records_for_index_plan(
  data_dir: &str,
  plan: &UserFragmentIndexPlan,
  slice: FragmentIndexSlice,
) -> InfuResult<Vec<FragmentRecordForIndex>> {
  let load_started = Instant::now();
  let fragment_items =
    plan.fragment_items.iter().filter(|item| slice.includes_source_kind(&item.source_kind)).collect::<Vec<_>>();
  info!(
    "User {} loading {} fragment text for index rebuild: {} item(s).",
    user_id_for_log(&plan.user_id),
    slice.label(),
    fragment_items.len()
  );

  let mut fragments = Vec::new();
  let mut processed_item_count = 0;
  let mut loaded_item_count = 0;
  let mut last_progress_log = Instant::now();
  for item in fragment_items.iter() {
    processed_item_count += 1;
    let fragments_path = item_fragments_path(data_dir, &plan.user_id, &item.item_id)?;
    if !path_exists(&fragments_path).await {
      continue;
    }

    let records = load_fragment_records(&fragments_path).await?;
    if records.is_empty() {
      continue;
    }
    loaded_item_count += 1;

    if let Some(expected_count) = item.fragment_count
      && expected_count != records.len()
    {
      return Err(
        format!(
          "Fragment manifest for item '{}' says {} fragment(s), but '{}' contains {} non-empty fragment record(s).",
          item.item_id,
          expected_count,
          fragments_path.display(),
          records.len()
        )
        .into(),
      );
    }

    for record in records {
      fragments.push(FragmentRecordForIndex {
        item_id: item.item_id.clone(),
        ordinal: record.ordinal,
        source_kind: item.source_kind.clone(),
        text_sha256: fragment_text_sha256(&record.text),
        text: record.text,
        page_start: record.page_start,
        page_end: record.page_end,
      });
    }

    if last_progress_log.elapsed().as_secs() >= 10 {
      info!(
        "User {} loading {} fragment text: processed {}/{} item(s), loaded {} non-empty item(s), {} fragment(s) so far ({:.3}s elapsed).",
        user_id_for_log(&plan.user_id),
        slice.label(),
        processed_item_count,
        fragment_items.len(),
        loaded_item_count,
        fragments.len(),
        load_started.elapsed().as_secs_f64()
      );
      last_progress_log = Instant::now();
    }
  }

  fragments.sort_by(|a, b| a.item_id.cmp(&b.item_id).then(a.ordinal.cmp(&b.ordinal)));
  validate_unique_fragment_ordinals(&plan.user_id, &fragments)?;
  info!(
    "User {} loaded {} fragment text for index rebuild: {} item(s), {} fragment(s), total {:.3}s.",
    user_id_for_log(&plan.user_id),
    slice.label(),
    loaded_item_count,
    fragments.len(),
    load_started.elapsed().as_secs_f64()
  );
  Ok(fragments)
}

async fn rebuild_user_fragment_index(
  data_dir: &str,
  plan: &UserFragmentIndexPlan,
  client: Option<&reqwest::Client>,
  embed_url: Option<&Url>,
  policy: FragmentIndexRebuildPolicy,
) -> InfuResult<UserRebuildOutcome> {
  ensure_user_index_dir(data_dir, &plan.user_id).await?;

  info!(
    "User {} fragment lexical/semantic index manifest corpus: lexical_document={} semantic_image={} complete={}.",
    user_id_for_log(&plan.user_id),
    plan.summary.lexical_fragment_count,
    plan.summary.vector_fragment_count,
    plan.summary.manifest_complete
  );

  let lexical_outcome = match skip_current_lexical_index_from_manifest(data_dir, plan, policy).await? {
    Some(outcome) => outcome,
    None => {
      let lexical_fragments = load_fragment_records_for_index_plan(data_dir, plan, FragmentIndexSlice::Lexical).await?;
      let lexical_source_digest =
        plan.summary.lexical_source_digest.clone().unwrap_or_else(|| fragment_corpus_digest(&lexical_fragments));
      rebuild_user_fragment_lexical_index(
        data_dir,
        &plan.user_id,
        &lexical_fragments,
        &lexical_source_digest,
        policy.skip_current,
      )
      .await?
    }
  };

  let vector_outcome = match (client, embed_url) {
    (Some(client), Some(embed_url)) => {
      if let Some(outcome) = skip_current_vector_index_from_manifest(data_dir, plan, policy).await? {
        return Ok(user_rebuild_outcome_from_parts(lexical_outcome, outcome));
      }
      let vector_fragments = load_fragment_records_for_index_plan(data_dir, plan, FragmentIndexSlice::Vector).await?;
      let vector_source_digest =
        plan.summary.vector_source_digest.clone().unwrap_or_else(|| fragment_corpus_digest(&vector_fragments));
      rebuild_user_vector_fragment_index(
        data_dir,
        &plan.user_id,
        &vector_fragments,
        &vector_source_digest,
        client,
        embed_url,
        policy,
      )
      .await?
    }
    (None, None) => VectorRebuildOutcome { skipped_current: true, ..Default::default() },
    _ => {
      return Err("Text embedding client and URL must both be provided to rebuild image semantic indexes.".into());
    }
  };

  Ok(user_rebuild_outcome_from_parts(lexical_outcome, vector_outcome))
}

fn user_rebuild_outcome_from_parts(
  lexical_outcome: LexicalRebuildOutcome,
  vector_outcome: VectorRebuildOutcome,
) -> UserRebuildOutcome {
  UserRebuildOutcome {
    users_rebuilt: if vector_outcome.rebuilt || lexical_outcome.rebuilt { 1 } else { 0 },
    users_skipped_current: if vector_outcome.skipped_current && lexical_outcome.skipped_current { 1 } else { 0 },
    fragments_embedded: vector_outcome.fragments_embedded,
    fragments_reused: vector_outcome.fragments_reused,
    lexical_fragments_indexed: lexical_outcome.lexical_fragments_indexed,
    empty_index_files_removed: vector_outcome.empty_index_files_removed + lexical_outcome.empty_index_files_removed,
  }
}

async fn rebuild_user_vector_fragment_index(
  data_dir: &str,
  user_id: &str,
  fragments: &[FragmentRecordForIndex],
  source_digest: &str,
  client: &reqwest::Client,
  embed_url: &Url,
  policy: FragmentIndexRebuildPolicy,
) -> InfuResult<VectorRebuildOutcome> {
  let final_path = fragment_vector_db_path(data_dir, user_id)?;
  let temp_path = fragment_vector_db_temp_path(data_dir, user_id)?;

  if fragments.is_empty() {
    let removed = remove_stale_empty_index_files(&final_path, &temp_path).await?;
    if removed > 0 {
      info!(
        "User {} has no image-semantic fragments; removed {} stale image semantic index file(s).",
        user_id_for_log(user_id),
        removed
      );
    }
    return Ok(VectorRebuildOutcome {
      skipped_current: removed == 0,
      empty_index_files_removed: removed,
      ..Default::default()
    });
  }

  let final_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, final_path.clone());
  let final_rebuild_status = final_db.rebuild_status().await?;
  if policy.skip_current {
    if !path_exists(&temp_path).await
      && let Some(status) = final_rebuild_status.as_ref()
      && status.complete
      && status.source_digest == source_digest
      && status.expected_fragment_count == fragments.len()
    {
      info!(
        "User {} image semantic index is already current ({} fragment(s), model '{}', {} dims).",
        user_id_for_log(user_id),
        status.expected_fragment_count,
        status.model,
        status.embedding_dimensions
      );
      return Ok(VectorRebuildOutcome { skipped_current: true, ..Default::default() });
    }
  }

  let temp_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, temp_path.clone());
  let mut metadata =
    prepare_temp_rebuild(&*temp_db, &temp_path, user_id, source_digest, fragments.len(), policy.continue_rebuild)
      .await?;
  let mut existing_keys = if metadata.is_some() { temp_db.embedded_fragment_keys().await? } else { HashSet::new() };
  if let Some(final_status) = final_rebuild_status.as_ref()
    && final_status.complete
  {
    let reusable_candidate_keys = fragments
      .iter()
      .map(FragmentRecordForIndex::key)
      .filter(|key| !existing_keys.contains(key))
      .collect::<HashSet<_>>();
    let can_reuse_final_embeddings = match metadata.as_ref() {
      Some(metadata) => {
        metadata.model == final_status.model && metadata.embedding_dimensions == final_status.embedding_dimensions
      }
      None => true,
    };
    let reusable_fragments = if can_reuse_final_embeddings {
      let mut reusable_embeddings_by_key = final_db
        .embedded_fragments_for_keys(&reusable_candidate_keys)
        .await?
        .into_iter()
        .map(|fragment| {
          (
            FragmentVectorDbFragmentKey {
              item_id: fragment.item_id,
              ordinal: fragment.ordinal,
              text_sha256: fragment_text_sha256(&fragment.text),
            },
            fragment.embedding,
          )
        })
        .collect::<HashMap<_, _>>();
      fragments
        .iter()
        .filter_map(|fragment| {
          reusable_embeddings_by_key.remove(&fragment.key()).map(|embedding| EmbeddedFragment {
            item_id: fragment.item_id.clone(),
            ordinal: fragment.ordinal,
            source_kind: fragment.source_kind.clone(),
            text: fragment.text.clone(),
            page_start: fragment.page_start,
            page_end: fragment.page_end,
            embedding,
          })
        })
        .collect::<Vec<_>>()
    } else {
      Vec::new()
    };
    if !reusable_fragments.is_empty() {
      if metadata.is_none() {
        let initialized_metadata = FragmentVectorDbRebuildMetadata {
          source_digest: source_digest.to_owned(),
          expected_fragment_count: fragments.len(),
          model: final_status.model.clone(),
          embedding_dimensions: final_status.embedding_dimensions,
        };
        temp_db.begin_rebuild(&initialized_metadata, false).await?;
        metadata = Some(initialized_metadata);
      }
      temp_db.insert_embedded_fragments(&reusable_fragments).await?;
      existing_keys.extend(reusable_fragments.iter().map(|fragment| FragmentVectorDbFragmentKey {
        item_id: fragment.item_id.clone(),
        ordinal: fragment.ordinal,
        text_sha256: fragment_text_sha256(&fragment.text),
      }));
      debug!(
        "User {} reused {} unchanged image fragment embedding(s) from the current semantic index.",
        user_id_for_log(user_id),
        reusable_fragments.len()
      );
    }
  }
  let pending_fragments =
    fragments.iter().filter(|fragment| !existing_keys.contains(&fragment.key())).cloned().collect::<Vec<_>>();

  let mut embedded_count = 0;
  for batch in pending_fragments.chunks(DEFAULT_TEXT_EMBEDDING_BATCH_SIZE) {
    let inputs = batch
      .iter()
      .map(|fragment| {
        TextEmbeddingInput::retrieval_document(
          Some(format!("{}:{}", fragment.item_id, fragment.ordinal)),
          fragment.text.clone(),
        )
      })
      .collect::<Vec<_>>();
    let response = embed_texts(client, embed_url, &inputs).await?;

    if metadata.is_none() {
      let dimensions = validate_embedding_batch(&response, None, None)?;
      let initialized_metadata = FragmentVectorDbRebuildMetadata {
        source_digest: source_digest.to_owned(),
        expected_fragment_count: fragments.len(),
        model: response.model.clone(),
        embedding_dimensions: dimensions,
      };
      temp_db.begin_rebuild(&initialized_metadata, false).await?;
      metadata = Some(initialized_metadata);
    }

    let metadata_ref = metadata.as_ref().ok_or("Embedding metadata was not initialized.")?;
    validate_embedding_batch(&response, Some(&metadata_ref.model), Some(metadata_ref.embedding_dimensions))?;
    let embedded_fragments = batch
      .iter()
      .zip(response.embeddings)
      .map(|(fragment, embedding)| EmbeddedFragment {
        item_id: fragment.item_id.clone(),
        ordinal: fragment.ordinal,
        source_kind: fragment.source_kind.clone(),
        text: fragment.text.clone(),
        page_start: fragment.page_start,
        page_end: fragment.page_end,
        embedding,
      })
      .collect::<Vec<_>>();
    temp_db.insert_embedded_fragments(&embedded_fragments).await?;
    embedded_count += embedded_fragments.len();
    debug!(
      "User {} embedded {}/{} pending image fragment(s) for semantic index.",
      user_id_for_log(user_id),
      embedded_count,
      pending_fragments.len()
    );
  }

  let metadata = metadata.ok_or_else(|| {
    format!("User {} has {} image-semantic fragment(s), but no embeddings were produced.", user_id, fragments.len())
  })?;
  let finished = temp_db.finish_rebuild(&metadata).await?;
  fs::rename(&temp_path, &final_path).await.map_err(|e| {
    format!(
      "Could not atomically replace image semantic index DB '{}' with '{}': {}",
      final_path.display(),
      temp_path.display(),
      e
    )
  })?;

  let final_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, final_path);
  let final_status = final_db.rebuild_status().await?.ok_or("Final image semantic index DB is missing metadata.")?;
  if !final_status.complete
    || final_status.source_digest != source_digest
    || final_status.expected_fragment_count != fragments.len()
    || final_status.model != metadata.model
    || final_status.embedding_dimensions != metadata.embedding_dimensions
    || final_status.embedded_fragment_count != fragments.len()
    || final_status.embedding_row_count != fragments.len()
  {
    return Err(format!("Final image semantic index DB validation failed for user {}.", user_id).into());
  }

  info!(
    "User {} rebuilt image semantic index: {} fragment(s), model '{}', {} dims.",
    user_id_for_log(user_id),
    finished.expected_fragment_count,
    finished.model,
    finished.embedding_dimensions
  );

  Ok(VectorRebuildOutcome {
    rebuilt: true,
    fragments_embedded: embedded_count,
    fragments_reused: existing_keys.len(),
    ..Default::default()
  })
}

async fn rebuild_user_fragment_lexical_index(
  data_dir: &str,
  user_id: &str,
  fragments: &[FragmentRecordForIndex],
  source_digest: &str,
  skip_current: bool,
) -> InfuResult<LexicalRebuildOutcome> {
  if fragments.is_empty() {
    let removed = remove_document_fragment_lexical_index_dirs(data_dir, user_id).await?;
    if removed > 0 {
      info!(
        "User {} has no document-lexical fragments; removed {} stale document fragment lexical index dir(s).",
        user_id_for_log(user_id),
        removed
      );
    }
    return Ok(LexicalRebuildOutcome {
      skipped_current: removed == 0,
      empty_index_files_removed: removed,
      ..Default::default()
    });
  }

  let final_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
  if skip_current
    && let Some(status) = final_index.rebuild_status().await?
    && status.complete
    && status.source_digest == source_digest
    && status.expected_fragment_count == fragments.len()
    && status.indexed_fragment_count == fragments.len()
  {
    info!(
      "User {} document fragment lexical index is already current ({} fragment(s)).",
      user_id_for_log(user_id),
      fragments.len()
    );
    return Ok(LexicalRebuildOutcome { skipped_current: true, ..Default::default() });
  }

  info!(
    "User {} starting document fragment lexical index rebuild: {} fragment(s).",
    user_id_for_log(user_id),
    fragments.len()
  );
  let rebuild_started = Instant::now();
  let temp_dir = document_fragment_lexical_index_temp_dir(data_dir, user_id)?;
  let lexical_fragments = fragments
    .iter()
    .map(|fragment| LexicalFragment {
      item_id: fragment.item_id.clone(),
      ordinal: fragment.ordinal,
      source_kind: fragment.source_kind.clone(),
      text: fragment.text.clone(),
      page_start: fragment.page_start,
      page_end: fragment.page_end,
    })
    .collect::<Vec<_>>();
  let metadata = FragmentLexicalIndexRebuildMetadata {
    source_digest: source_digest.to_owned(),
    expected_fragment_count: fragments.len(),
  };
  let status = final_index.rebuild_from_fragments(&temp_dir, &metadata, &lexical_fragments).await?;
  if !status.complete
    || status.source_digest != source_digest
    || status.expected_fragment_count != fragments.len()
    || status.indexed_fragment_count != fragments.len()
  {
    return Err(format!("Final document fragment lexical index validation failed for user {}.", user_id).into());
  }

  info!(
    "User {} finished document fragment lexical index rebuild: {} fragment(s), rebuild {:.3}s.",
    user_id_for_log(user_id),
    status.indexed_fragment_count,
    rebuild_started.elapsed().as_secs_f64()
  );
  Ok(LexicalRebuildOutcome {
    rebuilt: true,
    lexical_fragments_indexed: status.indexed_fragment_count,
    ..Default::default()
  })
}

async fn prepare_temp_rebuild(
  temp_db: &dyn FragmentVectorDb,
  temp_path: &Path,
  user_id: &str,
  source_digest: &str,
  fragment_count: usize,
  continue_rebuild: bool,
) -> InfuResult<Option<FragmentVectorDbRebuildMetadata>> {
  if !continue_rebuild {
    remove_file_if_exists(temp_path).await?;
    return Ok(None);
  }

  let Some(status) = temp_db.rebuild_status().await? else {
    remove_file_if_exists(temp_path).await?;
    return Ok(None);
  };

  if status.source_digest != source_digest {
    return Err(
      format!(
        "Cannot continue image semantic index DB rebuild '{}' for user '{}': temp DB source digest differs from current image-semantic fragments. Run without --continue to start a fresh rebuild.",
        temp_path.display(),
        user_id
      )
      .into(),
    );
  }
  if status.expected_fragment_count != fragment_count {
    return Err(
      format!(
        "Cannot continue image semantic index DB rebuild '{}': temp DB expects {} image-semantic fragment(s), current fragments contain {}. Run without --continue to start a fresh rebuild.",
        temp_path.display(),
        status.expected_fragment_count,
        fragment_count
      )
      .into(),
    );
  }

  let metadata = FragmentVectorDbRebuildMetadata {
    source_digest: status.source_digest,
    expected_fragment_count: status.expected_fragment_count,
    model: status.model,
    embedding_dimensions: status.embedding_dimensions,
  };
  temp_db.begin_rebuild(&metadata, true).await?;
  Ok(Some(metadata))
}

fn validate_embedding_batch(
  response: &TextEmbeddingBatch,
  expected_model: Option<&str>,
  expected_dimensions: Option<usize>,
) -> InfuResult<usize> {
  if response.model.trim().is_empty() {
    return Err("Text embedding service returned an empty model name.".into());
  }
  if let Some(expected_model) = expected_model
    && response.model != expected_model
  {
    return Err(
      format!(
        "Text embedding service returned model '{}', but this rebuild is using model '{}'.",
        response.model, expected_model
      )
      .into(),
    );
  }

  let first = response.embeddings.first().ok_or("Text embedding service returned an empty embedding batch.")?;
  let dimensions = first.len();
  if dimensions == 0 {
    return Err("Text embedding service returned an embedding with zero dimensions.".into());
  }
  if let Some(expected_dimensions) = expected_dimensions
    && dimensions != expected_dimensions
  {
    return Err(
      format!(
        "Text embedding service returned {} dimensions, but this rebuild is using {} dimensions.",
        dimensions, expected_dimensions
      )
      .into(),
    );
  }
  for (index, embedding) in response.embeddings.iter().enumerate() {
    if embedding.len() != dimensions {
      return Err(
        format!(
          "Text embedding service returned inconsistent dimensions in one batch: result 0 has {}, result {} has {}.",
          dimensions,
          index,
          embedding.len()
        )
        .into(),
      );
    }
    validate_text_embedding_vector(&format!("Text embedding service returned embedding result {}", index), embedding)?;
  }

  Ok(dimensions)
}

fn validate_unique_fragment_ordinals(user_id: &str, fragments: &[FragmentRecordForIndex]) -> InfuResult<()> {
  let mut seen = HashSet::new();
  for fragment in fragments {
    if !seen.insert((fragment.item_id.as_str(), fragment.ordinal)) {
      return Err(
        format!(
          "User {} has duplicate fragment ordinal {} for item '{}'. Regenerate fragments before embedding.",
          user_id, fragment.ordinal, fragment.item_id
        )
        .into(),
      );
    }
  }
  Ok(())
}

async fn remove_stale_empty_index_files(final_path: &Path, temp_path: &Path) -> InfuResult<usize> {
  let mut removed = 0;
  if remove_file_if_exists(temp_path).await? {
    removed += 1;
  }
  if remove_file_if_exists(final_path).await? {
    removed += 1;
  }
  Ok(removed)
}

async fn remove_file_if_exists(path: &Path) -> InfuResult<bool> {
  match fs::remove_file(path).await {
    Ok(()) => Ok(true),
    Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("Could not remove '{}': {}", path.display(), e).into()),
  }
}

async fn load_fragment_records(path: &Path) -> InfuResult<Vec<StoredFragmentRecord>> {
  let contents =
    fs::read_to_string(path).await.map_err(|e| format!("Could not read fragments file '{}': {}", path.display(), e))?;
  parse_fragment_records(&contents)
}

fn parse_fragment_records(contents: &str) -> InfuResult<Vec<StoredFragmentRecord>> {
  let mut out = Vec::new();

  for (line_number, line) in contents.lines().enumerate() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let record: StoredFragmentRecord = serde_json::from_str(trimmed)
      .map_err(|e| format!("Could not parse fragment record on line {} of fragments.jsonl: {}", line_number + 1, e))?;
    if !record.text.trim().is_empty() {
      out.push(record);
    }
  }

  Ok(out)
}

async fn load_fragments_manifest(path: &Path) -> InfuResult<Option<StoredFragmentsManifest>> {
  match fs::read_to_string(path).await {
    Ok(contents) => serde_json::from_str(&contents)
      .map(Some)
      .map_err(|e| format!("Could not parse fragments manifest '{}': {}", path.display(), e).into()),
    Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Could not read fragments manifest '{}': {}", path.display(), e).into()),
  }
}

fn fragment_text_sha256(text: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  format!("{:x}", hasher.finalize())
}

fn fragment_corpus_digest(fragments: &[FragmentRecordForIndex]) -> String {
  let mut hasher = Sha256::new();
  for fragment in fragments {
    hasher.update(fragment.item_id.as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.ordinal.to_string().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.source_kind.as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.page_start.map(|v| v.to_string()).unwrap_or_default().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.page_end.map(|v| v.to_string()).unwrap_or_default().as_bytes());
    hasher.update([0_u8]);
    hasher.update(fragment.text_sha256.as_bytes());
    hasher.update([0xff_u8]);
  }
  format!("{:x}", hasher.finalize())
}

fn manifest_fragment_corpus_digest<'a>(items: impl Iterator<Item = &'a FragmentItemForIndex>) -> String {
  let mut hasher = Sha256::new();
  hasher.update(b"infumap-fragment-manifest-corpus-v1");
  for item in items {
    hasher.update(item.item_id.as_bytes());
    hasher.update([0_u8]);
    hasher.update(item.source_kind.as_bytes());
    hasher.update([0_u8]);
    hasher.update(item.fragment_count.unwrap_or(0).to_string().as_bytes());
    hasher.update([0_u8]);
    hasher.update(item.source_text_sha256.as_deref().unwrap_or_default().as_bytes());
    hasher.update([0xff_u8]);
  }
  format!("{:x}", hasher.finalize())
}

async fn write_search_status_for_plan(
  data_dir: &str,
  plan: &UserFragmentIndexPlan,
  semantic_enabled: bool,
) -> InfuResult<SearchStatusWriteOutcome> {
  let indexed_item_ids = indexed_search_item_ids(plan, semantic_enabled);
  let mut failed_item_ids = Vec::new();
  let mut pending_item_ids = Vec::new();

  for item in &plan.loaded_items {
    let Some(kind) = search_status_candidate_kind(item, semantic_enabled) else {
      continue;
    };
    if indexed_item_ids.contains(&item.item_id) {
      continue;
    }

    match classify_unindexed_search_item(data_dir, item, kind).await? {
      SearchStatusClassification::Failed => failed_item_ids.push(item.item_id.clone()),
      SearchStatusClassification::Pending => pending_item_ids.push(item.item_id.clone()),
      SearchStatusClassification::Blocked => {}
    }
  }

  let artifact = SearchStatusArtifact::new(failed_item_ids, pending_item_ids)?;
  let outcome = SearchStatusWriteOutcome {
    artifacts_written: 1,
    failed_items: artifact.failed_item_ids.len(),
    pending_items: artifact.pending_item_ids.len(),
  };
  write_search_status_artifact(data_dir, &plan.user_id, &artifact).await?;
  debug!(
    "User {} wrote search status artifact: failed={} pending={}.",
    user_id_for_log(&plan.user_id),
    outcome.failed_items,
    outcome.pending_items
  );
  Ok(outcome)
}

fn indexed_search_item_ids(plan: &UserFragmentIndexPlan, semantic_enabled: bool) -> HashSet<Uid> {
  plan
    .fragment_items
    .iter()
    .filter(|item| item.has_complete_manifest())
    .filter(|item| item.fragment_count.unwrap_or(0) > 0)
    .filter(|item| is_lexical_search_source_kind(&item.source_kind) || semantic_enabled)
    .map(|item| item.item_id.clone())
    .collect()
}

fn search_status_candidate_kind(
  item: &LoadedFragmentIndexItem,
  semantic_enabled: bool,
) -> Option<SearchStatusCandidateKind> {
  match item.mime_type.as_deref()? {
    PDF_SOURCE_MIME_TYPE => Some(SearchStatusCandidateKind::Pdf),
    MARKDOWN_SOURCE_MIME_TYPE => Some(SearchStatusCandidateKind::Markdown),
    TEXT_SOURCE_MIME_TYPE => Some(SearchStatusCandidateKind::Text),
    mime_type if semantic_enabled && is_supported_image_tagging_mime_type(Some(mime_type)) => {
      Some(SearchStatusCandidateKind::Image)
    }
    _ => None,
  }
}

async fn classify_unindexed_search_item(
  data_dir: &str,
  item: &LoadedFragmentIndexItem,
  kind: SearchStatusCandidateKind,
) -> InfuResult<SearchStatusClassification> {
  Ok(match kind {
    SearchStatusCandidateKind::Pdf => match pdf_text_artifact_state(data_dir, &item.user_id, &item.item_id).await? {
      PdfTextArtifactState::Failed => SearchStatusClassification::Failed,
      PdfTextArtifactState::Blocked => SearchStatusClassification::Blocked,
      PdfTextArtifactState::Succeeded | PdfTextArtifactState::Pending => SearchStatusClassification::Pending,
    },
    SearchStatusCandidateKind::Image => {
      match image_tagging_artifact_state(data_dir, &item.user_id, &item.item_id).await? {
        ImageTagArtifactState::Failed | ImageTagArtifactState::UnsupportedSchemaVersion { .. } => {
          SearchStatusClassification::Failed
        }
        ImageTagArtifactState::Empty | ImageTagArtifactState::Succeeded | ImageTagArtifactState::Incomplete(_) => {
          SearchStatusClassification::Pending
        }
      }
    }
    SearchStatusCandidateKind::Markdown | SearchStatusCandidateKind::Text => SearchStatusClassification::Pending,
  })
}

#[derive(Clone, Copy)]
enum SearchStatusCandidateKind {
  Pdf,
  Image,
  Markdown,
  Text,
}

#[derive(Clone, Copy)]
enum SearchStatusClassification {
  Failed,
  Pending,
  Blocked,
}

#[derive(Default)]
pub struct EmbedRebuildSummary {
  pub users_seen: usize,
  pub users_rebuilt: usize,
  pub users_skipped_current: usize,
  pub fragments_embedded: usize,
  pub fragments_reused: usize,
  pub lexical_fragments_indexed: usize,
  pub empty_index_files_removed: usize,
  pub search_status_artifacts_written: usize,
  pub search_status_failed_items: usize,
  pub search_status_pending_items: usize,
}

impl EmbedRebuildSummary {
  fn record(&mut self, outcome: &UserRebuildOutcome) {
    self.users_rebuilt += outcome.users_rebuilt;
    self.users_skipped_current += outcome.users_skipped_current;
    self.fragments_embedded += outcome.fragments_embedded;
    self.fragments_reused += outcome.fragments_reused;
    self.lexical_fragments_indexed += outcome.lexical_fragments_indexed;
    self.empty_index_files_removed += outcome.empty_index_files_removed;
  }

  fn record_search_status(&mut self, outcome: &SearchStatusWriteOutcome) {
    self.search_status_artifacts_written += outcome.artifacts_written;
    self.search_status_failed_items += outcome.failed_items;
    self.search_status_pending_items += outcome.pending_items;
  }
}

#[derive(Default)]
struct UserRebuildOutcome {
  users_rebuilt: usize,
  users_skipped_current: usize,
  fragments_embedded: usize,
  fragments_reused: usize,
  lexical_fragments_indexed: usize,
  empty_index_files_removed: usize,
}

#[derive(Default)]
struct SearchStatusWriteOutcome {
  artifacts_written: usize,
  failed_items: usize,
  pending_items: usize,
}

struct UserFragmentIndexPlan {
  user_id: String,
  loaded_items: Vec<LoadedFragmentIndexItem>,
  fragment_items: Vec<FragmentItemForIndex>,
  summary: FragmentCorpusSummary,
}

struct FragmentItemForIndex {
  item_id: String,
  source_kind: String,
  source_text_sha256: Option<String>,
  fragment_count: Option<usize>,
}

impl FragmentItemForIndex {
  fn from_manifest(item_id: String, manifest: Option<StoredFragmentsManifest>) -> FragmentItemForIndex {
    let Some(manifest) = manifest else {
      return FragmentItemForIndex {
        item_id,
        source_kind: UNKNOWN_FRAGMENT_SOURCE_KIND.to_owned(),
        source_text_sha256: None,
        fragment_count: None,
      };
    };

    let source_kind = manifest
      .source_kind
      .map(|source_kind| source_kind.trim().to_owned())
      .filter(|source_kind| !source_kind.is_empty())
      .unwrap_or_else(|| UNKNOWN_FRAGMENT_SOURCE_KIND.to_owned());
    let source_text_sha256 = manifest
      .source_text_sha256
      .map(|source_text_sha256| source_text_sha256.trim().to_owned())
      .filter(|source_text_sha256| !source_text_sha256.is_empty());
    let fragment_count = manifest.fragment_count.filter(|count| *count > 0);

    FragmentItemForIndex { item_id, source_kind, source_text_sha256, fragment_count }
  }

  fn has_complete_manifest(&self) -> bool {
    self.source_kind != UNKNOWN_FRAGMENT_SOURCE_KIND
      && self.source_text_sha256.is_some()
      && self.fragment_count.is_some()
  }
}

#[derive(Default)]
struct FragmentCorpusSummary {
  manifest_complete: bool,
  lexical_fragment_count: usize,
  vector_fragment_count: usize,
  lexical_source_digest: Option<String>,
  vector_source_digest: Option<String>,
}

impl FragmentCorpusSummary {
  fn from_items(items: &[FragmentItemForIndex]) -> FragmentCorpusSummary {
    let manifest_complete = items.iter().all(FragmentItemForIndex::has_complete_manifest);
    let lexical_fragment_count = items
      .iter()
      .filter(|item| is_lexical_search_source_kind(&item.source_kind))
      .map(|item| item.fragment_count.unwrap_or(0))
      .sum();
    let vector_fragment_count = items
      .iter()
      .filter(|item| !is_lexical_search_source_kind(&item.source_kind))
      .map(|item| item.fragment_count.unwrap_or(0))
      .sum();
    let lexical_source_digest = if manifest_complete {
      Some(manifest_fragment_corpus_digest(
        items.iter().filter(|item| is_lexical_search_source_kind(&item.source_kind)),
      ))
    } else {
      None
    };
    let vector_source_digest = if manifest_complete {
      Some(manifest_fragment_corpus_digest(
        items.iter().filter(|item| !is_lexical_search_source_kind(&item.source_kind)),
      ))
    } else {
      None
    };

    FragmentCorpusSummary {
      manifest_complete,
      lexical_fragment_count,
      vector_fragment_count,
      lexical_source_digest,
      vector_source_digest,
    }
  }
}

struct ManifestCurrentStatus {
  reason: &'static str,
  model: Option<String>,
  dimensions: Option<usize>,
}

impl ManifestCurrentStatus {
  fn empty() -> ManifestCurrentStatus {
    ManifestCurrentStatus { reason: "empty corpus", model: None, dimensions: None }
  }

  fn from_digest_match(digest_matches: bool) -> ManifestCurrentStatus {
    ManifestCurrentStatus {
      reason: if digest_matches { "manifest digest match" } else { "immutable count match" },
      model: None,
      dimensions: None,
    }
  }
}

#[derive(Clone, Copy)]
enum FragmentIndexSlice {
  Lexical,
  Vector,
}

impl FragmentIndexSlice {
  fn includes_source_kind(&self, source_kind: &str) -> bool {
    match self {
      FragmentIndexSlice::Lexical => is_lexical_search_source_kind(source_kind),
      FragmentIndexSlice::Vector => !is_lexical_search_source_kind(source_kind),
    }
  }

  fn label(&self) -> &'static str {
    match self {
      FragmentIndexSlice::Lexical => "document-lexical",
      FragmentIndexSlice::Vector => "image-semantic",
    }
  }
}

#[derive(Default)]
struct VectorRebuildOutcome {
  rebuilt: bool,
  skipped_current: bool,
  fragments_embedded: usize,
  fragments_reused: usize,
  empty_index_files_removed: usize,
}

#[derive(Default)]
struct LexicalRebuildOutcome {
  rebuilt: bool,
  skipped_current: bool,
  lexical_fragments_indexed: usize,
  empty_index_files_removed: usize,
}

#[derive(Clone)]
struct FragmentRecordForIndex {
  item_id: String,
  ordinal: usize,
  source_kind: String,
  text_sha256: String,
  text: String,
  page_start: Option<usize>,
  page_end: Option<usize>,
}

impl FragmentRecordForIndex {
  fn key(&self) -> FragmentVectorDbFragmentKey {
    FragmentVectorDbFragmentKey {
      item_id: self.item_id.clone(),
      ordinal: self.ordinal,
      text_sha256: self.text_sha256.clone(),
    }
  }
}

#[derive(Deserialize)]
struct StoredFragmentRecord {
  ordinal: usize,
  text: String,
  page_start: Option<usize>,
  page_end: Option<usize>,
}

#[derive(Deserialize)]
struct StoredFragmentsManifest {
  source_kind: Option<String>,
  source_text_sha256: Option<String>,
  fragment_count: Option<usize>,
}
