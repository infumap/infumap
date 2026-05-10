use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::Path;

use infusdk::util::infu::InfuResult;
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::fs;

use crate::ai::artifact_paths::{item_fragments_manifest_path, item_fragments_path};
use crate::ai::fragment::is_lexical_search_source_kind;
use crate::ai::fragment::sources::{ItemTitleFragment, item_title_fragment_for_item};
use crate::ai::lexical_index::{
  FragmentLexicalIndexRebuildMetadata, LexicalFragment, document_fragment_lexical_index_temp_dir,
  open_user_document_fragment_lexical_index, remove_document_fragment_lexical_index_dirs,
  user_document_fragment_lexical_index_exists,
};
use crate::ai::text_embedding::{
  DEFAULT_TEXT_EMBEDDING_BATCH_SIZE, TextEmbeddingBatch, TextEmbeddingInput, embed_texts,
  validate_text_embedding_vector,
};
use crate::ai::vector_db::{
  EmbeddedFragment, FragmentVectorDb, FragmentVectorDbBackend, FragmentVectorDbFragmentKey,
  FragmentVectorDbRebuildMetadata, ensure_user_index_dir, fragment_vector_db_path, fragment_vector_db_temp_path,
  open_fragment_vector_db, open_user_fragment_vector_db, user_fragment_vector_db_exists,
};
use crate::storage::db::Db;
use crate::util::fs::path_exists;

const UNKNOWN_FRAGMENT_SOURCE_KIND: &str = "unknown";

pub async fn rebuild_all_fragment_indexes(
  data_dir: &str,
  client: &reqwest::Client,
  embed_url: &Url,
  continue_rebuild: bool,
) -> InfuResult<EmbedRebuildSummary> {
  let plans = load_fragment_index_plans(data_dir).await?;
  let mut summary = EmbedRebuildSummary { users_seen: plans.len(), ..Default::default() };

  for plan in plans {
    let outcome = rebuild_user_fragment_index(data_dir, &plan, client, embed_url, continue_rebuild).await?;
    summary.record(&outcome);
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
  for user_id in &user_ids {
    db.item.load_user_items(user_id, false).await?;
  }

  let mut item_ids_by_user_id =
    user_ids.iter().map(|user_id| (user_id.clone(), Vec::new())).collect::<BTreeMap<String, Vec<String>>>();
  for item_key in db.item.all_loaded_items() {
    if let Some(item_ids) = item_ids_by_user_id.get_mut(&item_key.user_id) {
      item_ids.push(item_key.item_id);
    }
  }

  let mut plans = Vec::new();
  for (user_id, mut item_ids) in item_ids_by_user_id {
    item_ids.sort();
    let mut fragments = Vec::new();
    for item_id in item_ids {
      let item = db.item.get(&item_id).map_err(|e| e.to_string())?;
      if let Some(fragment) = item_title_fragment_for_item(&db, item)? {
        fragments.push(fragment.into());
      }

      let fragments_path = item_fragments_path(data_dir, &user_id, &item_id)?;
      if !path_exists(&fragments_path).await {
        continue;
      }

      let records = load_fragment_records(&fragments_path).await?;
      if records.is_empty() {
        continue;
      }

      let manifest_path = item_fragments_manifest_path(data_dir, &user_id, &item_id)?;
      let manifest = load_fragments_manifest(&manifest_path).await?;
      if let Some(expected_count) = manifest.as_ref().and_then(|manifest| manifest.fragment_count)
        && expected_count != records.len()
      {
        return Err(
          format!(
            "Fragment manifest '{}' says {} fragment(s), but '{}' contains {} non-empty fragment record(s).",
            manifest_path.display(),
            expected_count,
            fragments_path.display(),
            records.len()
          )
          .into(),
        );
      }
      let source_kind = manifest
        .and_then(|manifest| manifest.source_kind)
        .map(|source_kind| source_kind.trim().to_owned())
        .filter(|source_kind| !source_kind.is_empty())
        .unwrap_or_else(|| UNKNOWN_FRAGMENT_SOURCE_KIND.to_owned());

      for record in records {
        fragments.push(FragmentRecordForIndex {
          item_id: item_id.clone(),
          ordinal: record.ordinal,
          source_kind: source_kind.clone(),
          text_sha256: fragment_text_sha256(&record.text),
          text: record.text,
          page_start: record.page_start,
          page_end: record.page_end,
        });
      }
    }

    fragments.sort_by(|a, b| a.item_id.cmp(&b.item_id).then(a.ordinal.cmp(&b.ordinal)));
    validate_unique_fragment_ordinals(&user_id, &fragments)?;
    plans.push(UserFragmentIndexPlan { user_id, fragments });
  }

  Ok(plans)
}

async fn rebuild_user_fragment_index(
  data_dir: &str,
  plan: &UserFragmentIndexPlan,
  client: &reqwest::Client,
  embed_url: &Url,
  continue_rebuild: bool,
) -> InfuResult<UserRebuildOutcome> {
  ensure_user_index_dir(data_dir, &plan.user_id).await?;

  let (vector_fragments, lexical_fragments) = split_fragment_records_by_index(&plan.fragments);

  let vector_source_digest = fragment_corpus_digest(&vector_fragments);
  let lexical_source_digest = fragment_corpus_digest(&lexical_fragments);

  let vector_outcome = rebuild_user_vector_fragment_index(
    data_dir,
    &plan.user_id,
    &vector_fragments,
    &vector_source_digest,
    client,
    embed_url,
    continue_rebuild,
  )
  .await?;
  let lexical_outcome = rebuild_user_fragment_lexical_index(
    data_dir,
    &plan.user_id,
    &lexical_fragments,
    &lexical_source_digest,
    continue_rebuild,
  )
  .await?;

  Ok(UserRebuildOutcome {
    users_rebuilt: if vector_outcome.rebuilt || lexical_outcome.rebuilt { 1 } else { 0 },
    users_skipped_current: if vector_outcome.skipped_current && lexical_outcome.skipped_current { 1 } else { 0 },
    fragments_embedded: vector_outcome.fragments_embedded,
    fragments_reused: vector_outcome.fragments_reused,
    lexical_fragments_indexed: lexical_outcome.lexical_fragments_indexed,
    empty_index_files_removed: vector_outcome.empty_index_files_removed + lexical_outcome.empty_index_files_removed,
  })
}

fn split_fragment_records_by_index(
  fragments: &[FragmentRecordForIndex],
) -> (Vec<FragmentRecordForIndex>, Vec<FragmentRecordForIndex>) {
  let vector_fragments =
    fragments.iter().filter(|fragment| !fragment.is_lexical_search_fragment()).cloned().collect::<Vec<_>>();
  let lexical_fragments =
    fragments.iter().filter(|fragment| fragment.is_lexical_search_fragment()).cloned().collect::<Vec<_>>();
  (vector_fragments, lexical_fragments)
}

async fn rebuild_user_vector_fragment_index(
  data_dir: &str,
  user_id: &str,
  fragments: &[FragmentRecordForIndex],
  source_digest: &str,
  client: &reqwest::Client,
  embed_url: &Url,
  continue_rebuild: bool,
) -> InfuResult<VectorRebuildOutcome> {
  let final_path = fragment_vector_db_path(data_dir, user_id)?;
  let temp_path = fragment_vector_db_temp_path(data_dir, user_id)?;

  if fragments.is_empty() {
    let removed = remove_stale_empty_index_files(&final_path, &temp_path).await?;
    if removed > 0 {
      eprintln!("User {} has no vector-search fragments; removed {} stale vector index file(s).", user_id, removed);
    }
    return Ok(VectorRebuildOutcome {
      skipped_current: removed == 0,
      empty_index_files_removed: removed,
      ..Default::default()
    });
  }

  if continue_rebuild {
    let final_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, final_path.clone());
    if !path_exists(&temp_path).await
      && let Some(status) = final_db.rebuild_status().await?
      && status.complete
      && status.source_digest == source_digest
      && status.expected_fragment_count == fragments.len()
    {
      eprintln!(
        "User {} fragment index is already current ({} fragment(s), model '{}', {} dims).",
        user_id, status.expected_fragment_count, status.model, status.embedding_dimensions
      );
      return Ok(VectorRebuildOutcome { skipped_current: true, ..Default::default() });
    }
  }

  let temp_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, temp_path.clone());
  let mut metadata =
    prepare_temp_rebuild(&*temp_db, &temp_path, user_id, source_digest, fragments.len(), continue_rebuild).await?;
  let existing_keys = if metadata.is_some() { temp_db.embedded_fragment_keys().await? } else { HashSet::new() };
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
    eprintln!("User {} embedded {}/{} pending fragment(s).", user_id, embedded_count, pending_fragments.len());
  }

  let metadata = metadata.ok_or_else(|| {
    format!("User {} has {} vector-search fragment(s), but no embeddings were produced.", user_id, fragments.len())
  })?;
  let finished = temp_db.finish_rebuild(&metadata).await?;
  fs::rename(&temp_path, &final_path).await.map_err(|e| {
    format!(
      "Could not atomically replace fragment vector DB '{}' with '{}': {}",
      final_path.display(),
      temp_path.display(),
      e
    )
  })?;

  let final_db = open_fragment_vector_db(FragmentVectorDbBackend::SqliteVec, final_path);
  let final_status = final_db.rebuild_status().await?.ok_or("Final fragment vector DB is missing metadata.")?;
  if !final_status.complete
    || final_status.source_digest != source_digest
    || final_status.expected_fragment_count != fragments.len()
    || final_status.model != metadata.model
    || final_status.embedding_dimensions != metadata.embedding_dimensions
    || final_status.embedded_fragment_count != fragments.len()
    || final_status.embedding_row_count != fragments.len()
  {
    return Err(format!("Final fragment vector DB validation failed for user {}.", user_id).into());
  }

  eprintln!(
    "User {} rebuilt fragment index: {} fragment(s), model '{}', {} dims.",
    user_id, finished.expected_fragment_count, finished.model, finished.embedding_dimensions
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
  continue_rebuild: bool,
) -> InfuResult<LexicalRebuildOutcome> {
  if fragments.is_empty() {
    let removed = remove_document_fragment_lexical_index_dirs(data_dir, user_id).await?;
    if removed > 0 {
      eprintln!("User {} has no lexical-search fragments; removed {} stale lexical index dir(s).", user_id, removed);
    }
    return Ok(LexicalRebuildOutcome {
      skipped_current: removed == 0,
      empty_index_files_removed: removed,
      ..Default::default()
    });
  }

  let final_index = open_user_document_fragment_lexical_index(data_dir, user_id)?;
  if continue_rebuild
    && let Some(status) = final_index.rebuild_status().await?
    && status.complete
    && status.source_digest == source_digest
    && status.expected_fragment_count == fragments.len()
    && status.indexed_fragment_count == fragments.len()
  {
    eprintln!("User {} fragment lexical index is already current ({} fragment(s)).", user_id, fragments.len());
    return Ok(LexicalRebuildOutcome { skipped_current: true, ..Default::default() });
  }

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
    return Err(format!("Final fragment lexical index validation failed for user {}.", user_id).into());
  }

  eprintln!("User {} rebuilt fragment lexical index: {} fragment(s).", user_id, status.indexed_fragment_count);
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
        "Cannot continue fragment vector DB rebuild '{}' for user '{}': temp DB source digest differs from current vector-search fragments. Run without --continue to start a fresh rebuild.",
        temp_path.display(),
        user_id
      )
      .into(),
    );
  }
  if status.expected_fragment_count != fragment_count {
    return Err(
      format!(
        "Cannot continue fragment vector DB rebuild '{}': temp DB expects {} vector-search fragment(s), current fragments contain {}. Run without --continue to start a fresh rebuild.",
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

#[derive(Default)]
pub struct EmbedRebuildSummary {
  pub users_seen: usize,
  pub users_rebuilt: usize,
  pub users_skipped_current: usize,
  pub fragments_embedded: usize,
  pub fragments_reused: usize,
  pub lexical_fragments_indexed: usize,
  pub empty_index_files_removed: usize,
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

struct UserFragmentIndexPlan {
  user_id: String,
  fragments: Vec<FragmentRecordForIndex>,
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

impl From<ItemTitleFragment> for FragmentRecordForIndex {
  fn from(fragment: ItemTitleFragment) -> FragmentRecordForIndex {
    let text_sha256 = fragment_text_sha256(&fragment.text);
    FragmentRecordForIndex {
      item_id: fragment.item_id,
      ordinal: fragment.ordinal,
      source_kind: fragment.source_kind.to_owned(),
      text_sha256,
      text: fragment.text,
      page_start: None,
      page_end: None,
    }
  }
}

impl FragmentRecordForIndex {
  fn key(&self) -> FragmentVectorDbFragmentKey {
    FragmentVectorDbFragmentKey {
      item_id: self.item_id.clone(),
      ordinal: self.ordinal,
      text_sha256: self.text_sha256.clone(),
    }
  }

  fn is_lexical_search_fragment(&self) -> bool {
    is_lexical_search_source_kind(&self.source_kind)
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
  fragment_count: Option<usize>,
}
